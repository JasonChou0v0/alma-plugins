/**
 * 桥接核心：钉钉消息 → Alma agent → 钉钉回复
 */
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { PluginContext } from 'alma-plugin-api';

import { AlmaApi } from './alma-api';
import { AlmaSocket } from './alma-socket';
import { DingTalkClient } from './dingtalk-client';
import type {
    BridgeConfig,
    DingTalkRobotMessage,
    SessionMode,
    SessionRecord,
    TurnState,
} from './types';

export interface BridgeDeps {
    context: PluginContext;
    config: () => BridgeConfig;
    getBuiltinThreadId?: () => string | undefined;
}

/** 回合结束后推送的最终文本等 */
const STORAGE_KEY = 'dingtalkSessions';
const STORAGE_VER = 2;
const OVERRIDES_KEY = 'dingtalkWorkspaceOverrides';
const FLUSH_INTERVAL_MS = 1200;
const COMMAND_PREFIX = '/';

export interface BridgeStatus {
    running: boolean;
    socketConnected: boolean;
    startedAt: number | null;
    lastMessageAt: number | null;
    sessionCount: number;
    lastError: string | null;
}

export class DingTalkBridge {
    private readonly ctx: PluginContext;
    private readonly cfg: () => BridgeConfig;

    private sessions: Record<string, SessionRecord> = {};
    /** 每个会话的工作区覆盖（/use 设置），独立于插件配置，无需 settings:write */
    private workspaceOverrides: Record<string, string> = {};
    private queue: Promise<void> = Promise.resolve();
    private completedTurns = 0;

    private dwClient: DWClient | null = null;
    private running = false;
    /** 机器人自己的钉钉昵称，用于从 @ 列表里排除自己 */
    private botName: string | undefined;
    /** 机器人自己的 dingtalkId（从 chatbotUserId 学到） */
    private botDingTalkId: string | undefined;
    private startedAt: number | null = null;
    private lastMessageAt: number | null = null;
    private lastError: string | null = null;

    private readonly api: AlmaApi;
    private readonly dingtalk: DingTalkClient;
    private readonly socket: AlmaSocket;

    /* 去重缓冲：钉钉会在 60s 内重推未 ACK 的消息 */
    private readonly seenMsgIds = new Map<string, number>();
    /** 正在排队等待处理的线程，防止同一线程堆积 */
    private readonly queuedThreads = new Set<string>();

    constructor(private readonly deps: BridgeDeps) {
        this.ctx = deps.context;
        this.cfg = deps.config;

        this.api = new AlmaApi(
            () => `http://127.0.0.1:${this.cfg().almaApiPort}`,
            this.ctx.logger,
        );

        this.dingtalk = new DingTalkClient(
            () => {
                const c = this.cfg();
                return { clientId: c.clientId, clientSecret: c.clientSecret, robotCode: c.robotCode || c.clientId };
            },
            this.ctx.logger,
        );

        this.socket = new AlmaSocket(
            () => `ws://127.0.0.1:${this.cfg().almaApiPort}/ws/threads`,
            this.ctx.logger,
            {
                onTextDelta: (turn, _text) => {
                    if (this.cfg().streamingReply) this.scheduleFlush(turn);
                },
                onToolAnnounce: (turn, toolName) => {
                    turn.lastActivity = Date.now();
                    /*
                     * 整轮只提示一次。
                     * agent 一轮里可能调十几次工具，逐个提示会刷屏。
                     */
                    if (!this.cfg().replyOnToolUse) return;
                    if (turn.toolNoticeSent) return;
                    turn.toolNoticeSent = true;
                    void this.dingtalk.replyWebhook(turn.webhook, '⏳ 正在处理…');
                },
                onToolOutput: (turn, stdout) => {
                    turn.lastActivity = Date.now();
                    turn.lastToolOutput = stdout.slice(-2000);
                },
                onComplete: (turn, data) => {
                    turn.finished = true;
                    turn.assistantMessageId = data?.assistantMessageId;
                    void this.finalizeTurn(turn);
                },
                onError: (turn, message) => {
                    turn.finished = true;
                    this.cancelFlush(turn);
                    this.socket.release(turn.threadId);
                    void this.reply(turn, `❌ 生成失败：${message}`);
                },
            },
        );
    }

    /* ============================================================ */
    /* 生命周期                                                      */
    /* ============================================================ */

    getStatus(): BridgeStatus {
        return {
            running: this.running,
            socketConnected: this.socket.isOpen(),
            startedAt: this.startedAt,
            lastMessageAt: this.lastMessageAt,
            sessionCount: Object.keys(this.sessions).length,
            lastError: this.lastError,
        };
    }

    async start(): Promise<void> {
        const config = this.cfg();

        if (!config.clientId || !config.clientSecret) {
            this.lastError = '未配置 clientId / clientSecret';
            this.ctx.logger.warn('钉钉凭据未配置，桥接不会启动。请在插件设置里填写 AppKey / AppSecret。');
            return;
        }

        await this.loadSessions();
        await this.loadWorkspaceOverrides();
        void this.socket.connect();

        this.dwClient = new DWClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            debug: false,
            keepAlive: true,
        });

        /*
         * 关键：机器人消息走的是 CALLBACK 通道，不是 EVENT。
         * SDK 内部 onCallback() 会 emit(topic)，而 registerAllEventListener 只挂到
         * EVENT 分支，用它注册的话机器人消息永远收不到。
         * 必须用 registerCallbackListener 订阅 TOPIC_ROBOT。
         */
        this.dwClient.registerCallbackListener(TOPIC_ROBOT, (msg: any) => {
            /* 立刻 ACK，避免钉钉 60 秒重推 */
            if (msg?.headers?.messageId) {
                try {
                    this.dwClient?.socketCallBackResponse(msg.headers.messageId, { status: 'SUCCESS' });
                } catch (e) {
                    this.ctx.logger.warn('ACK 发送失败', e);
                }
            }
            this.ctx.logger.info('收到钉钉消息', msg?.headers?.messageId ?? '?');
            this.dispatchDownstream(msg).catch((e) => this.ctx.logger.error('入站处理异常', e));
        });

        try {
            await this.dwClient.connect();
            this.running = true;
            this.startedAt = Date.now();
            this.lastError = null;
            this.ctx.logger.info('钉钉 Stream 已连接');
        } catch (e) {
            this.running = false;
            this.lastError = e instanceof Error ? e.message : String(e);
            this.ctx.logger.error('钉钉 Stream 连接失败', e);
            throw e;
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        try {
            this.dwClient?.disconnect();
        } catch (e) {
            this.ctx.logger.warn('断开钉钉连接异常', e);
        }
        this.dwClient = null;
        this.socket.close();
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /* ============================================================ */
    /* 配置与持久化                                                  */
    /* ============================================================ */

    private async loadSessions(): Promise<void> {
        try {
            const data = await this.ctx.storage.local.get<any>(STORAGE_KEY, null);
            if (data && data.version === STORAGE_VER && data.sessions) {
                this.sessions = data.sessions;
                this.ctx.logger.info(`已载入 ${Object.keys(this.sessions).length} 条会话映射`);
            } else if (data?.sessions) {
                /* 旧版本迁移：字段兼容就直接用 */
                this.sessions = data.sessions;
                await this.saveSessions();
            }
        } catch (e) {
            this.ctx.logger.warn('读取会话映射失败', e);
        }
    }

    private async loadWorkspaceOverrides(): Promise<void> {
        try {
            const data = await this.ctx.storage.local.get<Record<string, string>>(OVERRIDES_KEY, {});
            if (data && typeof data === 'object') this.workspaceOverrides = data;
        } catch (e) {
            this.ctx.logger.warn('读取工作区覆盖失败', e);
        }
    }

    private async clearWorkspaceOverride(key: string): Promise<void> {
        delete this.workspaceOverrides[key];
        await this.saveWorkspaceOverrides();
    }

    private async saveWorkspaceOverrides(): Promise<void> {
        try {
            await this.ctx.storage.local.set(OVERRIDES_KEY, this.workspaceOverrides);
        } catch (e) {
            this.ctx.logger.warn('保存工作区覆盖失败', e);
        }
    }

    private async saveSessions(): Promise<void> {
        try {
            await this.ctx.storage.local.set(STORAGE_KEY, { version: STORAGE_VER, sessions: this.sessions });
        } catch (e) {
            this.ctx.logger.warn('保存会话映射失败', e);
        }
    }

    clearSessions(): void {
        this.sessions = {};
        void this.saveSessions();
    }

    getSessions(): Readonly<Record<string, SessionRecord>> {
        return this.sessions;
    }

    /* ============================================================ */
    /* 会话 → 线程                                                   */
    /* ============================================================ */

    private sessionKey(chatId: string, senderId: string, mode: SessionMode): string {
        if (mode === 'single') return 'global';
        if (mode === 'per-sender') return `${chatId}::${senderId}`;
        return chatId;
    }

    private async resolveThread(chatId: string, senderId: string, title: string): Promise<string> {
        const config = this.cfg();
        const key = this.sessionKey(chatId, senderId, config.mode);

        const existing = this.sessions[key];
        if (existing?.threadId) {
            /* 校验线程是否还在（用户可能手动删了） */
            try {
                const threads = await this.api.getThreads();
                if (threads.some((t) => t.id === existing.threadId)) return existing.threadId;
                this.ctx.logger.warn('映射的线程已不存在，重新创建', existing.threadId);
            } catch (e) {
                /* 查询失败先信任缓存，避免网络抖动导致上下文丢失 */
                this.ctx.logger.warn('校验线程失败，沿用缓存', e);
                return existing.threadId;
            }
            delete this.sessions[key];
        }

        return this.createThreadFor(key, title);
    }

    private async createThreadFor(key: string, title: string): Promise<string> {
        const config = this.cfg();
        const model = await this.api.resolveModel(config.defaultModel);

        /* /use 设置的会话级覆盖优先于插件配置 */
        const override = this.workspaceOverrides[key];
        const workspaceId = override || (await this.api.resolveWorkspaceId(config.workspaceId));

        let thread;
        try {
            thread = await this.api.createThread({
                title: (title || '钉钉会话').slice(0, 80),
                ...(workspaceId ? { workspaceId } : {}),
                model,
            });
        } catch (e) {
            /* 回退：用插件上下文的 chat.createThread（若宿主接线了就能用） */
            this.ctx.logger.warn('HTTP 建线程失败，尝试插件 API 回退', e);
            const fallback = await this.ctx.chat.createThread({ title: (title || '钉钉会话').slice(0, 80), model });
            this.sessions[key] = { threadId: fallback.id, createdAt: Date.now(), title };
            await this.saveSessions();
            return fallback.id;
        }

        this.sessions[key] = { threadId: thread.id, createdAt: Date.now(), title };
        await this.saveSessions();
        this.ctx.logger.info(`为 ${key} 创建线程 ${thread.id}（工作区 ${workspaceId ?? '默认'}）`);
        return thread.id;
    }

    /** 强制为某会话换新线程 */
    async resetThread(chatId: string, senderId: string, title: string): Promise<string> {
        const key = this.sessionKey(chatId, senderId, this.cfg().mode);
        delete this.sessions[key];
        return this.createThreadFor(key, title);
    }

    /* ============================================================ */
    /* 回复                                                          */
    /* ============================================================ */

    private async reply(turn: TurnState, text: string, title?: string): Promise<void> {
        const chunks = DingTalkClient.chunk(text || '（无内容）');
        for (const chunk of chunks) {
            const result = await this.dingtalk.replyWebhook(turn.webhook, chunk, title);
            if (!result.ok) {
                this.ctx.logger.error('钉钉消息发送失败', result.error);
                return;
            }
        }
    }

    /* ============================================================ */
    /* 流式回复                                                      */
    /* ============================================================ */

    /**
     * 取可发送的一段。
     *
     * 规则：
     * - 找到最后一个句末标点/换行，切到那里（避免把半句话发出去）
     * - 没有边界时，只有攒够 200 字符才强制切
     * - 即使不足 MIN_FLUSH，只要有完整边界也允许发（短回复也要能流式出去）
     */
    static takeFlushable(text: string, alreadySent: number): string {
        const pending = text.slice(alreadySent);
        if (!pending) return '';

        const isBoundary = (ch: string): boolean =>
            ch === '\n' || ch === '。' || ch === '！' || ch === '？' ||
            ch === '.' || ch === '!' || ch === '?' || ch === '；' || ch === ';';

        let cut = -1;
        const floor = Math.max(0, pending.length - 400);
        for (let i = pending.length - 1; i >= floor; i--) {
            if (isBoundary(pending[i])) {
                cut = i + 1;
                break;
            }
        }

        if (cut > 0) return pending.slice(0, cut);
        return pending.length >= 200 ? pending : '';
    }

    private scheduleFlush(turn: TurnState): void {
        if (turn.flushTimer || turn.finished) return;
        const elapsed = Date.now() - (turn.flushStartedAt ?? turn.startedAt);
        if (elapsed < FLUSH_INTERVAL_MS) return;

        turn.flushTimer = setTimeout(() => {
            turn.flushTimer = undefined;
            void this.doFlush(turn);
        }, FLUSH_INTERVAL_MS);
    }

    private async doFlush(turn: TurnState): Promise<void> {
        if (turn.finished) return;
        /* 钉钉里逐段推送体验差，限制最多 3 段，超出就等最终一次性发 */
        if ((turn.flushCount ?? 0) >= 3) return;
        const piece = DingTalkBridge.takeFlushable(turn.text, turn.flushedChars ?? 0);
        if (!piece) return;
        turn.flushCount = (turn.flushCount ?? 0) + 1;

        turn.flushedChars = (turn.flushedChars ?? 0) + piece.length;
        turn.flushStartedAt = Date.now();

        const result = await this.dingtalk.replyWebhook(turn.webhook, piece);
        if (result.ok) {
            turn.streamed = true;
        } else {
            /* 推送失败就回退，保证最终一次性发全文 */
            turn.flushedChars = 0;
            turn.streamed = false;
        }
    }

    private cancelFlush(turn: TurnState): void {
        if (turn.flushTimer) {
            clearTimeout(turn.flushTimer);
            turn.flushTimer = undefined;
        }
    }

    /* ============================================================ */
    /* 回合收尾                                                      */
    /* ============================================================ */

    private async finalizeTurn(turn: TurnState): Promise<void> {
        try {
            this.cancelFlush(turn);

            const full = await this.readFinalText(turn);
            const alreadySent = turn.streamed ? (turn.flushedChars ?? 0) : 0;
            const remainder = full.slice(alreadySent).trim();

            if (remainder) {
                await this.reply(turn, remainder);
            } else if (!turn.streamed) {
                await this.reply(turn, '（本轮没有产生文本回复）');
            }
        } catch (e) {
            this.ctx.logger.error('回合收尾失败', e);
            await this.reply(turn, `❌ 收尾异常：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.socket.release(turn.threadId);
            this.completedTurns += 1;
        }
    }

    /** 回读数据库里的最终消息，兜住增量丢字 */
    private async readFinalText(turn: TurnState): Promise<string> {
        if (!turn.assistantMessageId) return turn.text.trim();
        try {
            const messages = await this.api.getMessages(turn.threadId);
            const target = messages.find((m: any) => {
                const id = m?.id ?? m?.message?.id;
                return id && String(id).includes(String(turn.assistantMessageId));
            });
            if (!target) return turn.text.trim();

            const parts = target?.message?.parts ?? target?.parts ?? [];
            const text = parts
                .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('')
                .trim();
            return text || turn.text.trim();
        } catch (e) {
            this.ctx.logger.warn('回读最终消息失败，使用累计文本', e);
            return turn.text.trim();
        }
    }

    /* ============================================================ */
    /* 入站                                                          */
    /* ============================================================ */

    private async dispatchDownstream(downstream: any): Promise<void> {
        const ac = new AbortController();
        try {
            await this.handleIncoming(downstream);
        } finally {
            ac.abort();
        }
    }

    async handleIncoming(downstream: any): Promise<void> {
        let payload: DingTalkRobotMessage;
        try {
            payload = typeof downstream.data === 'string' ? JSON.parse(downstream.data) : downstream.data;
        } catch (e) {
            this.ctx.logger.warn('消息载荷解析失败', e);
            this.ctx.logger.warn('原始 data:', String(downstream?.data).slice(0, 500));
            return;
        }

        /* 顺手记住机器人自身 ID，用于排除 atUsers 里的自己 */
        if (payload?.chatbotUserId) this.botDingTalkId = payload.chatbotUserId;

        /* 每个入站消息都记一行精简摘要，便于判断跨企业等边界情况 */
        this.ctx.logger.info(
            `入站字段: conv=${payload?.conversationId ? 'ok' : 'MISSING'}` +
                ` staff=${payload?.senderStaffId || '-'}` +
                ` sender=${payload?.senderId || '-'}` +
                ` nick=${payload?.senderNick || '-'}` +
                ` corp=${payload?.senderCorpId || '-'}` +
                ` botCorp=${payload?.chatbotCorpId || '-'}` +
                ` webhook=${payload?.sessionWebhook ? 'ok' : 'MISSING'}` +
                ` atUsers=${JSON.stringify(payload?.atUsers ?? null).slice(0, 220)}` +
                ` botUserId=${payload?.chatbotUserId || '-'}`,
        );

        const chatId = payload?.conversationId;
        /* 跨企业用户可能没有 senderStaffId，用 senderId 兜底 */
        const senderId =
            payload?.senderStaffId ||
            payload?.senderId ||
            /* 引用消息场景可能两个都没有，用昵称占位避免整条丢弃 */
            (payload?.senderNick ? `nick:${payload.senderNick}` : '');
        const webhook = payload?.sessionWebhook;
        const msgId = payload?.msgId;

        /*
         * 引用消息（点引用后再 @ 机器人）时，钉钉推来的载荷里
         * senderStaffId 可能缺失，但 senderId 通常还在，已在上文兜底。
         * 这里额外容忍"有 webhook 但没 sender"的情况：用昵称或占位 ID 继续处理。
         */
        if (!chatId || !webhook) {
            /*
             * 跨企业用户（如外部公司同事）常常没有 senderStaffId，
             * 这里记录完整载荷，方便判断到底缺哪个字段。
             */
            const missing = [
                !chatId && 'conversationId',
                !senderId && 'senderStaffId/senderId',
                !webhook && 'sessionWebhook',
            ].filter(Boolean);
            this.ctx.logger.warn(
                `消息缺少 ${missing.join(' / ')}，载荷如下:`,
                JSON.stringify({
                    conversationId: payload?.conversationId,
                    conversationType: payload?.conversationType,
                    senderId: payload?.senderId,
                    senderStaffId: payload?.senderStaffId,
                    senderNick: payload?.senderNick,
                    senderCorpId: payload?.senderCorpId,
                    chatbotCorpId: payload?.chatbotCorpId,
                    msgtype: payload?.msgtype,
                    hasWebhook: Boolean(payload?.sessionWebhook),
                    keys: Object.keys(payload ?? {}),
                }),
            );
            return;
        }

        /* 去重：钉钉重推同一个 msgId */
        if (msgId) {
            const now = Date.now();
            for (const [id, ts] of this.seenMsgIds) {
                if (now - ts > 5 * 60_000) this.seenMsgIds.delete(id);
            }
            if (this.seenMsgIds.has(msgId)) {
                this.ctx.logger.info('重复消息，跳过', msgId);
                return;
            }
            this.seenMsgIds.set(msgId, now);
        }

        const config = this.cfg();
        if (
            config.allowedStaffIds.length > 0 &&
            !config.allowedStaffIds.includes(senderId) &&
            !senderId.startsWith('nick:')
        ) {
            this.ctx.logger.info(`拒绝未授权用户 ${senderId}`);
            await this.dingtalk.replyWebhook(webhook, '⛔ 你没有使用这个机器人的权限。');
            return;
        }

        const text = this.extractText(payload);
        if (!text) {
            this.ctx.logger.warn(`消息文本为空（msgtype=${payload.msgtype}），忽略`);
            return;
        }

        this.lastMessageAt = Date.now();

        /* 允许前面残留 @ 或标点，命令判定放宽 */
        const cmdProbe = text.replace(/^[@\s,，:：]+/, '');
        if (cmdProbe.startsWith(COMMAND_PREFIX)) {
            const m = cmdProbe.match(/^\/(\S+)\s*([\s\S]*)$/);
            if (m) {
                const cmd = m[1].toLowerCase();
                this.ctx.logger.info(`执行命令 /${cmd}（来自 ${senderId}）`);
                await this.runCommand(cmd, m[2] ?? '', chatId, senderId, webhook);
                this.ctx.logger.info(`命令 /${cmd} 处理完毕`);
                return;
            }
        }

        /* 串行化：同一时刻只处理一条，避免并发写同一线程 */
        const previous = this.queue;
        let release!: () => void;
        this.queue = new Promise<void>((r) => (release = r));
        await previous.catch(() => undefined);

        try {
            const title =
                payload.conversationTitle ??
                (payload.conversationType === '1' ? '钉钉单聊' : `钉钉群 ${chatId.slice(0, 8)}`);

            this.ctx.logger.info(`对话消息（${senderId}）: ${text.slice(0, 60)}`);
            const threadId = await this.resolveThread(chatId, senderId, title);

            /*
             * 上一轮还在跑时不要丢弃这条消息，而是排队等它结束再处理。
             * 原来直接 return 会导致用户的消息彻底失踪。
             */
            if (this.socket.isRunning(threadId) || this.queuedThreads.has(threadId)) {
                await this.dingtalk.replyWebhook(webhook, '⏳ 上一条还在处理，已排队，稍后回复。');
                this.queuedThreads.add(threadId);
                try {
                    await this.waitForThreadIdle(threadId);
                    /* 排到队了，等前面那轮彻底释放（含队列里的） */
                    await this.waitForQueueDrain(threadId);
                } finally {
                    this.queuedThreads.delete(threadId);
                }
                this.ctx.logger.info(`线程 ${threadId} 空闲，开始处理排队的消息`);
            }

            const model = await this.api.resolveModel(config.defaultModel);
            const turn: TurnState = {
                threadId,
                chatId,
                webhook,
                senderId,
                text: '',
                tools: [],
                announcedTools: [],
                startedAt: Date.now(),
                lastActivity: Date.now(),
                finished: false,
            };
            await this.socket.submit(turn, model, text, {
                nick: payload.senderNick,
                staffId: senderId,
                chatTitle: payload.conversationTitle,
                mentions: this.extractMentionedPeople(payload),
            });
            this.ctx.logger.info(
                `已提交到线程 ${threadId}，模型 ${model}，发送人 ${payload.senderNick || senderId}`,
            );
        } catch (e) {
            this.ctx.logger.error('处理消息失败', e);
            this.lastError = e instanceof Error ? e.message : String(e);
            await this.dingtalk.replyWebhook(webhook, `❌ 处理失败：${this.lastError}`);
        } finally {
            release();
        }
    }

    /**
     * 从钉钉消息里提取文本。
     *
     * 注意：群里 @机器人 时，钉钉会把 "@豆豆" 混进文本开头
     * （text 类型通常是 "@豆豆 /help"，richText 里是 "@豆豆@1234 /help"）。
     * 不剥掉的话，`text.startsWith('/')` 永远不成立，所有命令都会失效。
     */
    /** 等待队列中该线程的排在前面请求处理完 */
    private async waitForQueueDrain(threadId: string, timeoutMs = 10 * 60_000): Promise<void> {
        const start = Date.now();
        while (this.socket.isRunning(threadId)) {
            if (Date.now() - start > timeoutMs) return;
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    /** 等待某个线程的生成结束（带超时，避免无限阻塞） */
    private async waitForThreadIdle(threadId: string, timeoutMs = 10 * 60_000): Promise<void> {
        const start = Date.now();
        while (this.socket.isRunning(threadId)) {
            if (Date.now() - start > timeoutMs) {
                this.ctx.logger.warn(`等待线程 ${threadId} 空闲超时，强行继续`);
                return;
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    private extractText(payload: DingTalkRobotMessage): string {
        const type = payload.msgtype;
        let text = '';

        if (type === 'text') {
            text = String(payload.text?.content ?? '');
        } else if (type === 'richText') {
            text = String(payload.content?.richText ?? '');
        } else if (type === 'picture' || type === 'image') {
            return '[用户发来一张图片，当前版本暂不支持图片识别]';
        } else if (type === 'audio' || type === 'voice') {
            return '[用户发来语音，当前版本暂不支持语音识别]';
        } else if (type === 'file') {
            return '[用户发来文件，当前版本暂不支持附件读取]';
        } else {
            return `[收到暂不支持的钉钉消息类型：${type}]`;
        }

        /* 保留一份原始文本，剥离后若为空就用它兜底（例如只发了个 @豆豆） */
        const original = text;

        /* 被 @ 的人已由 extractMentionedPeople 单独传给模型，这里从正文剥离避免重复 */
        const mentioned = this.extractMentionedPeople(payload);

        for (const person of mentioned) {
            const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(`@${escaped}`, 'g'), ' ');
        }

        /* 剥掉机器人自己被 @ 的残留（@豆豆 / @豆豆@1234） */
        text = text.replace(/@[^@\s]{1,20}?(?=\s|$)/g, (match) => {
            const name = match.slice(1);
            if (mentioned.some((p) => p.name === name)) return match; /* 已处理过 */
            return ' ';
        });

        const cleaned = text.replace(/[ \t]+/g, ' ').trim();

        /*
         * 引用消息场景：用户点"引用"再 @机器人，正文可能只有 @豆豆，
         * 剥离后为空。此时不能判定为"空消息"丢弃，要给个占位让模型继续处理。
         */
        if (!cleaned) {
            const hasReply = Boolean(payload.originalMsgId) || Boolean(payload.content?.isReplyMsg);
            if (hasReply) return '[用户引用了一条消息并 @ 了你，但没有附带文字]';
            if (original.trim()) return original.trim();
            return '';
        }

        return cleaned;
    }

    /**
     * 提取被 @ 的其他人（排除机器人自己），供模型了解"在跟谁说话"。
     */
    private extractMentionedPeople(payload: DingTalkRobotMessage): Array<{ name: string; dintalkId?: string }> {
        const botId = payload.chatbotUserId;
        const atUsers = payload.atUsers ?? [];
        const botName = this.botName;

        /*
         * 实测：钉钉只把「机器人自己」放进 atUsers，且常常没有 name，只有 dingtalkId。
         * 所以 atUsers 基本拿不到"被 @ 的其他人"，必须从文本解析。
         */
        const curated = atUsers
            .filter((u) => {
                if (!u?.name) return false;
                if (u.dingtalkId && botId && u.dingtalkId === botId) return false;
                if (botName && u.name === botName) return false;
                return true;
            })
            .map((u) => ({ name: u.name as string, dintalkId: u.dingtalkId }));

        /* 从原始文本里解析 @名字（含跨企业场景） */
        const raw =
            payload.msgtype === 'richText'
                ? String(payload.content?.richText ?? '')
                : String(payload.text?.content ?? '');

        const names = new Set<string>(curated.map((c) => c.name));
        /*
         * 匹配 @名字，兼容两种写法：
         *   "@冇 很调皮"        -> 冇
         *   "@冇@1234 很调皮"   -> 冇（后面的 @数字 是钉钉内部后缀）
         */
        const re = /@([^@\s]{1,20})/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
            let name = m[1].trim();
            /* 去掉钉钉附加的数字后缀，如 "冇@1234" 已在正则里分开，这里兜底 */
            name = name.replace(/[,，:：。.!！?？]+$/, '').trim();
            if (!name) continue;
            if (/^\d+$/.test(name)) continue;
            if (botName && name === botName) continue;
            if (this.botDingTalkId && name === this.botDingTalkId) continue;
            names.add(name);
        }

        return Array.from(names).map((name) => ({ name }));
    }

    /* ============================================================ */
    /* 命令                                                          */
    /* ============================================================ */

    private async runCommand(
        cmd: string,
        args: string,
        chatId: string,
        senderId: string,
        webhook: string,
    ): Promise<void> {
        const config = this.cfg();
        const reply = (t: string, title?: string) => this.dingtalk.replyWebhook(webhook, t, title);

        try {
            switch (cmd) {
                case 'help':
                case 'start':
                    await reply(
                        [
                            '👋 Alma 钉钉桥接',
                            '',
                            '直接发消息（或 @ 我）即可，我会用绑定的本地项目上下文回复。',
                            '',
                            '**会话管理**',
                            '- `/new [标题]` 开新会话，上下文从零开始',
                            '- `/stop` 停止当前生成',
                            '- `/status` 查看桥接状态',
                            '- `/help` 显示本帮助',
                            '',
                            '**工作区**',
                            '- `/ws` 列出可绑定的本地项目',
                            '- `/use <id>` 切换当前会话绑定的工作区',
                            '',
                            '**说明**',
                            '- 群里所有人共用一条会话，但会区分发言人',
                            '- 话题切换时建议 `/new`，避免上下文过长',
                            '- 群里需要 @ 我，私聊可直接发',
                        ].join('\n'),
                    );
                    break;

                case 'new': {
                    const title = args.trim() || `钉钉会话 ${new Date().toLocaleString('zh-CN')}`;
                    const threadId = await this.resetThread(chatId, senderId, title);
                    await reply(`✅ 已新建会话：${title}\n线程：${threadId}`);
                    break;
                }

                case 'stop': {
                    const key = this.sessionKey(chatId, senderId, config.mode);
                    const threadId = this.sessions[key]?.threadId;
                    if (!threadId) {
                        await reply('当前没有活跃会话。');
                        break;
                    }
                    if (!this.socket.stop(threadId)) {
                        await reply('当前线程没有正在执行的生成。');
                        break;
                    }
                    await reply('🛑 已发送停止指令');
                    break;
                }

                case 'status': {
                    const s = this.getStatus();
                    await reply(
                        [
                            '📊 DingTalk Bridge 状态',
                            `运行中：${s.running ? '是' : '否'}`,
                            `WebSocket：${s.socketConnected ? '已连接' : '未连接'}`,
                            `Alma API：127.0.0.1:${config.almaApiPort}`,
                            `模型：${config.defaultModel || '(跟随 Alma 默认)'}`,
                            `工作区：${config.workspaceId || '(跟随 Alma 默认)'}`,
                            `会话模式：${config.mode}`,
                            `会话数：${s.sessionCount}`,
                            ...(s.lastError ? [`最近错误：${s.lastError}`] : []),
                        ].join('\n'),
                    );
                    break;
                }

                case 'ws': {
                    const list = await this.api.getWorkspaces();
                    if (!list.length) {
                        await reply('没有找到任何工作区。');
                        break;
                    }
                    const lines = list.slice(0, 15).map((w) => `• ${w.name}  ${w.id}`);
                    await reply(['📁 可用工作区（用 /use <id> 绑定）', '', ...lines].join('\n'), '工作区列表');
                    break;
                }

                case 'use': {
                    const wsId = args.trim();
                    if (!wsId) {
                        await reply('用法：/use <workspaceId>，先用 /ws 查看列表');
                        break;
                    }
                    const list = await this.api.getWorkspaces();
                    const exists = list.some((w) => w.id === wsId);
                    if (!exists) {
                        await reply(`未找到工作区：${wsId}\n发送 /ws 查看可用列表。`);
                        break;
                    }
                    /*
                     * 用 storage.local 记工作区覆盖，不依赖 settings:write 权限。
                     * per-session 覆盖，避免影响其他群。
                     */
                    const key = this.sessionKey(chatId, senderId, config.mode);
                    this.workspaceOverrides[key] = wsId;
                    await this.saveWorkspaceOverrides();

                    const threadId = await this.resetThread(chatId, senderId, `钉钉会话 @${wsId}`);
                    await reply(`✅ 已切换到工作区 ${wsId}\n线程：${threadId}`);
                    break;
                }

                default:
                    await reply(`未知命令：/${cmd}，发送 /help 查看可用命令`);
                    break;
            }
        } catch (e) {
            this.ctx.logger.error('命令执行失败', e);
            await reply(`❌ 命令执行失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /* ============================================================ */
    /* 主动推送                                                      */
    /* ============================================================ */

    /** 向某个钉钉用户主动发消息（需要能换 token） */
    async notify(staffId: string, text: string): Promise<boolean> {
        const result = await this.dingtalk.sendToUser(staffId, text);
        if (!result.ok) this.ctx.logger.warn('主动推送失败', result.error);
        return result.ok;
    }

    /** 获取所有已知的钉钉用户（用于广播） */
    knownSenders(): string[] {
        return Array.from(new Set(Object.keys(this.sessions).map((k) => k.split('::')[1] ?? k)));
    }

    getCompletedTurns(): number {
        return this.completedTurns;
    }
}
