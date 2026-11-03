import type { BridgeConfig, DingTalkRobotMessage } from './types';

type AuthorizationCommand = 'allow' | 'deny' | 'access';

interface AuthorizationSettings {
    get(key: string, fallback?: string): unknown;
    update(key: string, value: string): Promise<void>;
}

/** Only changes user/group allowlists; never changes administrators or group tool policy. */
export class AuthorizationCommands {
    private tail: Promise<void> = Promise.resolve();
    constructor(
        private readonly config: () => BridgeConfig,
        private readonly settings: AuthorizationSettings,
    ) {}

    static isCommand(command: string): command is AuthorizationCommand {
        return ['allow', 'deny', 'access'].includes(command);
    }

    static isCurrentGroupGrant(command: string, args: string): boolean {
        return command === 'allow' && /^(group|群|当前群)$/i.test(args.trim());
    }

    async run(command: AuthorizationCommand, args: string, actorId: string, payload: DingTalkRobotMessage): Promise<string> {
        const prior = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>(r => { release = r; });
        await prior;
        try {
            const config = this.config();
            if (!actorId || actorId !== payload.senderUnionId || actorId.startsWith('nick:') ||
                !config.allowedUnionIds.includes(actorId) || !config.adminUnionIds.includes(actorId)) {
                return '⛔ 授权管理仅限已加入用户白名单的管理员。';
            }
            const group = String(payload.conversationType) === '2';
            if (group && !config.allowedConversationIds.includes(payload.conversationId) &&
                !AuthorizationCommands.isCurrentGroupGrant(command, args)) {
                return '⛔ 此群未授权；管理员可先发送 /allow group 授权当前群。';
            }
            if (command === 'access') {
                if (args.trim()) return '用法：/access';
                return [
                    '🔐 当前授权配置',
                    `用户 UnionID：${config.allowedUnionIds.join(', ') || '无'}`,
                    `群：${config.allowedConversationIds.join(', ') || '无'}`,
                    `当前群：${group ? payload.conversationId : '非群聊'}`,
                    `群 agent：${config.groupAgentPolicy === 'fullTools' ? '已显式开放完整工具' : '默认拒绝生成'}`,
                    '管理员只能在本机配置；群授权不会自动开启工具。',
                ].join('\n');
            }
            const arg = args.trim();
            const targetGroup = /^(group|群|当前群)$/i.test(arg);
            let ids: string[];
            if (targetGroup) {
                if (!group || !payload.conversationId) return '⛔ 请在目标群内发送此命令，不能用私聊或群昵称指定群。';
                ids = [payload.conversationId];
            } else if (/^(?:union|user)\s+\S+$/i.test(arg)) {
                ids = [arg.replace(/^(?:union|user)\s+/i, '')];
            } else if (!arg) {
                // Never infer identity from visible @names or use dingtalkId as a UnionID.
                const mentions = (payload.atUsers ?? []).filter(u => !(
                    payload.chatbotUserId && u.dingtalkId === payload.chatbotUserId
                ));
                if (!mentions.length || mentions.some(u => !u.unionId)) {
                    return `⛔ 钉钉未提供被 @ 用户的真实 UnionID，未修改授权。请用 /${command} union <UnionID>；不会按昵称猜人。`;
                }
                ids = [...new Set(mentions.map(u => u.unionId!))];
            } else {
                return `用法：/${command} @用户、/${command} union <UnionID>、/${command} group（当前群）`;
            }
            if (ids.some(id => !id || id.startsWith('nick:') || !/^[A-Za-z0-9_$:+/=.-]{1,256}$/.test(id))) {
                return '⛔ 目标 ID 无效，未修改授权。';
            }
            if (!targetGroup && command === 'deny' && ids.some(id => config.adminUnionIds.includes(id))) {
                return '⛔ 管理员的访问权限请在本机调整，避免群命令误锁定管理员。';
            }
            const setting = targetGroup ? 'allowedConversationIds' : 'allowedUnionIds';
            const values = new Set(config[setting]);
            for (const id of ids) command === 'allow' ? values.add(id) : values.delete(id);
            const value = [...values].join(',');
            const key = `dingtalkBridge.${setting}`;
            if (value !== config[setting].join(',')) {
                await this.settings.update(key, value);
                if (this.settings.get(key, '') !== value) throw new Error('authorization persistence check failed');
            }
            return [
                `✅ 已${command === 'allow' ? '授权' : '撤销'}${targetGroup ? '当前群' : '用户'}：${ids.join(', ')}`,
                targetGroup ? '用户仍须单独进入白名单；群 agent 工具策略未改变。' : '这是全局用户白名单；群聊仍须通过群白名单和工具策略检查。',
            ].join('\n');
        } catch {
            return '❌ 授权保存未成功确认，请检查 settings:write 权限并用 /access 核实；未报告授权成功。';
        } finally { release(); }
    }
}
