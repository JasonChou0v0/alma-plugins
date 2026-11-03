/**
 * 钉钉发送侧
 *
 * 回复用下游事件里的 sessionWebhook（两小时有效、单条限制 5000 字符）。
 * 主动发消息（心跳/通知）需要 appKey/appSecret 换 access_token，
 * 这里实现了 token 缓存与主动发送。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SendResult } from './types';
import type { OutboundImage } from './media';

export interface DingTalkLogger {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
}

/** 单条消息上限，留出余量 */
const MAX_CHUNK = 4000;
const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';

export class DingTalkClient {
    private token: string | null = null;
    private tokenExpiry = 0;

    constructor(
        private readonly credentials: () => { clientId: string; clientSecret: string; robotCode: string },
        private readonly logger: DingTalkLogger,
    ) {}

    /* ---------------- 归档 ---------------- */



    private archiveOutbound(record: Record<string, unknown>): void {
        try {
            const dir =
                process.platform === 'darwin'
                    ? path.join(os.homedir(), 'Library', 'Logs', 'Alma')
                    : path.join(os.tmpdir(), 'alma-logs');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const day = new Date().toISOString().slice(0, 10);
            const file = path.join(dir, `dingtalk-payloads-${day}.jsonl`);

            fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
            fs.chmodSync(file, 0o600);
        } catch {
            /* 归档失败不影响发送 */
        }
    }

    /* ---------------- 分段 ---------------- */

    clearToken(): void { this.token = null; this.tokenExpiry = 0; }

    /** consumed 是原始缓冲的字符数；补齐围栏的字符不计入发送游标。 */
    static chunkParts(text: string, limit = MAX_CHUNK): Array<{ text: string; consumed: number }> {
        if (!text) return [];
        if (limit < 32) throw new Error('chunk limit must be >= 32');
        const out: Array<{ text: string; consumed: number }> = [];
        let buffer = '', consumed = 0, fence = '', opener = '';
        const emit = () => {
            if (!consumed) return;
            out.push({ text: buffer + (fence ? `\n${fence}` : ''), consumed });
            buffer = fence ? opener + '\n' : '';
            consumed = 0;
        };
        for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
            const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
            if (marker && (marker[1].length > 100 || marker[0].length > limit / 2)) throw new Error('代码围栏标记过长，拒绝不安全切分');
            let offset = 0;
            while (offset < line.length) {
                const reserve = Math.max(fence ? fence.length + 1 : 0, marker ? marker[1].length + 1 : 0);
                const room = limit - buffer.length - reserve;
                if (room <= 0) { emit(); continue; }
                let count = Math.min(room, line.length - offset);
                if (offset === 0 && line.length > room && consumed && line.length < limit - 128) {
                    emit(); continue;
                }
                // 避免切开 UTF-16 代理对。
                if (count < line.length - offset && /[\uD800-\uDBFF]/.test(line[offset + count - 1])) count--;
                if (!count) { emit(); continue; }
                buffer += line.slice(offset, offset + count);
                consumed += count;
                offset += count;
                if (offset === line.length && marker) {
                    if (!fence) { fence = marker[1]; opener = marker[0].trim().slice(0, 100); }
                    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
                        fence = ''; opener = '';
                    }
                }
                if (offset < line.length) emit();
            }
        }
        emit();
        return out;
    }

    static chunk(text: string, limit = MAX_CHUNK): string[] {
        return this.chunkParts(text, limit).map(p => p.text);
    }

    /* ---------------- webhook 回复 ---------------- */

    /**
     * 剥掉模型擅自复述的系统提示片段。
     *
     * 现象：部分模型会把系统提示里的格式规则当成正文输出，
     * 例如末尾多出 "## Response Guidelines\n- Be clear and concise..."。
     * 这里做兜底清洗，避免污染真正的回答。
     */
    static stripLeakedPrompt(text: string): string {
        /*
         * 模型可能用多种写法复述提示词标题：
         *   ## Response Guidelines
         *   **Response Guidelines**
         *   Response Guidelines:
         *   ### 回复要求
         * 统一按「去掉修饰符后的裸标题」匹配，避免漏网。
         */
        const LEAK_TITLES = [
            'response guidelines',
            'response format',
            'response formatting',
            'guidelines',
            'formatting guidelines',
            'output format',
            'capability notes',
            'capabilities',
            '回复要求',
            '格式要求',
            '输出格式',
            '能力说明',
        ];

        const normalizeTitle = (line: string): string =>
            line
                /* 去掉标题井号、粗体星号、引用符、列表符 */
                .replace(/^[\s>\-*_#]+/, '')
                .replace(/[\s*_#:：]+$/, '')
                .replace(/^\*\*|\*\*$/g, '')
                .trim()
                .toLowerCase();

        const isLeak = (line: string): boolean => {
            const t = normalizeTitle(line);
            if (!t) return false;
            /* 完全等于已知标题，或形如 "response guidelines" 的近似 */
            return LEAK_TITLES.some((known) => t === known || t === `${known}:`);
        };

        const lines = text.split('\n');

        /*
         * 泄漏块可能出现在开头、中间或结尾。
         * 逐段扫描：命中泄漏标题后，跳过它后面的列表项/说明行，
         * 直到遇到空行或正常正文，再继续收集。这样开头/中间/结尾都能处理。
         */
        const out: string[] = [];
        let skipping = false;

        for (const line of lines) {
            if (isLeak(line)) {
                skipping = true;
                continue;
            }

            if (skipping) {
                const trimmed = line.trim();
                const isLeakBody =
                    trimmed === '' ||
                    /^[-*+]\s+/.test(trimmed) ||   /* 列表项 */
                    /^\d+[.)]\s+/.test(trimmed) || /* 有序列表 */
                    trimmed.startsWith('>');        /* 引用 */

                if (isLeakBody) {
                    /* 空行结束泄漏块 */
                    if (trimmed === '') skipping = false;
                    continue;
                }
                skipping = false;
            }

            out.push(line);
        }

        const result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

        /* 若整段都是泄漏，返回空让调用方兜底，不要退回原文 */
        return result;
    }

    /**
     * 把模型输出的 Markdown 适配成钉钉能渲染的子集。
     *
     * 钉钉 markdown 只支持：标题(#### 起)、粗体、斜体、链接、图片、列表、引用、行内代码、代码块。
     * 不支持：表格(很弱)、# 一级/二级标题、分隔线、HTML。
     * 所以要降级处理，否则会原样显示 ** 这种符号。
     */
    static toDingTalkMarkdown(text: string): string {
        const blocks = text.split(/(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})[ \t]*$)/gm);
        return blocks.map((block, i) => i % 2 ? block : (block.trim() ? this.formatProse(block) : block)).join('') || '（没有返回有效内容，请重试）';
    }

    private static formatProse(text: string): string {
        let out = DingTalkClient.stripLeakedPrompt(text);

        /* ATX 标题 -> 钉钉支持 #### 起的标题 */
        out = out.replace(/^\s{0,3}#{1,3}\s+(.+)$/gm, '#### $1');
        out = out.replace(/^\s{0,3}#{4,6}\s+(.+)$/gm, '#### $1');

        /* 分隔线 -> 空行 */
        out = out.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, '');

        /* 任务列表 -> 普通列表 */
        out = out.replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, '- ');

        /* HTML 标签直接剥掉 */
        out = out.replace(/<\/?[a-zA-Z][^>]*>/g, '');

        /* 多余空行压缩 */
        out = out.replace(/\n{3,}/g, '\n\n');

        out = out.trim();

        /* 模型只吐了提示词时，给个兜底，避免发空消息 */
        return out || '（没有返回有效内容，请重试）';
    }

    /** 生成钉钉 markdown 消息所需的标题（必填，取首行纯文本） */
    static deriveTitle(text: string): string {
        const firstLine = text
            .split('\n')
            .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
            .find((l) => l.length > 0);

        const title = (firstLine || 'Alma').slice(0, 30);
        return title || 'Alma';
    }

    /**
     * 通过 sessionWebhook 回复（最常用，无需 token）。
     *
     * 默认走 markdown，钉钉才会渲染粗体/代码块/列表；
     * 走 text 的话 **bold** 会原样显示成星号。
     */
    async replyWebhook(webhook: string, text: string, title?: string): Promise<SendResult> {
        if (!webhook) return { ok: false, error: '缺少 sessionWebhook' };

        const markdown = DingTalkClient.toDingTalkMarkdown(text);
        const payload = {
            msgtype: 'markdown',
            markdown: {
                title: title || DingTalkClient.deriveTitle(markdown),
                text: markdown,
            },
        };

        /* 出站消息也归档，与入站一一对应，便于排查"发了什么" */
        this.archiveOutbound({ direction: 'out', target: 'webhook', payload });

        try {
            const res = await fetch(webhook, {
                method: 'POST',
                signal: AbortSignal.timeout(20_000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const body = await res.text().catch(() => '');

            /* 钉钉即使 HTTP 200 也可能返回 errcode */
            if (!res.ok) {
                this.logger.warn('webhook 回复 HTTP 失败', res.status, body.slice(0, 200));
                return { ok: false, error: `HTTP ${res.status}` };
            }
            const errcode = /"errcode"\s*:\s*(\d+)/.exec(body)?.[1];
            if (errcode && errcode !== '0') {
                this.logger.warn('webhook 回复 errcode', errcode, body.slice(0, 200));
                return { ok: false, error: `errcode ${errcode}` };
            }
            return { ok: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            this.logger.warn('webhook 回复异常', error);
            return { ok: false, error };
        }
    }

    /* ---------------- 主动发送 ---------------- */

    private async getAccessToken(): Promise<string | null> {
        const { clientId, clientSecret } = this.credentials();
        if (!clientId || !clientSecret) return null;

        const now = Date.now();
        if (this.token && now < this.tokenExpiry - 60_000) return this.token;

        try {
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                signal: AbortSignal.timeout(20_000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
            });
            if (!res.ok) {
                this.logger.warn('获取 accessToken 失败', res.status);
                return null;
            }
            const data = (await res.json()) as { accessToken?: string; expireIn?: number };
            if (!data?.accessToken) return null;

            this.token = data.accessToken;
            this.tokenExpiry = now + (data.expireIn ?? 7200) * 1000;
            return this.token;
        } catch (e) {
            this.logger.warn('获取 accessToken 异常', e);
            return null;
        }
    }

    /** Upload image media and send with the existing bot identity; never fall back to another recipient. */
    async sendImage(
        target: { conversationId?: string; staffId?: string }, image: OutboundImage,
        authorized: () => boolean,
    ): Promise<SendResult> {
        if (Boolean(target.conversationId) === Boolean(target.staffId)) return { ok: false, error: '图片目标无效' };
        if (!authorized()) return { ok: false, error: '图片目标或发送人已取消授权' };
        const token = await this.getAccessToken();
        if (!token) return { ok: false, error: '图片上传凭据不可用' };
        try {
            const form = new FormData();
            form.set('media', new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }), image.filename);
            const upload = await fetch(`https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}&type=image`, {
                method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(30_000),
            });
            const media: any = await upload.json().catch(() => null);
            if (!upload.ok || media?.errcode !== 0 || typeof media?.media_id !== 'string' || !media.media_id) {
                return { ok: false, error: `钉钉图片上传失败（HTTP ${upload.status}）` };
            }
            if (!authorized()) return { ok: false, error: '图片上传后授权已变更，未发送' };
            const { robotCode } = this.credentials();
            const payload = {
                robotCode, msgKey: 'sampleImageMsg', msgParam: JSON.stringify({ photoURL: media.media_id }),
                ...(target.conversationId ? { openConversationId: target.conversationId } : { userIds: [target.staffId] }),
            };
            const sent = await fetch(target.conversationId ? GROUP_SEND_URL : SEND_URL, {
                method: 'POST', signal: AbortSignal.timeout(20_000), redirect: 'error',
                headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
                body: JSON.stringify(payload),
            });
            const receipt: any = await sent.json().catch(() => null);
            if (!sent.ok || (receipt?.errcode != null && receipt.errcode !== 0) || receipt?.code ||
                typeof receipt?.processQueryKey !== 'string' || !receipt.processQueryKey ||
                receipt?.invalidUserIdList?.length || receipt?.invalidStaffIdList?.length || receipt?.flowControlledStaffIdList?.length) {
                return { ok: false, error: `钉钉图片发送未成功确认（HTTP ${sent.status}）` };
            }
            this.logger.info('钉钉图片发送已获成功回执');
            return { ok: true };
        } catch {
            // Never echo fetch errors: upload URLs carry access tokens. Do not retry an uncertain send.
            return { ok: false, error: '图片上传或发送异常，未自动重试，请核对钉钉是否收到' };
        }
    }

    /** UnionID is the authorization identity; userId is resolved only as a delivery address. */
    async sendToUnionUser(unionId: string, text: string, authorized: () => boolean): Promise<SendResult> {
        if (!authorized()) return { ok: false, error: 'UnionID 未授权' };
        const token = await this.getAccessToken();
        if (!token) return { ok: false, error: '未配置凭据或 token 获取失败' };
        try {
            const res = await fetch(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(token)}`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unionid: unionId }),
            });
            const data: any = await res.json().catch(() => null);
            if (!res.ok || data?.errcode !== 0 || typeof data?.result?.userid !== 'string' || !data.result.userid) {
                return { ok: false, error: '无法为该 UnionID 解析企业内投递地址；跨组织用户请在原会话互动，或检查成员信息读权限' };
            }
            if (!authorized()) return { ok: false, error: '投递前 UnionID 授权已撤销' };
            return await this.sendToUser(data.result.userid, text);
        } catch {
            return { ok: false, error: 'UnionID 投递地址解析或消息发送失败' };
        }
    }

    /** 主动发单聊消息（仅接收已完成 UnionID 鉴权后的投递地址） */
    async sendToUser(staffId: string, text: string): Promise<SendResult> {
        const { robotCode } = this.credentials();
        const token = await this.getAccessToken();
        if (!token) return { ok: false, error: '未配置凭据或 token 获取失败' };

        try {
            const res = await fetch(SEND_URL, {
                method: 'POST',
                signal: AbortSignal.timeout(20_000),
                headers: {
                    'Content-Type': 'application/json',
                    'x-acs-dingtalk-access-token': token,
                },
                body: JSON.stringify({
                    robotCode,
                    userIds: [staffId],
                    msgKey: 'sampleText',
                    msgParam: JSON.stringify({ content: text }),
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 160)}` };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    /** 主动发群消息（需要 openConversationId） */
    async sendToGroup(conversationId: string, text: string): Promise<SendResult> {
        const { robotCode } = this.credentials();
        const token = await this.getAccessToken();
        if (!token) return { ok: false, error: '未配置凭据或 token 获取失败' };

        try {
            const res = await fetch(GROUP_SEND_URL, {
                method: 'POST',
                signal: AbortSignal.timeout(20_000),
                headers: {
                    'Content-Type': 'application/json',
                    'x-acs-dingtalk-access-token': token,
                },
                body: JSON.stringify({
                    robotCode,
                    openConversationId: conversationId,
                    msgKey: 'sampleText',
                    msgParam: JSON.stringify({ content: text }),
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 160)}` };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
}
