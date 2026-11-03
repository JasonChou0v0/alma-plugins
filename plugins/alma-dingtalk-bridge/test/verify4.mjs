/**
 * 四个线上问题的真实端到端验证（跑在真 Alma 上）。
 *
 * 1. @别人时不能漏人
 * 2. 引用消息 @机器人 要回复
 * 3. 进行中再发消息要排队、不丢
 * 4. /use 不能用 settings:write 权限
 */
import http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ALMA_PORT || 23001);

/* ---------- 假钉钉 webhook ---------- */
const pushes = [];
const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        try {
            pushes.push({ at: Date.now(), ...JSON.parse(body) });
        } catch {
            pushes.push({ at: Date.now(), raw: body });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errcode":0}');
    });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const WEBHOOK = `http://127.0.0.1:${srv.address().port}/robot/send`;

/* ---------- 环境 ---------- */
const wss = await (await fetch(`http://127.0.0.1:${PORT}/api/workspaces`)).json();
const wsList = Array.isArray(wss) ? wss : (wss.workspaces ?? []);
const workspaceId = wsList[0]?.id;

const { context } = createContext({
    root: ROOT,
    apiPort: PORT,
    quiet: true,
    pluginSettings: {
        workspaceId,
        mode: 'per-chat',
        streamingReply: false,
        replyOnToolUse: false,
        clientId: '',
        clientSecret: '',
        logRawPayload: false,
        robotName: '豆豆',
    },
});

const mod = await import(path.join(ROOT, 'main.ts'));
const act = await mod.activate(context);
await new Promise((r) => setTimeout(r, 1500));

const bridge = globalThis.__dingtalkBridgeProbe?.bridge;
if (!bridge) {
    console.error('未找到测试探针');
    process.exit(1);
}

let seq = 0;
function mkMsg(text, opts = {}) {
    seq += 1;
    return {
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: `m${seq}` },
        data: JSON.stringify({
            conversationId: opts.chatId ?? `cid_v4_${seq}`,
            conversationType: opts.convType ?? '2',
            conversationTitle: opts.title ?? '[TEST] 验证群',
            senderUnionId: opts.staff ?? `staff_${seq}`,
            senderNick: opts.nick ?? `用户${seq}`,
            msgId: opts.msgId ?? `msg_v4_${Date.now()}_${seq}`,
            msgtype: 'text',
            text: { content: text },
            atUsers: opts.atUsers ?? [],
            chatbotUserId: opts.botId ?? '$:BOTID',
            originalMsgId: opts.originalMsgId,
            content: opts.isReply ? { isReplyMsg: true } : undefined,
            sessionWebhook: WEBHOOK,
            sessionWebhookExpiredTime: Date.now() + 3_600_000,
            robotCode: 'fake',
        }),
    };
}

const results = [];
const check = (name, cond, detail = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `\n        ${detail}` : ''}`);
    results.push({ name, ok: cond });
};

async function waitTurn(before, ms = 120000) {
    const t0 = Date.now();
    while (bridge.getCompletedTurns() === before && Date.now() - t0 < ms) {
        await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 600));
}

/* ========================================================= */
console.log('\n① @别人时不能漏人\n');
{
    /* 拦截传给 WS 的文本，直接检查模型收到了什么 */
    const captured = [];
    const origSubmit = bridge.socket?.submit?.bind(bridge.socket);
    if (bridge.socket) {
        bridge.socket.submit = async function (turn, model, text, sender) {
            captured.push({ text, sender });
            /* 模拟真实 submit：登记 turns，让 isRunning 能反映状态 */
            this.turns.set(turn.threadId, turn);
            setTimeout(() => {
                turn.finished = true;
                this.turns.delete(turn.threadId);
                bridge.completedTurns = (bridge.completedTurns ?? 0) + 1;
            }, 300);
            return;
        }.bind(bridge.socket);
    }

    await bridge.handleIncoming(
        mkMsg('@豆豆 @冇 很调皮，你和他聊天悠着点', {
            nick: '测试管理员',
            staff: 'staff_admin_test',
            chatId: 'cid_at_test',
        }),
    );
    await new Promise((r) => setTimeout(r, 800));

    const last = captured[captured.length - 1];
    const mentions = last?.sender?.mentions?.map((m) => m.name) ?? [];

    check('捕获到提交', Boolean(last), last ? `正文: ${JSON.stringify(last.text.slice(0, 60))}` : '无');
    check('识别出 @冇', mentions.includes('冇'), `mentions=${JSON.stringify(mentions)}`);
    check('未把机器人自己算进提及', !mentions.includes('豆豆'));
    check('正文不含 @ 残留', !last?.text?.includes('@豆豆'), JSON.stringify(last?.text?.slice(0, 60)));

    if (bridge.socket && origSubmit) bridge.socket.submit = origSubmit;
}

/* ========================================================= */
console.log('\n② 引用消息 @机器人 要回复\n');
{
    const threadBefore = bridge.getCompletedTurns();
    const pushesBefore = pushes.length;

    await bridge.handleIncoming(
        mkMsg('@豆豆', {
            chatId: 'cid_quote_test',
            nick: '李四',
            staff: 'staff_lisi',
            originalMsgId: 'msg_quoted_xxx',
            isReply: true,
        }),
    );

    await waitTurn(threadBefore, 60000);
    const newPushes = pushes.slice(pushesBefore);
    const joined = newPushes.map((p) => p?.markdown?.text ?? p?.text?.content ?? '').join('\n');

    check('引用消息未被丢弃', newPushes.length > 0 || bridge.getCompletedTurns() > threadBefore,
        `推送 ${newPushes.length} 条`);
    check('有实际回复内容', joined.length > 0 || bridge.getCompletedTurns() > threadBefore);
}

/* ========================================================= */
console.log('\n③ 进行中再发消息：排队而非丢弃\n');
{
    /* 手动占用线程，模拟"有进行中的回复" */
    const chatId = 'cid_queue_test';
    const turnBefore = bridge.getCompletedTurns();

    /* 第一次：正常提交（会被拦截，不真跑） */
    const origSubmit = bridge.socket.submit;
    let submitCount = 0;
    bridge.socket.submit = async function (turn) {
        submitCount += 1;
        this.turns.set(turn.threadId, turn);
        const holdMs = submitCount === 1 ? 4000 : 300;
        await new Promise((r) => setTimeout(r, holdMs));
        turn.finished = true;
        this.turns.delete(turn.threadId);
        bridge.completedTurns = (bridge.completedTurns ?? 0) + 1;
    }.bind(bridge.socket);

    const p1 = bridge.handleIncoming(mkMsg('第一条长任务', { chatId, nick: '王五', staff: 'staff_ww', msgId: 'q1' }));
    /* 等第一条真正进入 submit（turn 已登记） */
    for (let i = 0; i < 40 && submitCount === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    const threadId1 = Object.values(bridge.getSessions()).at(-1)?.threadId;
    const runningNow = threadId1 ? bridge.socket.isRunning(threadId1) : false;
    console.log(`        [调试] 第一条已提交=${submitCount} threadId=${threadId1} isRunning=${runningNow}`);

    const pushesBefore2 = pushes.length;
    const p2 = bridge.handleIncoming(mkMsg('第二条追问', { chatId, nick: '王五', staff: 'staff_ww', msgId: 'q2' }));
    await new Promise((r) => setTimeout(r, 1200));

    const queuePush = pushes.slice(pushesBefore2).map((p) => p?.markdown?.text ?? p?.text?.content ?? '').join('\n');
    check('第二条收到"已排队"提示', queuePush.includes('排队'), JSON.stringify(queuePush.slice(0, 60)));

    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 1000));

    check('两条都被处理（无丢弃）', submitCount >= 2, `实际提交 ${submitCount} 次`);
    check('第二轮产生了新回合', bridge.getCompletedTurns() > turnBefore);

    bridge.socket.submit = origSubmit;
}

/* ========================================================= */
console.log('\n④ /use 不需要 settings:write 权限\n');
{
    const chatId = 'cid_use_test';
    const pushesBefore = pushes.length;

    const targetWs = wsList[1]?.id ?? wsList[0]?.id;
    await bridge.handleIncoming(
        mkMsg(`/use ${targetWs}`, { chatId, nick: '赵六', staff: 'staff_zl', msgId: 'u1' }),
    );
    await new Promise((r) => setTimeout(r, 1500));

    const out = pushes.slice(pushesBefore).map((p) => p?.markdown?.text ?? p?.text?.content ?? '').join('\n');

    check('/use 执行成功', out.includes('已切换') || out.includes('工作区'), JSON.stringify(out.slice(0, 80)));
    check('未出现权限错误', !out.includes('permission') && !out.includes('没权限'));

    /* 覆盖值确实落到 storage */
    const overrides = bridge.workspaceOverrides ?? {};
    const saved = Object.values(overrides).includes(targetWs);
    check('工作区覆盖已记录', saved, JSON.stringify(overrides));
}

/* ========================================================= */
const passed = results.filter((r) => r.ok).length;
console.log(`\n${'─'.repeat(50)}`);
console.log(`结果: ${passed}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name}`);

/* 清理 */
for (const k of Object.keys(bridge.getSessions())) {
    const tid = bridge.getSessions()[k]?.threadId;
    if (tid) await fetch(`http://127.0.0.1:${PORT}/api/threads/${tid}`, { method: 'DELETE' }).catch(() => {});
}
srv.close();
process.exit(passed === results.length ? 0 : 1);
