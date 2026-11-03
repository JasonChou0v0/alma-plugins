/**
 * DingTalk Bridge — Alma 插件
 *
 * 把钉钉机器人接成 Alma 的聊天渠道。Alma 的渠道是硬编码的
 * （telegram / discord / feishu / lark / weixin），插件没有 channels.register()，
 * 因此这里走替代路径：钉钉 Stream 模式收消息 + Alma 内部 WebSocket 协议驱动
 * 完整 agent（工具 / 技能 / 项目工作区）。
 *
 * 结构参考官方 alma-plugins 仓库：
 * - manifest.json 声明 main.js（预打包，自包含依赖，无需 npm install）
 * - main.ts 只做装配，逻辑放在 lib/
 * - 命令用 commands.register(id, handler)
 * - 状态用 ui.createStatusBarItem
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';

import { DingTalkBridge } from './lib/bridge';
import { createLogger } from './lib/log';
import type { BridgeConfig, GroupAgentPolicy, SessionMode } from './lib/types';

const STATUS_BAR_ID = 'alma-dingtalk-bridge.status';

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { settings, ui, commands } = context;

    /* 插件自有产物统一放到宿主分配的 storagePath。 */
    const logger = createLogger(context.logger, context.storagePath);

    logger.info('DingTalk Bridge 正在激活…');
    logger.info('日志文件:', logger.filePath());

    /* ---------------- 配置读取 ---------------- */

    const readConfig = (): BridgeConfig => {
        const get = <T>(key: string, fallback: T): T => {
            try {
                const value = settings.get<T>(`dingtalkBridge.${key}` as any, fallback);
                return value === undefined || value === null ? fallback : value;
            } catch {
                return fallback;
            }
        };

        const rawUnion = String(get<string>('allowedUnionIds', '') ?? '');
        const rawConv = String(get<string>('allowedConversationIds', '') ?? '');
        const rawAdmin = String(get<string>('adminUnionIds', '') ?? '');
        const mode = String(get<string>('mode', 'per-chat')) as SessionMode;
        const rawPolicy = String(get<string>('groupAgentPolicy', 'refuse')) as GroupAgentPolicy;
        /*
         * noTools 已不再是可选安全策略：宿主 tool.willExecute 钩子在内部 WS
         * generate_response 回合是否触发无法从插件侧确认，故把旧配置里的 noTools
         * 当作 refuse 处理，避免管理员误以为「禁了工具」而实际未必生效。
         */
        if (rawPolicy === 'noTools') {
            logger.warn(
                'groupAgentPolicy=noTools 已不再作为安全选项（钩子在内部 WS 回合是否触发未确认），按 refuse 处理。' +
                    '如需群 agent 回合，请显式设为 fullTools 并接受全部风险。',
            );
        }

        return {
            almaApiPort: Number(get<number>('almaApiPort', 23001)) || 23001,
            clientId: String(get<string>('clientId', '') ?? '').trim(),
            clientSecret: String(get<string>('clientSecret', '') ?? '').trim(),
            robotCode: String(get<string>('robotCode', '') ?? '').trim(),
            robotName: String(get<string>('robotName', '豆豆') ?? '豆豆').trim(),
            defaultModel: String(get<string>('defaultModel', '') ?? '').trim(),
            workspaceId: String(get<string>('workspaceId', '') ?? '').trim(),
            mode: mode === 'per-sender' || mode === 'single' ? mode : 'per-chat',
            allowedUnionIds: rawUnion
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            allowedConversationIds: rawConv
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            adminUnionIds: rawAdmin
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            streamingReply: Boolean(get<boolean>('streamingReply', false)),
            replyOnToolUse: Boolean(get<boolean>('replyOnToolUse', true)),
            logRawPayload: Boolean(get<boolean>('logRawPayload', true)),
            groupAgentPolicy: rawPolicy === 'fullTools' ? 'fullTools' : 'refuse',
            clientSecretSecretKey: String(get<string>('clientSecretSecretKey', 'dingtalk.clientSecret') ?? 'dingtalk.clientSecret').trim(),
        };
    };

    /* ---------------- 桥接实例 ---------------- */

    const bridge = new DingTalkBridge({
        context: { ...context, logger } as PluginContext,
        config: readConfig,
    });

    /* ---------------- 状态栏 ---------------- */

    const statusBar = ui.createStatusBarItem({
        id: STATUS_BAR_ID,
        alignment: 'right',
        priority: 90,
    });

    const formatTime = (ts: number | null): string =>
        ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';

    const refreshStatusBar = (): void => {
        const status = bridge.getStatus();

        if (!status.running) {
            statusBar.text = '$(plug) 钉钉 未连接';
            statusBar.tooltip = status.lastError
                ? `DingTalk Bridge\n${status.lastError}`
                : 'DingTalk Bridge 未启动，请检查 AppKey / AppSecret';
            return;
        }

        const ws = status.socketConnected ? '●' : '○';
        statusBar.text = `${ws} 钉钉 ${status.sessionCount}`;
        statusBar.tooltip = [
            'DingTalk Bridge',
            `运行中：${status.running ? '是' : '否'}`,
            `WebSocket：${status.socketConnected ? '已连接' : '未连接'}`,
            `启动于：${formatTime(status.startedAt)}`,
            `最近消息：${formatTime(status.lastMessageAt)}`,
            `会话数：${status.sessionCount}`,
            ...(status.lastError ? [`最近错误：${status.lastError}`] : []),
            `日志：${logger.filePath()}`,
        ].join('\n');
    };

    statusBar.show();
    /* 点击状态栏直接弹状态：走已注册的 dingtalkBridge.status 命令 */
    statusBar.command = 'dingtalkBridge.status';
    refreshStatusBar();

    /* 状态栏定时刷新（会话数/连接态会变） */
    const statusTimer = setInterval(refreshStatusBar, 5000);

    /*
     * 定期终结卡住但连接未断的回合：先 stop 远端生成再本地收尾，
     * 避免 isRunning 永久为 true 把后续消息堵死。这是「stop/cancel 且可告知」的
     * 正确终结，不是旧式「删本地让远端继续跑」的危险 sweep。
     */
    const sweepTimer = setInterval(() => {
        const n = bridge.sweepStaleTurns();
        if (n > 0) logger.warn(`终结了 ${n} 个卡住的回合（已 stop 远端并通知用户）`);
    }, 60_000);

    /* ---------------- 命令 ---------------- */

    const disposables = [
        commands.register('dingtalkBridge.setSecret', async () => {
            const secret = await ui.showInputBox({ title: '设置钉钉 AppSecret', password: true,
                prompt: '仅写入系统加密存储，不写入插件普通设置。' });
            if (!secret) return;
            if (!await bridge.storeClientSecret(secret)) {
                ui.showNotification('密钥未保存：安全存储或迁移校验失败', { type: 'error' });
                return;
            }
            await requestStart(true);
            ui.showNotification('密钥已安全保存，连接状态请查看状态栏', { type: 'info' });
        }),
        commands.register('dingtalkBridge.status', async () => {
            refreshStatusBar();
            const status = bridge.getStatus();
            const lines = [
                '📊 DingTalk Bridge',
                `运行中：${status.running ? '是' : '否'}`,
                `WebSocket：${status.socketConnected ? '已连接' : '未连接'}`,
                `启动时间：${status.startedAt ? new Date(status.startedAt).toLocaleString('zh-CN') : '—'}`,
                `最近消息：${status.lastMessageAt ? new Date(status.lastMessageAt).toLocaleString('zh-CN') : '—'}`,
                `会话数：${status.sessionCount}`,
                ...(status.lastError ? [`最近错误：${status.lastError}`] : []),
            ];
            ui.showNotification(lines.join('\n'), { type: 'info', duration: 8000 });
            logger.info(lines.join(' | '));
        }),

        commands.register('dingtalkBridge.restart', async () => {
            logger.info('正在重连钉钉桥接…');
            await requestStart(true);
            refreshStatusBar();
            const status = bridge.getStatus();
            ui.showNotification(
                status.running ? '✅ 钉钉桥接已重连' : `⚠️ 重连失败：${status.lastError ?? '未知原因'}`,
                { type: status.running ? 'info' : 'warning' },
            );
        }),

        commands.register('dingtalkBridge.clearSessions', async () => {
            bridge.clearSessions();
            refreshStatusBar();
            ui.showNotification('已清空会话映射，下次消息会新建会话', { type: 'info' });
        }),

        commands.register('dingtalkBridge.testAlma', async () => {
            /* 探测 Alma 本地 API 与 WebSocket 是否可达，便于排查 */
            const config = readConfig();
            const status = bridge.getStatus();
            const lines = [
                '🔍 连通性自检',
                `Alma API：127.0.0.1:${config.almaApiPort}`,
                `WebSocket：${status.socketConnected ? '✅ 已连接' : '❌ 未连接'}`,
                status.lastError ? `最近错误：${status.lastError}` : '',
                '',
                `日志：${logger.filePath()}`,
                '',
                '提示：凭据与端口配置变化会自动重连，启动失败会退避重试。',
            ].filter(Boolean);
            ui.showNotification(lines.join('\n'), { type: 'info', duration: 8000 });
        }),
    ];

    /* ---------------- 工具（供 AI 主动发钉钉消息） ---------------- */

    const toolDisposable = context.tools.register('dingtalk_notify', {
        description:
            '通过钉钉给指定用户发送一条消息。需要插件已配置 AppKey/AppSecret，且你知道对方的 UnionID。',
        parameters: {
            type: 'object',
            properties: {
                unionId: { type: 'string', description: '钉钉用户的 UnionID（授权标识）' },
                message: { type: 'string', description: '要发送的文本内容' },
            },
            required: ['unionId', 'message'],
        } as const,
        /*
         * 第二个参数是宿主核验过的 ToolContext = { threadId, messageId, abortSignal? }。
         * 把 threadId 透传给 notify，使「禁用工具」线程里的主动发信也被拒绝（防绕过）。
         */
        execute: async (params: any, toolCtx: any) => {
            const { unionId, message } = params as { unionId: string; message: string };
            const threadId = typeof toolCtx?.threadId === 'string' ? toolCtx.threadId : undefined;
            const ok = await bridge.notify(unionId, message, threadId ? { threadId } : undefined);
            return ok.ok
                ? { success: true, message: `已发送给 ${unionId}` }
                : { success: false, error: ok.error || '发送失败，请检查凭据与 UnionID' };
        },
    });

    /*
     * 纵深防御（非安全边界）：注册宿主核验过的 tool.willExecute 钩子——
     * output.cancel = true 即取消工具，这是宿主强制执行机制，不是提示词约束。
     * 被「禁用工具」标记的线程里，任何工具调用都会被取消。
     *
     * 残余风险（已核验但无法从插件侧消除）：内部 WS generate_response 回合是否触发
     * 该钩子无法保证。正因如此，groupAgentPolicy 不再提供 noTools 作为安全选项
     * （旧配置里的 noTools 会被当作 refuse 处理），默认拒绝群 agent 回合。
     * 这里保留钩子作为尽力而为的纵深防御，不对其在内部 WS 路径生效作任何保证。
     */
    const willExecuteDisposable = context.events.on('tool.willExecute', (input: any, output: any) => {
        try {
            const threadId = input?.context?.threadId;
            if (typeof threadId === 'string' && bridge.isToolsDisabledForThread(threadId)) {
                output.cancel = true;
            }
        } catch {
            /* 钩子异常不能阻断宿主工具执行链 */
        }
    });

    /* ---------------- 事件 ---------------- */

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 2000;
    let lifecycle: Promise<void> = Promise.resolve();
    const requestStart = (restart = false): Promise<void> => {
        clearTimeout(retryTimer);
        lifecycle = lifecycle.catch(() => {}).then(async () => {
            if (disposed) return;
            if (!restart && bridge.getStatus().running) return;
            try {
                // 每次失败尝试都先释放旧连接，杜绝多个 Stream 客户端。
                await bridge.stop();
                await bridge.start();
                if (!bridge.getStatus().running) throw new Error('连接未就绪');
                retryDelay = 2000;
            } catch {
                logger.warn(`桥接未启动，${retryDelay}ms 后重试；请检查安全密钥与配置`);
                if (!disposed) {
                    retryTimer = setTimeout(() => { void requestStart(); }, retryDelay);
                    retryTimer.unref?.();
                    retryDelay = Math.min(retryDelay * 2, 60_000);
                }
            }
            refreshStatusBar();
        });
        return lifecycle;
    };
    const readyDisposable = context.events.on('app.ready', () => { void requestStart(); });
    void requestStart();

    const settingsDisposable = settings.onDidChange((e: any) => {
        if (typeof e?.key !== 'string' || !e.key.startsWith('dingtalkBridge.')) return;
        const reconnectKeys = ['clientId', 'clientSecret', 'clientSecretSecretKey', 'robotCode', 'almaApiPort'];
        if (reconnectKeys.some(k => e.key === `dingtalkBridge.${k}`)) {
            clearTimeout(changeTimer);
            changeTimer = setTimeout(() => { void requestStart(true); }, 300);
        }
        refreshStatusBar();
    });

    /* 离线测试探针：仅测试宿主会设置该环境变量 */
    if (process.env.ALMA_DT_SELFTEST === '1') {
        (globalThis as any).__dingtalkBridgeProbe = { bridge, readConfig, context };
        logger.info('测试探针已挂载');
    }

    logger.info('DingTalk Bridge 已激活');

    return {
        dispose: async () => {
            logger.info('DingTalk Bridge 正在卸载…');
            disposed = true;
            clearTimeout(retryTimer);
            clearTimeout(changeTimer);
            clearInterval(statusTimer);
            clearInterval(sweepTimer);
            for (const d of disposables) {
                try {
                    d.dispose();
                } catch {
                    /* noop */
                }
            }
            toolDisposable.dispose();
            willExecuteDisposable.dispose();
            readyDisposable.dispose();
            settingsDisposable.dispose();
            statusBar.dispose();
            await lifecycle.catch(() => {});
            await bridge.stop();
            logger.info('DingTalk Bridge 已卸载');
        },
    };
}
