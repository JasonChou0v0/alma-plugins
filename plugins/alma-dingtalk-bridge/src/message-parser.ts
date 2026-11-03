/**
 * 钉钉入站消息解析：正文提取、@ 提及、引用还原。不持有状态，状态由调用方通过 env 传入。
 */
import type { DingTalkRobotMessage } from './types';

export interface ParserEnv {
    msgCache: Map<string, { nick: string; text: string; at?: number }>;
    botName: string | undefined;
    botDingTalkId: string | undefined;
    robotName: () => string | undefined;
}

/** 优先读取事件携带的引用原文；缺失时才查询同会话缓存。 */
export function resolveQuotedMessage(payload: DingTalkRobotMessage, env: ParserEnv): { nick: string; text: string } | null {
    const reply = payload.text?.repliedMsg;
    const quotedText = reply?.content?.text;
    if (typeof quotedText === 'string' && quotedText.trim()) {
        // repliedMsg.senderId 不是显示名；不猜作者昵称，也不赋予引用内容指令权限。
        return { nick: '', text: quotedText };
    }

    const quotedId = payload.originalMsgId || reply?.msgId;
    if (quotedId) {
        const cached = env.msgCache.get(`${payload.conversationId}:${quotedId}`);
        if (cached) return { nick: cached.nick, text: cached.text };
    }

    return quotedId || reply || payload.text?.isReplyMsg || payload.content?.isReplyMsg
        ? { nick: '', text: '' }
        : null;
}

export function extractText(payload: DingTalkRobotMessage, env: ParserEnv): string {
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
    const mentioned = extractMentionedPeople(payload, env);

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
        const hasReply = Boolean(payload.originalMsgId || payload.text?.repliedMsg ||
            payload.text?.isReplyMsg || payload.content?.isReplyMsg);
        if (hasReply) return '[用户引用了一条消息并 @ 了你，但没有附带文字]';
        if (original.trim()) return original.trim();
        return '';
    }

    return cleaned;
}

/**
 * 提取被 @ 的其他人（排除机器人自己），供模型了解"在跟谁说话"。
 */
export function extractMentionedPeople(payload: DingTalkRobotMessage, env: ParserEnv): Array<{ name: string; dintalkId?: string }> {
    const botId = payload.chatbotUserId;
    const atUsers = payload.atUsers ?? [];

    /*
     * 机器人自己的昵称：钉钉不给，只能从场景推断。
     * 优先用配置的 robotName；否则取 atUsers 里 dingtalkId === chatbotUserId 那一项的 name。
     */
    let botName = env.botName || env.robotName() || undefined;
    if (!botName && botId) {
        const self = atUsers.find((u) => u.dingtalkId === botId && u.name);
        if (self?.name) botName = env.botName = self.name;
    }

    /*
     * 部分已观察消息的 atUsers 仅含机器人且缺少 name，不能据此概括所有场景。
     * 优先使用有名称的结构化提及，文本解析作为展示信息补充。
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
        if (env.botDingTalkId && name === env.botDingTalkId) continue;
        names.add(name);
    }

    return Array.from(names).map((name) => ({ name }));
}

