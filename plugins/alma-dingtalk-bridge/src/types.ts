/**
 * 共享类型定义
 */

export interface BridgeConfig {
    almaApiPort: number;
    clientId: string;
    clientSecret: string;
    robotCode: string;
    /** 机器人自己的昵称，用于从 @ 列表排除自己 */
    robotName: string;
    defaultModel: string;
    workspaceId: string;
    mode: SessionMode;
    allowedUnionIds: string[];
    /**
     * 群白名单：仅这些 conversationId 的群聊（conversationType=2）被允许。
     * 空则拒绝所有群聊。单聊（conversationType=1）不受此约束，仍由 allowedUnionIds 约束。
     */
    allowedConversationIds: string[];
    /**
     * 管理员 UnionID：仅这些显式 UnionID 能执行管理命令。
     * 空则无人可用这两个命令；不把 allowedUnionIds 隐式当作管理员。
     * 仍受 allowedUnionIds 与 allowedConversationIds 约束（入站鉴权里已完成）。
     */
    adminUnionIds: string[];
    streamingReply: boolean;
    replyOnToolUse: boolean;
    /** 记录完整原始载荷，用于排查字段名 */
    logRawPayload: boolean;
    /** 原始载荷归档保留天数，默认 7 */
    rawPayloadRetentionDays?: number;
    /**
     * 群聊（conversationType=2）里是否允许驱动带工具的 agent 回合。
     * - refuse（默认）：拒绝群 agent 任务并解释，不提交 generate_response——唯一安全选项
     * - fullTools：允许群回合并保留工具（管理员明确接受风险）
     *
     * 曾经的 noTools 已移除：它依赖宿主 tool.willExecute 钩子取消工具，而该钩子在内部
     * WS generate_response 回合是否触发无法从插件侧确认，故不当作安全选项。readConfig
     * 会把旧配置里的 noTools 映射为 refuse。tool.willExecute 钩子仍作为不可靠的纵深防御
     * 注册，但不保证生效、不作为安全边界。
     */
    groupAgentPolicy: GroupAgentPolicy;
    /**
     * 从 context.storage.secrets 读取 clientSecret 的键名。
     * 留空使用 dingtalk.clientSecret；不允许回退明文设置。
     */
    clientSecretSecretKey: string;
}

/**
 * noTools 保留在联合类型里仅用于识别并迁移旧配置（→ refuse），不再作为可选安全策略。
 */
export type GroupAgentPolicy = 'refuse' | 'noTools' | 'fullTools';

export type SessionMode = 'per-chat' | 'per-sender' | 'single';

export interface SessionRecord {
    threadId: string;
    createdAt: number;
    title?: string;
}

export interface TurnAttachment {
    url: string;
    mediaType: string;
    filename?: string;
}

export interface TurnState {
    /** Explicit file parts from assistant messages belonging to this turn. */
    attachments?: TurnAttachment[];
    assistantMessageIds?: Set<string>;
    attachmentOverflow?: boolean;
    conversationType?: string;
    threadId: string;
    chatId: string;
    webhook: string;
    senderId: string;
    /** 原事件中的投递地址，绝不用于鉴权。 */
    senderStaffId?: string;
    /** 累积的文本 */
    text: string;
    /** 本回合调用过的工具名 */
    tools: string[];
    /** 已推送过提示的工具名，避免重复提示 */
    announcedTools: string[];
    startedAt: number;
    lastActivity: number;
    finished: boolean;
    assistantMessageId?: string;
    lastToolOutput?: string;
    flushTimer?: ReturnType<typeof setTimeout>;
    flushStartedAt?: number;
    flushedChars?: number;
    streamed?: boolean;
    /** 已推送的流式分段数，用于限流 */
    flushCount?: number;
    /** 本轮是否已发过「正在处理」提示 */
    toolNoticeSent?: boolean;
    stopRequested?: boolean;
    settled?: () => void;
    flushInFlight?: Promise<void>;
    deliveryFailed?: boolean;
    /** 群回合且策略为 noTools 时置位，供 tool.willExecute 钩子取消工具 */
    toolsDisabled?: boolean;
}

export interface AlmaThread {
    id: string;
    title: string;
    model: string | null;
    workspaceId: string | null;
}

export interface AlmaWorkspace {
    id: string;
    name: string;
    path?: string;
}

/** 推送目标（sessionWebhook 或主动发送） */
export interface DingTalkTarget {
    webhook?: string;
    conversationId?: string;
    senderStaffId?: string;
}

export interface SendResult {
    ok: boolean;
    error?: string;
}

/** 钉钉下游事件里的机器消息体 */
export interface DingTalkRobotMessage {
    senderCorpId?: string;
    chatbotCorpId?: string;
    conversationId: string;
    conversationType: string;
    conversationTitle?: string;
    senderStaffId?: string;
    senderUnionId?: string;
    senderId?: string;
    senderNick?: string;
    msgId: string;
    msgtype: string;
    text?: {
        content: string;
        isReplyMsg?: boolean;
        repliedMsg?: {
            createdAt?: number;
            senderId?: string;
            msgType?: string;
            msgId?: string;
            content?: { text?: string };
        };
    };
    content?: { richText?: string; downloadCode?: string; isReplyMsg?: boolean };
    /** 被 @ 的人列表 */
    atUsers?: Array<{ dingtalkId?: string; unionId?: string; name?: string }>;
    /** 被引用消息 ID（正文优先读取 text.repliedMsg） */
    originalMsgId?: string;
    /** 机器人自身 openId，用于判断是否被 @ */
    chatbotUserId?: string;
    sessionWebhook: string;
    sessionWebhookExpiredTime: number;
    robotCode: string;
    /** 机器人自己的昵称，用于从 @ 列表排除自己 */
    robotName: string;
    createAt?: number;
}
