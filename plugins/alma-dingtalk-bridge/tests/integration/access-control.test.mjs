/**
 * 访问控制回归测试：直接构造 DingTalkBridge，调用生产实现（handleIncoming / notify），
 * 不复刻鉴权逻辑、不假造完成计数。
 *
 * 覆盖：
 *  - 用户白名单 allowedUnionIds 为空 → 拒绝；用户不在白名单 → 拒绝
 *  - nick: 占位 ID（如 nick:永）永不可授权，即便被写进白名单
 *  - 群白名单 allowedConversationIds：群聊必须在名单内，空则拒绝所有群；单聊不受此约束
 *  - /use、/new 仅显式 adminUnionIds 可用，且仍受用户/群白名单约束
 *  - notify 只允许白名单真实收件人，空名单拒绝，nick: 拒绝，避免 send helper 旁路
 *
 * 不连真 Alma、不启动真实 agent（socket.submit 桩为空操作）、不真实发信
 * （全局 fetch 桩 + replyWebhook 捕获）。跑法：bun tests/integration/access-control.test.mjs
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../helpers/context.mjs';
import { DingTalkBridge } from '../../src/bridge.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

/* ---------------- 全局 fetch 桩：拦截所有真实出站 ---------------- */
const realFetch = globalThis.fetch;
const fetchLog = [];
const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    fetchLog.push(`${method} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
    if (u.includes('oauth2/accessToken')) return json({ accessToken: 'fake-token', expireIn: 7200 });
    if (u.includes('/topapi/user/getbyunionid')) return json({ errcode: 0, result: { userid: 'delivery-user' } });
    if (u.endsWith('/api/threads') && method === 'GET') return json([{ id: 'thread-fake' }]);
    if (u.endsWith('/api/threads') && method === 'POST')
        return json({ id: 'thread-fake', title: 't', model: 'fake:fake', workspaceId: 'ws-fake' });
    if (u.endsWith('/api/workspaces')) return json([{ id: 'ws-fake', name: 'Fake' }]);
    if (u.endsWith('/api/settings'))
        return json({ chat: { defaultModel: 'fake:fake' }, general: { defaultWorkspaceId: 'ws-fake' } });
    if (u.includes('/robot/oToMessages/batchSend') || u.includes('/robot/groupMessages/send'))
        return json({ processQueryKey: 'fixture-receipt' });
    return json({ errcode: 0, errmsg: 'ok' });
};

function baseConfig(over = {}) {
    return () => ({
        almaApiPort: 23001,
        clientId: 'fake-appkey',
        clientSecret: 'fake-secret',
        robotCode: 'fake-robot',
        robotName: '豆豆',
        defaultModel: 'fake:fake',
        workspaceId: 'ws-fake',
        mode: 'per-chat',
        allowedUnionIds: ['staff_a', 'staff_b'],
        allowedConversationIds: ['cid_group_ok'],
        adminUnionIds: ['staff_a'],
        streamingReply: false,
        replyOnToolUse: false,
        logRawPayload: false,
        groupAgentPolicy: 'fullTools',
        clientSecretSecretKey: '',
        ...over,
    });
}

let seq = 0;
function downstream(text, over = {}) {
    seq += 1;
    const data = {
        conversationId: over.conversationId ?? 'cid_group_ok',
        conversationType: over.conversationType ?? '2',
        senderUnionId: over.senderUnionId ?? 'staff_a',
        senderNick: over.senderNick ?? 'A',
        msgId: over.msgId ?? `msg_${Date.now()}_${seq}`,
        msgtype: 'text',
        text: { content: text },
        sessionWebhook: 'http://127.0.0.1/wh/fake',
        sessionWebhookExpiredTime: Date.now() + 3_600_000,
        robotCode: 'fake',
        chatbotUserId: '$:BOTID',
    };
    if (over.senderId !== undefined) data.senderId = over.senderId;
    /* 用 null 表示显式去掉 senderUnionId，触发 nick: 兜底 */
    if (over.senderUnionId === null) delete data.senderUnionId;
    return {
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: `m${seq}` },
        data: JSON.stringify(data),
    };
}

function makeBridge(configOver = {}) {
    const { context } = createContext({ root: ROOT, quiet: true });
    const bridge = new DingTalkBridge({ context, config: baseConfig(configOver) });
    bridge.secretClientSecret = 'fake-secret';
    /* 捕获 webhook 回复，不真实出站 */
    const replies = [];
    bridge.dingtalk.replyWebhook = async (_w, t) => {
        replies.push(t);
        return { ok: true };
    };
    /* 捕获提交给 agent 的回合，不启动真实 WS / agent */
    const submits = [];
    bridge.socket.submit = async function (turn, model, text, sender) {
        submits.push({ threadId: turn.threadId, model, text, sender });
        this.turns.set(turn.threadId, turn);
        this.dispatch({ type: 'generation_completed', data: { threadId: turn.threadId } });
    }.bind(bridge.socket);
    return { bridge, replies, submits };
}

const sentBatchSend = () => fetchLog.some((u) => u.includes('batchSend'));

try {
    /* ============================================================ */
    console.log('\n[A] 入站用户白名单');
    {
        /* A1：allowedUnionIds 为空 → 拒绝，不提交 agent */
        const { bridge, replies, submits } = makeBridge({ allowedUnionIds: [] });
        await bridge.handleIncoming(downstream('hi', { senderUnionId: 'staff_a' }));
        check('空白名单拒绝', replies.some((t) => /未配置用户白名单|未开放/.test(t)), JSON.stringify(replies));
        check('空白名单不提交 agent', submits.length === 0, `submits=${submits.length}`);

        /* A2：nick:永 占位 ID 永不可授权（即便把 nick:永 写进白名单也拒） */
        const { bridge: b2, replies: r2, submits: s2 } = makeBridge({
            allowedUnionIds: ['nick:永', 'staff_a'],
        });
        await b2.handleIncoming(downstream('hi', { senderUnionId: null, senderNick: '永' }));
        check('nick:永 被拒绝', r2.some((t) => /无法核实身份|已拒绝/.test(t)), JSON.stringify(r2));
        check('nick:永 不提交 agent', s2.length === 0, `submits=${s2.length}`);

        /* A3：用户不在白名单 → 拒绝 */
        const { bridge: b3, replies: r3, submits: s3 } = makeBridge();
        await b3.handleIncoming(downstream('hi', { senderUnionId: 'staff_evil' }));
        check('未授权用户被拒', r3.some((t) => /没有使用.*权限/.test(t)), JSON.stringify(r3));
        check('未授权不提交 agent', s3.length === 0, `submits=${s3.length}`);

        /* A4：授权用户单聊（conversationType=1）在群白名单为空时仍可进入 */
        const { bridge: b4, submits: s4, replies: r4 } = makeBridge({ allowedConversationIds: [] });
        await b4.handleIncoming(downstream('hi', { senderUnionId: 'staff_a', conversationType: '1' }));
        check('授权单聊进入处理（不受群白名单约束）', s4.length === 1, `submits=${s4.length} replies=${JSON.stringify(r4).slice(0, 100)}`);
    }

    /* ============================================================ */
    console.log('\n[B] 入站群白名单');
    {
        /* B1：群白名单为空 → 群聊被拒 */
        const { bridge, replies, submits } = makeBridge({ allowedConversationIds: [] });
        await bridge.handleIncoming(
            downstream('hi', { senderUnionId: 'staff_a', conversationType: '2', conversationId: 'cid_group_ok' }),
        );
        check('空群白名单拒绝群聊', replies.some((t) => /群白名单|群聊未开放/.test(t)), JSON.stringify(replies));
        check('空群白名单不提交 agent', submits.length === 0, `submits=${submits.length}`);

        /* B2：群不在白名单 → 拒绝 */
        const { bridge: b2, replies: r2, submits: s2 } = makeBridge();
        await b2.handleIncoming(
            downstream('hi', { senderUnionId: 'staff_a', conversationType: '2', conversationId: 'cid_group_other' }),
        );
        check('未授权群被拒', r2.some((t) => /未在白名单/.test(t)), JSON.stringify(r2));
        check('未授权群不提交 agent', s2.length === 0, `submits=${s2.length}`);

        /* B3：授权用户 + 授权群 → 进入处理 */
        const { bridge: b3, submits: s3, replies: r3 } = makeBridge();
        await b3.handleIncoming(
            downstream('hi', { senderUnionId: 'staff_a', conversationType: '2', conversationId: 'cid_group_ok' }),
        );
        check('授权群进入处理', s3.length === 1, `submits=${s3.length} replies=${JSON.stringify(r3).slice(0, 100)}`);
    }

    /* ============================================================ */
    console.log('\n[C] 命令管理员鉴权（/use、/new）');
    {
        /* C1：非管理员 /use → 拒绝，不切工作区 */
        const { bridge, replies } = makeBridge({ adminUnionIds: ['staff_a'] });
        await bridge.handleIncoming(downstream('/use ws-fake', { senderUnionId: 'staff_b', conversationType: '1' }));
        check('非管理员 /use 被拒', replies.some((t) => /仅限管理员/.test(t)), JSON.stringify(replies));
        check(
            '非管理员 /use 不切工作区',
            !Object.values(bridge.workspaceOverrides).includes('ws-fake'),
            JSON.stringify(bridge.workspaceOverrides),
        );

        /* C2：管理员 /use → 进入（切工作区） */
        const { bridge: b2, replies: r2 } = makeBridge({ adminUnionIds: ['staff_a'] });
        await b2.handleIncoming(downstream('/use ws-fake', { senderUnionId: 'staff_a', conversationType: '1' }));
        check('管理员 /use 成功', r2.some((t) => /已切换/.test(t)), JSON.stringify(r2));
        check(
            '管理员 /use 记录覆盖',
            Object.values(b2.workspaceOverrides).includes('ws-fake'),
            JSON.stringify(b2.workspaceOverrides),
        );

        /* C3：adminUnionIds 为空 → 无人能 /new */
        const { bridge: b3, replies: r3 } = makeBridge({ adminUnionIds: [] });
        await b3.handleIncoming(downstream('/new 标题', { senderUnionId: 'staff_a', conversationType: '1' }));
        check('空 adminUnionIds 时 /new 被拒', r3.some((t) => /仅限管理员/.test(t)), JSON.stringify(r3));

        /* C4：管理员 /new → 进入（建会话） */
        const { bridge: b4, replies: r4 } = makeBridge({ adminUnionIds: ['staff_a'] });
        await b4.handleIncoming(downstream('/new 标题', { senderUnionId: 'staff_a', conversationType: '1' }));
        check('管理员 /new 成功', r4.some((t) => /已新建会话/.test(t)), JSON.stringify(r4));

        /* C5：管理员但不在用户白名单 → 入站即被拒（受用户白名单约束） */
        const { bridge: b5, replies: r5 } = makeBridge({
            allowedUnionIds: ['staff_a'],
            adminUnionIds: ['staff_admin'],
        });
        await b5.handleIncoming(downstream('/use ws-fake', { senderUnionId: 'staff_admin', conversationType: '1' }));
        check('管理员不在用户白名单仍被拒', r5.some((t) => /没有使用.*权限/.test(t)), JSON.stringify(r5));

        /* C6：管理员在未授权群里 /use → 被群白名单拦截（受群白名单约束） */
        const { bridge: b6, replies: r6 } = makeBridge({ adminUnionIds: ['staff_a'] });
        await b6.handleIncoming(
            downstream('/use ws-fake', {
                senderUnionId: 'staff_a',
                conversationType: '2',
                conversationId: 'cid_group_other',
            }),
        );
        check('管理员在未授权群 /use 被群白名单拦', r6.some((t) => /未在白名单/.test(t)), JSON.stringify(r6));
    }

    /* ============================================================ */
    console.log('\n[D] notify 白名单与防旁路');
    {
        /* D1：空白名单 → 拒绝 */
        const b1 = makeBridge({ allowedUnionIds: [] }).bridge;
        const r1 = await b1.notify('staff_a', 'hi');
        check('空 notify 白名单拒绝', r1.ok === false, JSON.stringify(r1));

        const { bridge } = makeBridge({ allowedUnionIds: ['staff_a', 'staff_b'] });

        /* D2：nick: 收件人 → 拒绝，不出站 */
        fetchLog.length = 0;
        const r2 = await bridge.notify('nick:永', 'hi');
        check('nick: 收件人被拒', r2.ok === false && /nick/.test(r2.error ?? ''), JSON.stringify(r2));
        check('nick: 拒绝不出站', !sentBatchSend(), `fetch=${fetchLog}`);

        /* D3：未授权收件人 → 拒绝，不出站 */
        fetchLog.length = 0;
        const r3 = await bridge.notify('staff_evil', 'hi');
        check('未授权收件人被拒', r3.ok === false, JSON.stringify(r3));
        check('未授权拒绝不出站', !sentBatchSend(), `fetch=${fetchLog}`);

        /* D4：授权 + 非禁用 → 真实 sendToUnionUser（fetch 桩成功） */
        fetchLog.length = 0;
        const r4 = await bridge.notify('staff_a', 'hi');
        check('授权收件人发送成功', r4.ok === true, JSON.stringify(r4));
        check('发送触发出站', sentBatchSend() || fetchLog.some((u) => u.includes('accessToken')), `fetch=${fetchLog}`);

        /* D5：禁用工具线程里发信被拒（防绕过保留） */
        bridge.toolsDisabledThreads.add('thread-dis');
        const r5 = await bridge.notify('staff_a', 'hi', { threadId: 'thread-dis' });
        check('禁用线程里发信被拒', r5.ok === false && /禁用/.test(r5.error ?? ''), JSON.stringify(r5));
    }
} finally {
    /* 清理：还原 fetch，绝不留全局桩 */
    globalThis.fetch = realFetch;
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
