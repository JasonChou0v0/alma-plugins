/**
 * 桥接核心：钉钉消息 → Alma agent → 钉钉回复
 */
import { dataPaths } from './paths.mjs';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { PluginContext } from 'alma-plugin-api';

import { AlmaApi } from './alma-api';
import { loadAlmaImage } from './media';
import { appendPrivate, DEFAULT_RETENTION_DAYS } from './archive';
import { extractMentionedPeople, extractText, resolveQuotedMessage, type ParserEnv } from './message-parser';
import { AuthorizationCommands } from './authorization';
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
    encryptionAvailable?: () => Promise<boolean>;
}

/** 回合结束后推送的最终文本等 */
const STORAGE_KEY = 'dingtalkSessions';
const STORAGE_VER = 2;
const OVERRIDES_KEY = 'dingtalkWorkspaceOverrides';
const FLUSH_INTERVAL_MS = 1200;
const COMMAND_PREFIX = '/';
/** 回合无活动超过该阈值视为卡死，终结时先 stop 远端再本地收尾（非旧式纯本地 sweep） */
const STALE_TURN_MS = 15 * 60_000;

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
    private readonly queues = new Map<string, Promise<void>>();
    private stopping = false;
    private startEpoch = 0;
    private readonly threadQueues = new Map<string, Promise<void>>();
    private completedTurns = 0;

    private dwClient: DWClient | null = null;
    private running = false;
    /** 机器人自己的钉钉昵称，用于从 @ 列表里排除自己 */
    private botName: string | undefined;
    /** 机器人自己的 dingtalkId（从 chatbotUserId 学到） */
    private botDingTalkId: string | undefined;
    /**
     * 消息缓存：msgId -> 消息摘要。
     * 当前插件尚未接入引用消息查询接口，先从同一会话的本地缓存还原。
     */
    private readonly msgCache = new Map<string, { nick: string; text: string; at: number }>();

    /** 载荷归档目录 */
    private readonly logDir?: string;
    private startedAt: number | null = null;
    private lastMessageAt: number | null = null;
    private lastError: string | null = null;

    private readonly authorization: AuthorizationCommands;
    private readonly api: AlmaApi;
    private readonly dingtalk: DingTalkClient;
    private readonly socket: AlmaSocket;

    /* 去重缓冲：钉钉会在 60s 内重推未 ACK 的消息 */
    private readonly seenMsgIds = new Map<string, number>();
    /** 正在排队等待处理的线程，防止同一线程堆积 */

    /** 同一 session key 正在 resolveThread 的进行中 Promise，防止并发建线程 */
    private readonly resolving = new Map<string, Promise<string>>();
    /** 被「禁用工具」策略约束的线程集合，供 tool.willExecute 钩子核验取消 */
    private readonly toolsDisabledThreads = new Set<string>();
    /** 仅从经验证的加密存储加载，禁止使用普通设置作为运行时凭据。 */
    private secretClientSecret: string | undefined;

    constructor(private readonly deps: BridgeDeps) {
        this.ctx = deps.context;
        this.logDir = this.ctx.storagePath ? dataPaths(this.ctx.storagePath).logs : undefined;
        this.cfg = deps.config;
        this.authorization = new AuthorizationCommands(this.cfg, this.ctx.settings);

        this.api = new AlmaApi(
            () => `http://127.0.0.1:${this.cfg().almaApiPort}`,
            this.ctx.logger,
        );

        this.dingtalk = new DingTalkClient(
            () => {
                const c = this.cfg();
                /* secrets 里的凭据优先于 settings 明文 */
                return {
                    clientId: c.clientId,
                    clientSecret: this.secretClientSecret || '',
                    robotCode: c.robotCode || c.clientId,
                };
            },
            this.ctx.logger,
            this.ctx.storagePath,
            () => {
                const c = this.cfg();
                return { enabled: Boolean(c.logRawPayload), retentionDays: c.rawPayloadRetentionDays ?? DEFAULT_RETENTION_DAYS };
            },
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
                    // 不确定的远端回合不再复用线程（stop 请求不是完成确认）。
                    this.invalidateThread(turn.threadId);
                    this.socket.release(turn.threadId);
                    this.toolsDisabledThreads.delete(turn.threadId);
                    void Promise.resolve(turn.flushInFlight).catch(() => {}).then(() => this.reply(turn, `❌ 生成失败：${message}`)).catch(() => {}).finally(() => turn.settled?.());
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
        this.stopping = false;
        const epoch = ++this.startEpoch;
        const config = this.cfg();

        /* 从加密存储加载凭据；旧普通设置只用于迁移，迁移失败则停止启动。 */
        await this.loadSecretClientSecret(config);
        if (epoch !== this.startEpoch || this.stopping) return;

        const effectiveSecret = this.secretClientSecret;
        if (!config.clientId || !effectiveSecret) {
            this.lastError = '未配置 clientId / clientSecret';
            this.ctx.logger.warn('钉钉凭据未配置，桥接不会启动。请配置 AppKey，并执行「钉钉桥接：设置安全密钥」输入 AppSecret。');
            return;
        }

        if (config.allowedUnionIds.length === 0) {
            this.ctx.logger.warn(
                'allowedUnionIds 为空：所有入站消息都会被拒绝（无开放模式）。请在插件设置里配置用户白名单。',
            );
        }

        await this.loadSessions();
        await this.loadWorkspaceOverrides();
        this.socket.resume();
        void this.socket.connect();

        this.dwClient = new DWClient({
            clientId: config.clientId,
            clientSecret: effectiveSecret,
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
            const client = this.dwClient;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    client.connect(),
                    new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Stream 连接超时')), 30_000); }),
                ]);
            } finally { clearTimeout(deadline); }
            if (epoch !== this.startEpoch || this.stopping) { client.disconnect(); return; }
            this.running = true;
            this.startedAt = Date.now();
            this.lastError = null;
            this.ctx.logger.info('钉钉 Stream 已连接');
        } catch (e) {
            this.running = false;
            this.lastError = e instanceof Error ? e.message : String(e);
            try { this.dwClient?.disconnect(); } catch {}
            this.ctx.logger.error('钉钉 Stream 连接失败');
            throw new Error('钉钉 Stream 连接失败');
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.startEpoch += 1;
        this.running = false;
        this.dingtalk.clearToken();
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

    /**
     * 核验过的 secrets 访问：alma-plugin-api 的 SecretStorage 只有
     * get/set/delete（键为 string，值必须为 string），没有 keys/clear。
     * 使用前先做能力探测，绝不调用不存在的方法、绝不存非字符串值。
     */
    private get secrets(): { get(k: string): Promise<string | undefined>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> } | null {
        const s = (this.ctx.storage as any)?.secrets;
        if (s && typeof s.get === 'function' && typeof s.set === 'function' && typeof s.delete === 'function') {
            return s;
        }
        return null;
    }

    private async requireSecureStorage(): Promise<NonNullable<DingTalkBridge['secrets']>> {
        const available = this.deps.encryptionAvailable
            ? await this.deps.encryptionAvailable()
            : await import('electron').then(m => m.safeStorage.isEncryptionAvailable()).catch(() => false);
        // 宿主 secrets 在 safeStorage 不可用时会降级成明文，所以必须先拒绝。
        if (!available || !this.secrets) throw new Error('安全密钥存储不可用，拒绝使用明文凭据');
        return this.secrets;
    }

    async loadSecretClientSecret(config: BridgeConfig): Promise<void> {
        this.secretClientSecret = undefined;
        const store = await this.requireSecureStorage();
        const key = config.clientSecretSecretKey?.trim() || 'dingtalk.clientSecret';
        if (config.clientSecret) {
            // 迁移：写入并回读成功后才清空旧设置；清空失败则不启动。
            await store.set(key, config.clientSecret);
            if (await store.get(key) !== config.clientSecret) throw new Error('密钥迁移校验失败');
            await this.ctx.settings.update('dingtalkBridge.clientSecret', '');
            if (this.ctx.settings.get('dingtalkBridge.clientSecret', '')) throw new Error('旧明文设置未清空');
        }
        const value = await store.get(key);
        if (typeof value === 'string' && value) this.secretClientSecret = value;
    }

    async storeClientSecret(value: string): Promise<boolean> {
        if (typeof value !== 'string' || !value.trim()) return false;
        try {
            const store = await this.requireSecureStorage();
            const key = this.cfg().clientSecretSecretKey?.trim() || 'dingtalk.clientSecret';
            await store.set(key, value);
            if (await store.get(key) !== value) return false;
            if (this.cfg().clientSecret) await this.ctx.settings.update('dingtalkBridge.clientSecret', '');
            this.secretClientSecret = value;
            this.dingtalk.clearToken();
            return true;
        } catch {
            this.ctx.logger.warn('安全密钥保存失败，未启用新凭据');
            return false;
        }
    }

    private invalidateThread(threadId: string): void {
        for (const [key, session] of Object.entries(this.sessions)) {
            if (session.threadId === threadId) delete this.sessions[key];
        }
        void this.saveSessions();
    }

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

        /*
         * 并发去重：两条消息几乎同时到达时，可能都发现 sessions[key] 为空而各自建线程。
         * 用「进行中的 Promise」共享同一次创建，保证一个 session key 只建一条线程。
         */
        const inflight = this.resolving.get(key);
        if (inflight) return inflight;

        const task = (async (): Promise<string> => {
            const existing = this.sessions[key];
            if (existing?.threadId) {
                /* 校验线程是否还在（用户可能手动删了） */
                try {
                    const thread = await this.ctx.chat.getThread(existing.threadId);
                    if (thread) return existing.threadId;
                    this.ctx.logger.warn('映射的线程已不存在，重新创建', existing.threadId);
                } catch (e) {
                    /* 查询失败先信任缓存，避免网络抖动导致上下文丢失 */
                    this.ctx.logger.warn('校验线程失败，沿用缓存', e);
                    return existing.threadId;
                }
                delete this.sessions[key];
            }

            return this.createThreadFor(key, title);
        })();

        this.resolving.set(key, task);
        try {
            return await task;
        } finally {
            this.resolving.delete(key);
        }
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
     * - 绝不在未闭合的代码围栏（```）中间切断，否则钉钉渲染会错乱
     */
    static takeFlushable(text: string, alreadySent: number): string {
        const pending = text.slice(alreadySent);
        if (!pending) return '';

        const isBoundary = (ch: string): boolean =>
            ch === '\n' || ch === '。' || ch === '！' || ch === '？' ||
            ch === '.' || ch === '!' || ch === '?' || ch === '；' || ch === ';';

        /** 统计「行首三反引号」围栏数量，奇数表示围栏未闭合 */
        const fenceCount = (s: string): number => {
            let n = 0;
            for (const line of s.split('\n')) {
                if (/^\s*```/.test(line)) n += 1;
            }
            return n;
        };

        let cut = -1;
        const floor = Math.max(0, pending.length - 400);
        for (let i = pending.length - 1; i >= floor; i--) {
            if (isBoundary(pending[i])) {
                const candidate = i + 1;
                /* 落在未闭合围栏内则跳过这个切点，继续往前找 */
                if (fenceCount(pending.slice(0, candidate)) % 2 === 1) continue;
                cut = candidate;
                break;
            }
        }

        if (cut > 0) return pending.slice(0, cut);

        /* 强切也要避开未闭合围栏：整段还在围栏里就先不发 */
        if (pending.length >= 200 && fenceCount(pending) % 2 === 0) return pending;
        return '';
    }

    private scheduleFlush(turn: TurnState): void {
        if (turn.flushTimer || turn.finished || turn.attachments?.length) return;
        const elapsed = Date.now() - (turn.flushStartedAt ?? turn.startedAt);
        if (elapsed < FLUSH_INTERVAL_MS) return;

        turn.flushTimer = setTimeout(() => {
            turn.flushTimer = undefined;
            void this.doFlush(turn);
        }, FLUSH_INTERVAL_MS);
    }

    private async doFlush(turn: TurnState): Promise<void> {
        if (turn.finished || turn.flushInFlight || turn.attachments?.length || (turn.flushCount ?? 0) >= 3) return;
        const piece = DingTalkBridge.takeFlushable(turn.text, turn.flushedChars ?? 0);
        if (!piece) return;
        turn.flushCount = (turn.flushCount ?? 0) + 1;
        turn.flushStartedAt = Date.now();
        const sending = this.sendBuffered(turn, piece);
        turn.flushInFlight = sending;
        try { await sending; } finally { turn.flushInFlight = undefined; }
    }

    private async sendBuffered(turn: TurnState, text: string): Promise<void> {
        for (const piece of DingTalkClient.chunkParts(text)) {
            const result = await this.dingtalk.replyWebhook(turn.webhook, piece.text);
            if (!result.ok) {
                turn.deliveryFailed = true;
                this.lastError = '回复部分或全部发送失败，已保留成功发送游标';
                return;
            }
            turn.flushedChars = (turn.flushedChars ?? 0) + piece.consumed;
            turn.streamed = true;
            turn.deliveryFailed = false;
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

    private async sendTurnImages(turn: TurnState): Promise<{ failed: boolean; summary: string }> {
        if (!turn.attachments?.length && !turn.attachmentOverflow) return { failed: false, summary: '' };
        const authorized = () => {
            const cfg = this.cfg();
            return !this.stopping && !turn.stopRequested && cfg.allowedUnionIds.includes(turn.senderId) &&
                (turn.conversationType === '1' || (turn.conversationType === '2' &&
                    cfg.allowedConversationIds.includes(turn.chatId) && cfg.groupAgentPolicy === 'fullTools'));
        };
        let succeeded = 0;
        const errors: string[] = [];
        for (const attachment of turn.attachments ?? []) {
            try {
                if (!authorized()) throw new Error('图片发送权限已撤销或回合已停止');
                if (turn.conversationType === '1' && !turn.senderStaffId) {
                    throw new Error('图片私聊缺少钉钉投递地址；UnionID 授权不能替代接口所需 userId');
                }
                const image = await loadAlmaImage(attachment, this.cfg().almaApiPort);
                const result = await this.dingtalk.sendImage(
                    turn.conversationType === '2' ? { conversationId: turn.chatId } : { staffId: turn.senderStaffId },
                    image, authorized,
                );
                if (!result.ok) throw new Error(result.error || '钉钉图片发送未成功确认');
                succeeded++;
            } catch (e) {
                // Only known local validation errors / client summaries are safe to show.
                const message = e instanceof Error ? e.message : '';
                errors.push(/^(暂只支持|图片|仅允许|读取 Alma|钉钉图片)/.test(message) ? message : '图片读取或发送失败');
            }
        }
        if (turn.attachmentOverflow) errors.push('每轮最多发送 4 张图片，超出部分未发送');
        return {
            failed: errors.length > 0,
            summary: [succeeded ? `🖼️ ${succeeded} 张图片已获钉钉发送成功回执。` : '',
                errors.length ? `⚠️ 图片未全部发送成功：${[...new Set(errors)].join('；')}。本机附件发送成功不代表钉钉已收到。` : '',
            ].filter(Boolean).join('\n'),
        };
    }

    private async finalizeTurn(turn: TurnState): Promise<void> {
        try {
            this.cancelFlush(turn);
            await turn.flushInFlight;

            /*
             * 单一权威缓冲：以本轮累计的 turn.text 为准。
             * 不再回读数据库消息——那会造成「流式用 turn.text、最终用 DB」两套来源，
             * 既可能掩饰增量未完成，也与「单一权威缓冲」相悖。
             * 若 WS 丢了增量，这里如实发出（可能偏短），不掩盖未完成。
             */
            const media = await this.sendTurnImages(turn);
            // A failed attachment must not be followed by an agent claim of successful image delivery.
            const full = media.failed ? media.summary : turn.text + (media.summary ? '\n\n' + media.summary : '');
            const alreadySent = !media.failed && turn.streamed ? (turn.flushedChars ?? 0) : 0;
            const remainder = full.slice(alreadySent);

            if (remainder) {
                await this.sendBuffered(turn, remainder);
            } else if (!turn.streamed) {
                await this.reply(turn, '（本轮没有产生文本回复）');
            }
        } catch (e) {
            this.ctx.logger.error('回合收尾失败', e);
            await this.reply(turn, `❌ 收尾异常：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.socket.release(turn.threadId);
            this.toolsDisabledThreads.delete(turn.threadId);
            this.completedTurns += 1;
            turn.settled?.();
        }
    }

    /* ============================================================ */
    /* 入站                                                          */
    /* ============================================================ */

    private async dispatchDownstream(downstream: any): Promise<void> {
        await this.handleIncoming(downstream);
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
                ` botUserId=${payload?.chatbotUserId || '-'}` +
                ` originalMsgId=${payload?.originalMsgId || '-'}` +
                ` isReply=${payload?.text?.isReplyMsg ?? payload?.content?.isReplyMsg ?? '-'}` +
                ` convType=${payload?.conversationType || '-'}` +
                ` convTitle=${payload?.conversationTitle || '-'}`,
        );

        /*
         * 全量保存原始载荷。
         * 钉钉返回的字段随场景变化（群聊/单聊/引用/跨企业各不相同），
         * 先原样落盘，需要时再分析，避免猜字段名。
         */
        if (this.cfg().logRawPayload) {
            this.archivePayload(payload, downstream);
        }

        const chatId = payload?.conversationId;
        // 只使用钉钉事件中的 UnionID；staffId、senderId 和昵称都不能作为鉴权兜底。
        const senderId = typeof payload.senderUnionId === 'string' ? payload.senderUnionId : '';
        const webhook = payload?.sessionWebhook;
        const msgId = payload?.msgId;

        /* 会话和回复地址为必需字段；用户身份随后只按 senderUnionId 核验。 */
        if (!chatId || !webhook) {
            /*
             * 跨企业用户（如外部公司同事）常常没有 senderStaffId，
             * 这里记录完整载荷，方便判断到底缺哪个字段。
             */
            const missing = [
                !chatId && 'conversationId',
                !senderId && 'senderUnionId',
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
            /* 插入顺序即时间顺序，遇到第一条未过期的就可以停 */
            for (const [id, ts] of this.seenMsgIds) {
                if (now - ts <= 5 * 60_000) break;
                this.seenMsgIds.delete(id);
            }
            if (this.seenMsgIds.has(msgId)) {
                this.ctx.logger.info('重复消息，跳过', msgId);
                return;
            }
            this.seenMsgIds.set(msgId, now);
        }

        const config = this.cfg();
        if (!['1', '2'].includes(String(payload.conversationType))) {
            this.ctx.logger.warn('未知会话类型，拒绝执行');
            return;
        }
        const isGroup = String(payload.conversationType) === '2';

        /*
         * 访问控制（覆盖所有入站，含 /help、/status 等命令——命令一律先鉴权）：
         * - nick: 占位 ID 永不可授权：昵称可伪造，不是可信身份，即便被写进白名单也拒；
         * - 用户白名单 allowedUnionIds 为空 → 拒绝（不再有"开放模式"）；
         * - 用户不在白名单 → 拒绝；
         * - 群白名单 allowedConversationIds：群聊必须在名单内，空则拒绝所有群；
         *   单聊不受群白名单约束（仍受用户白名单约束）。
         * 这里只做"是否允许进入"；/use、/new 的管理员鉴权在 runCommand 里做。
         */
        if (!senderId || senderId.startsWith('nick:')) {
            this.ctx.logger.info(`拒绝不可信 nick: 占位 ID ${senderId}`);
            await this.dingtalk.replyWebhook(webhook, '⛔ 无法核实你的身份（缺少可信 UnionID），已拒绝。');
            return;
        }

        if (config.allowedUnionIds.length === 0) {
            this.ctx.logger.warn('allowedUnionIds 为空，拒绝所有入站（无开放模式）');
            await this.dingtalk.replyWebhook(webhook, '⛔ 未配置用户白名单，机器人未开放使用。');
            return;
        }

        if (!config.allowedUnionIds.includes(senderId)) {
            this.ctx.logger.info(`拒绝未授权用户 ${senderId}`);
            await this.dingtalk.replyWebhook(webhook, '⛔ 你没有使用这个机器人的权限。');
            return;
        }

        // 仅授权管理命令允许特殊入口：已授权管理员可以授权当前未开放群。
        // run() 再次核验管理员和用户白名单；不会进入 agent 或改变工具策略。
        const authText = this.extractText(payload).replace(/^[@\s,，:：]+/, '');
        const authMatch = authText.match(/^\/(allow|deny|access)(?:\s+([\s\S]*))?$/i);
        const authCommand = authMatch?.[1].toLowerCase() ?? '';
        if (authMatch && AuthorizationCommands.isCommand(authCommand)) {
            const result = await this.authorization.run(authCommand, authMatch[2] ?? '', senderId, payload);
            await this.dingtalk.replyWebhook(webhook, result);
            return;
        }

        if (isGroup) {
            if (config.allowedConversationIds.length === 0) {
                this.ctx.logger.info(`拒绝群聊 ${chatId}：allowedConversationIds 为空`);
                await this.dingtalk.replyWebhook(webhook, '⛔ 未配置群白名单，群聊未开放使用。');
                return;
            }
            if (!config.allowedConversationIds.includes(chatId)) {
                this.ctx.logger.info(`拒绝未授权群聊 ${chatId}`);
                await this.dingtalk.replyWebhook(webhook, '⛔ 此群未在白名单中，无法使用。');
                return;
            }
        }

        const text = this.extractText(payload);
        if (!text) {
            this.ctx.logger.warn(`消息文本为空（msgtype=${payload.msgtype}），忽略`);
            return;
        }

        this.lastMessageAt = Date.now();

        /* 缓存本条消息，供后续被引用时还原 */
        if (payload.msgId) {
            this.msgCache.set(`${chatId}:${payload.msgId}`, {
                nick: payload.senderNick || senderId,
                text: this.extractText(payload).slice(0, 500),
                at: Date.now(),
            });
            /* 只保留最近 500 条；Map 按插入顺序，超限时直接删最老的一条，O(1) */
            while (this.msgCache.size > 500) {
                const oldest = this.msgCache.keys().next().value;
                if (oldest === undefined) break;
                this.msgCache.delete(oldest);
            }
        }

        /* 允许前面残留 @ 或标点，命令判定放宽 */
        const cmdProbe = text.replace(/^[@\s,，:：]+/, '');
        if (cmdProbe.startsWith(COMMAND_PREFIX)) {
            const m = cmdProbe.match(/^\/(\S+)\s*([\s\S]*)$/);
            if (m) {
                const cmd = m[1].toLowerCase();
                this.ctx.logger.info(`执行命令 /${cmd}（来自 ${senderId}）`);
                if (cmd === 'use' || cmd === 'new') {
                    const commandKey = this.sessionKey(chatId, senderId, config.mode);
                    const previous = this.queues.get(commandKey) ?? Promise.resolve();
                    let unlock!: () => void;
                    const gate = new Promise<void>(r => { unlock = r; });
                    this.queues.set(commandKey, gate);
                    await previous;
                    try {
                        const current = this.cfg();
                        if (!this.stopping && current.allowedUnionIds.includes(senderId) &&
                            (!isGroup || current.allowedConversationIds.includes(chatId))) {
                            await this.runCommand(cmd, m[2] ?? '', chatId, senderId, webhook);
                        }
                    } finally {
                        unlock();
                        if (this.queues.get(commandKey) === gate) this.queues.delete(commandKey);
                    }
                } else await this.runCommand(cmd, m[2] ?? '', chatId, senderId, webhook);
                this.ctx.logger.info(`命令 /${cmd} 处理完毕`);
                return;
            }
        }

        const title =
            payload.conversationTitle ??
            (payload.conversationType === '1' ? '钉钉单聊' : `钉钉群 ${chatId.slice(0, 8)}`);

        /*
         * 群聊（conversationType=2）工具策略。
         * 不能仅靠 ephemeralContext 提示词约束工具——提示词不是权限边界。
         * - refuse（默认，唯一安全选项）：拒绝群 agent 任务并解释，不提交 generate_response。
         *   无法经核验确认内部 WS 回合会触发插件 tool.willExecute 钩子，故默认拒绝。
         * - fullTools：管理员明确接受风险，保留工具。
         * 旧配置里的 noTools 已在 readConfig 映射为 refuse（钩子在内部 WS 路径是否生效无法确认，
         * 不能当作安全选项）；tool.willExecute 钩子仍注册为不可靠的纵深防御。
         * 该约束对所有发送人一视同仁，管理员也不绕过。
         */
        const policy = config.groupAgentPolicy;
        if (isGroup && policy !== 'fullTools') {
            this.ctx.logger.info(`拒绝群 agent 任务（policy=refuse, conv=${chatId}, sender=${senderId}）`);
            await this.dingtalk.replyWebhook(
                webhook,
                [
                    '⛔ 群聊默认不驱动带工具的 agent 任务。',
                    '',
                    '原因：无法经核验确认内部 agent 回合会强制禁用本地工具，',
                    '直接在群里跑完整 agent 等于让群内任何人触发本机文件读写/命令执行。',
                    '',
                    '如需在群里跑完整 agent，管理员可把 groupAgentPolicy 显式设为 fullTools',
                    '（接受全部风险，保留工具）。曾经的 noTools 不再作为安全选项：它依赖的',
                    '宿主 tool.willExecute 钩子在内部 WS 回合是否触发无法确认，不能保证禁用工具。',
                    '私聊（单聊）不受此限制。',
                ].join('\n'),
            );
            return;
        }

        this.ctx.logger.info(`对话消息（${senderId}）: ${text.slice(0, 60)}`);

        // sessionKey 在建线程前锁定；同一键只创建一个线程、同一线程只运行一轮。
        // 不同键独立，等待生成结束或网络回复时不阻塞其他群。
        const key = this.sessionKey(chatId, senderId, config.mode);
        const previous = this.queues.get(key) ?? Promise.resolve();
        const queued = this.queues.has(key);
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        this.queues.set(key, gate);
        if (queued) void this.dingtalk.replyWebhook(webhook, '⏳ 已排队，上一条结束后继续处理。').catch(() => {});
        await previous;
        let threadIdLocked: string | undefined;
        let threadGate: Promise<void> | undefined;
        let releaseThread: (() => void) | undefined;
        try {
            if (this.stopping) throw new Error('桥接已停止，本条未执行，请稍后重试');
            // 排队期间权限可能变更，执行前再校验一次。
            const live = this.cfg();
            if (!live.allowedUnionIds.includes(senderId) ||
                (isGroup && (!(live.allowedConversationIds ?? []).includes(chatId) || live.groupAgentPolicy !== 'fullTools'))) {
                throw new Error('排队期间权限已变更，本条未执行');
            }
            const threadId = await this.resolveThread(chatId, senderId, title);
            threadIdLocked = threadId;
            const priorThread = this.threadQueues.get(threadId) ?? Promise.resolve();
            threadGate = new Promise<void>(r => { releaseThread = r; });
            this.threadQueues.set(threadId, threadGate);
            await priorThread;
            if (this.stopping) throw new Error('桥接已停止');
            const model = await this.api.resolveModel(config.defaultModel);
            const turn: TurnState = {
                threadId,
                chatId,
                webhook,
                senderId,
                senderStaffId: payload.senderStaffId,
                conversationType: String(payload.conversationType),
                text: '',
                tools: [],
                announcedTools: [],
                startedAt: Date.now(),
                lastActivity: Date.now(),
                finished: false,
            };

            /*
             * 引用消息：优先使用事件中的原文，缺失时从同会话缓存还原。
             * 注意：缓存的 nick 来自历史消息的 senderNick（可伪造），故在
             * ephemeralContext 里会标 authorTrusted=false；这里只透传原文。
             */
            const quoted = this.resolveQuotedMessage(payload);

            const completed = new Promise<void>(resolve => { turn.settled = resolve; });
            await this.socket.submit(turn, model, text, {
                nick: payload.senderNick,
                unionId: senderId,
                chatTitle: payload.conversationTitle,
                mentions: this.extractMentionedPeople(payload),
                quoted,
            });
            this.ctx.logger.info(
                `已提交到线程 ${threadId}，模型 ${model}`,
            );
            await completed;
        } catch (e) {
            const failedId = this.sessions[key]?.threadId;
            if (failedId) this.invalidateThread(failedId);
            this.ctx.logger.error('处理消息失败', e);
            this.lastError = e instanceof Error ? e.message : String(e);
            await this.dingtalk.replyWebhook(webhook, `❌ 处理失败：${this.lastError}`);
        } finally {
            releaseThread?.();
            if (threadIdLocked && this.threadQueues.get(threadIdLocked) === threadGate) this.threadQueues.delete(threadIdLocked);
            release();
            if (this.queues.get(key) === gate) this.queues.delete(key);
        }
    }

    /**
     * 从钉钉消息里提取文本。
     *
     * 注意：群里 @机器人 时，钉钉会把 "@豆豆" 混进文本开头
     * （text 类型通常是 "@豆豆 /help"，richText 里是 "@豆豆@1234 /help"）。
     * 不剥掉的话，`text.startsWith('/')` 永远不成立，所有命令都会失效。
     */
    /**
     * 把原始载荷完整写入归档文件。
     *
     * 按天分文件：context.storagePath/logs/dingtalk-payloads-YYYY-MM-DD.jsonl
     * 每行一条 JSON，方便 grep / jq / 看板读取。
     */
    private archivePayload(payload: any, downstream: any): void {
        try {
            const dir = this.logDir;
            if (!dir) return;
            appendPrivate(dir, {
                receivedAt: new Date().toISOString(),
                headers: downstream?.headers ?? null,
                payload,
            }, this.cfg().rawPayloadRetentionDays ?? DEFAULT_RETENTION_DAYS);
        } catch (e) {
            this.ctx.logger.warn('归档原始载荷失败', e instanceof Error ? e.message : 'unknown');
        }
    }

    private parserEnv(): ParserEnv {
        const self = this;
        return {
            msgCache: this.msgCache,
            get botName() { return self.botName; },
            set botName(v) { self.botName = v; },
            get botDingTalkId() { return self.botDingTalkId; },
            set botDingTalkId(v) { self.botDingTalkId = v; },
            robotName: () => this.cfg().robotName,
        };
    }

    private resolveQuotedMessage(payload: DingTalkRobotMessage): { nick: string; text: string } | null {
        return resolveQuotedMessage(payload, this.parserEnv());
    }

    private extractText(payload: DingTalkRobotMessage): string {
        return extractText(payload, this.parserEnv());
    }

    private extractMentionedPeople(payload: DingTalkRobotMessage) {
        return extractMentionedPeople(payload, this.parserEnv());
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

        /*
         * 管理员命令鉴权：/use、/new 仅显式 adminUnionIds 可用。
         * 仍受上游用户白名单与群白名单约束（已在 handleIncoming 入站鉴权里完成）。
         * adminUnionIds 为空 → 无人可用这两个命令（不把 allowedUnionIds 隐式当管理员）。
         */
        if (cmd === 'use' || cmd === 'new') {
            if (config.adminUnionIds.length === 0 || !config.adminUnionIds.includes(senderId)) {
                this.ctx.logger.info(`拒绝非管理员 ${senderId} 执行 /${cmd}`);
                await reply('⛔ 该命令仅限管理员使用。');
                return;
            }
        }

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
                            '**授权管理（仅管理员）**',
                            '- `/allow @用户` / `/deny @用户` 授权或撤销用户（需要钉钉返回真实 UnionID）',
                            '- `/allow union <UnionID>` / `/deny union <UnionID>` 按 UnionID 操作',
                            '- `/allow group` / `/deny group` 授权或撤销当前群',
                            '- `/access` 查看白名单；管理员和工具策略仅在本机修改',
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

    /**
     * AI 工具 dingtalk_notify 的鉴权入口。
     *
     * 防绕过：
     * - 收件人必须在显式用户白名单里，不能向任意 UnionID 发信；
     * - 调用线程若被「禁用工具」标记约束，拒绝发信（纵深防御，防绕过）；
     * - 文本长度受限，避免被当成无界广播通道。
     */
    async notify(
        unionId: string,
        text: string,
        options?: { threadId?: string },
    ): Promise<{ ok: boolean; error?: string }> {
        const config = this.cfg();
        const recipient = String(unionId ?? '').trim();
        const body = String(text ?? '');

        if (!recipient) return { ok: false, error: '缺少 UnionID' };
        if (!body) return { ok: false, error: '缺少消息内容' };
        if (body.length > 4000) return { ok: false, error: '消息过长（>4000）' };

        /*
         * 只允许白名单里的真实收件人（防 send helper 旁路）：
         * - nick: 占位 ID 永不可授权（不是可信 UnionID）；
         * - 白名单为空 → 拒绝（无开放模式）；
         * - 不再用 knownSenders() 兜底——那会把任何发过消息的人（含未授权占位 ID）
         *   放进来，构成主动发信旁路。
         */
        if (recipient.startsWith('nick:')) {
            this.ctx.logger.warn(`notify 拒绝不可信 nick: 收件人: ${recipient}`);
            return { ok: false, error: '收件人为不可信 nick: 占位 ID，已拒绝' };
        }
        if (config.allowedUnionIds.length === 0 || !config.allowedUnionIds.includes(recipient)) {
            this.ctx.logger.warn(`notify 拒绝向未授权收件人发信: ${recipient}`);
            return { ok: false, error: `收件人 ${recipient} 不在白名单中，已拒绝（防绕过）` };
        }

        if (options?.threadId && this.toolsDisabledThreads.has(options.threadId)) {
            this.ctx.logger.warn(`notify 拒绝在禁用工具的线程 ${options.threadId} 里发信`);
            return { ok: false, error: '当前会话工具被禁用，不允许主动发信' };
        }

        const result = await this.dingtalk.sendToUnionUser(recipient, body, () =>
            this.cfg().allowedUnionIds.includes(recipient) &&
            !(options?.threadId && this.toolsDisabledThreads.has(options.threadId)));
        if (!result.ok) {
            this.ctx.logger.warn('主动推送失败', result.error);
            return { ok: false, error: result.error };
        }
        return { ok: true };
    }

    /** 获取所有已知的钉钉用户（用于广播/notify 白名单） */
    knownSenders(): string[] {
        return Array.from(new Set(Object.keys(this.sessions).map((k) => k.split('::')[1] ?? k)));
    }

    getCompletedTurns(): number {
        return this.completedTurns;
    }

    /**
     * 终结卡住的回合（连接未断、但 agent 长时间无活动）。
     *
     * 取代旧的危险 sweep：旧 sweep 只删本地 turns 让远端继续跑，造成重叠并掩盖失败。
     * 这里委托 socket.terminateStaleTurns，对每个超阈值的回合先发 stop_generation
     * 取消远端，再走 onError 回复用户并释放线程——stop/cancel 且可告知，非本地静默清理。
     */
    sweepStaleTurns(): number {
        return this.socket.terminateStaleTurns(STALE_TURN_MS);
    }

    /** 供宿主 tool.willExecute 钩子核验：该线程是否被策略禁用工具 */
    isToolsDisabledForThread(threadId: string): boolean {
        return this.toolsDisabledThreads.has(threadId);
    }

    /** 释放某线程的工具禁用标记（测试/收尾用） */
    clearToolsDisabled(threadId: string): void {
        this.toolsDisabledThreads.delete(threadId);
    }
}
