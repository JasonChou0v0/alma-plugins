/**
 * 实测：同一群里两个不同发言人，模型能否区分。
 *
 * 走真实 Alma agent（同一线程连续两轮），模拟群聊场景。
 */
import http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ALMA_PORT || 23001);

/* 假钉钉 webhook */
const received = [];
const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        try {
            received.push(JSON.parse(body));
        } catch {
            received.push({ raw: body });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errcode":0}');
    });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const WEBHOOK = `http://127.0.0.1:${srv.address().port}/robot/send`;

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
    },
});

const mod = await import(path.join(ROOT, 'main.ts'));
const activation = await mod.activate(context);
await new Promise((r) => setTimeout(r, 1500));

const bridge = globalThis.__dingtalkBridgeProbe?.bridge;
if (!bridge) {
    console.error('未找到测试探针');
    process.exit(1);
}

let seq = 0;
function msg(text, nick, staffId) {
    seq += 1;
    return {
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: `m${seq}` },
        data: JSON.stringify({
            conversationId: 'cid_group_multi',
            conversationType: '2',
            conversationTitle: '[TEST] 研发讨论群',
            senderUnionId: staffId,
            senderNick: nick,
            msgId: `msg_${Date.now()}_${seq}`,
            msgtype: 'text',
            text: { content: text },
            sessionWebhook: WEBHOOK,
            sessionWebhookExpiredTime: Date.now() + 3_600_000,
            robotCode: 'fake',
        }),
    };
}

async function turn(text, nick, staffId) {
    const before = received.length;
    const turnsBefore = bridge.getCompletedTurns();
    await bridge.handleIncoming(msg(text, nick, staffId));
    const t0 = Date.now();
    while (bridge.getCompletedTurns() === turnsBefore && Date.now() - t0 < 120000) {
        await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 600));
    const msgs = received.slice(before);
    return msgs.map((m) => m?.markdown?.text ?? m?.text?.content ?? '').join('\n');
}

const results = [];
const check = (name, cond, detail = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `\n      → ${detail}` : ''}`);
    results.push(cond);
};

console.log('\n[e2e-sender] 场景：同一群，两个人先后提问\n');

/* 张三先说自己叫什么 */
const r1 = await turn('我叫张三，请记住我的名字，只回一句"记住了张三"', '张三', 'staff_zhangsan');
console.log(`[张三] ${JSON.stringify(r1.slice(0, 120))}`);
check('张三那轮有回复', r1.length > 0);

/* 李四接着自我介绍 */
const r2 = await turn('我叫李四，请记住我的名字，只回一句"记住了李四"', '李四', 'staff_lisi');
console.log(`[李四] ${JSON.stringify(r2.slice(0, 120))}`);
check('李四那轮有回复', r2.length > 0);

/* 关键：问"刚才谁说了什么" */
const r3 = await turn('刚才有哪些人说过话？分别说了什么？简短回答。', '李四', 'staff_lisi');
console.log(`[追问] ${JSON.stringify(r3.slice(0, 400))}`);

check('回复里提到张三', r3.includes('张三'));
check('回复里提到李四', r3.includes('李四'));
check('回复没有泄漏 Response Guidelines', !r3.includes('Response Guidelines'));
check('回复没有泄漏发言人标记原文', !r3.includes('发言人：'));

const passed = results.filter(Boolean).length;
console.log(`\n[e2e-sender] 结果 ${passed}/${results.length} 通过`);

/* 清理 */
for (const key of Object.keys(bridge.getSessions())) {
    const tid = bridge.getSessions()[key]?.threadId;
    if (tid) await fetch(`http://127.0.0.1:${PORT}/api/threads/${tid}`, { method: 'DELETE' });
}
/*
     * 不要调用 activation.dispose()：
     * 测试是在运行中的 Alma 进程里加载插件的，dispose 会真的把线上插件卸载，
     * 导致真实用户的消息无人接收（曾导致 2 小时静默）。
     * 只清理测试自己建的线程与本地服务器即可。
     */
    process.env.ALMA_DT_KEEP_ALIVE = '1';
srv.close();
process.exit(passed === results.length ? 0 : 1);
