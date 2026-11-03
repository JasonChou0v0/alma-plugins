/**
 * 安全回归测试：模拟 transport，调用真实生产代码。
 *
 * 覆盖本轮 8 类要求里的关键修复：
 * 1. tool.willExecute 钩子真的被注册，且对「禁用工具」线程 cancel（宿主强制，非提示词）
 * 2. dingtalk_notify 工具把 ToolContext.threadId 透传给 notify（防绕过）
 * 3. notify 白名单 + 禁用线程鉴权（防绕过）
 * 4. secrets 接口能力探测（核验 get/set/delete，绝不调用不存在的方法）
 * 5. 卡住回合的终结 = stop 远端 + onError 回复（非旧式纯本地 sweep）
 * 6. 流式失败保留已发送游标 + 不在未闭合代码围栏内切断
 *
 * 不发真实消息（fetch 全桩）、不生成生产线程（不连 Alma、不建线程）、清理自身
 * （dispose 激活、还原 fetch）。跑法：bun test/security.mjs
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './harness.mjs';
import { DingTalkBridge } from '../lib/bridge.ts';
import { AlmaSocket } from '../lib/alma-socket.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
    cond ? pass++ : fail++;
};

/* ---------------- 全局 fetch 桩：拦截所有真实出站 ---------------- */
const realFetch = globalThis.fetch;
const fetchLog = [];
globalThis.fetch = async (url, init) => {
    const u = String(url);
    fetchLog.push(u);
    if (u.includes('oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'fake-token', expireIn: 7200 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    if (u.includes('/topapi/user/getbyunionid')) return Response.json({ errcode: 0, result: { userid: 'delivery-user' } });
    /* 钉钉发送 / webhook 回复：统一回成功 */
    return new Response('{"errcode":0,"errmsg":"ok"}', { status: 200 });
};

function baseConfig(over = {}) {
    return () => ({
        almaApiPort: 23001,
        clientId: 'fake-appkey',
        clientSecret: 'fake-secret',
        robotCode: 'fake-robot',
        robotName: '豆豆',
        defaultModel: '',
        workspaceId: '',
        mode: 'per-chat',
        allowedUnionIds: ['staff_a', 'staff_b'],
        streamingReply: false,
        replyOnToolUse: false,
        logRawPayload: false,
        groupAgentPolicy: 'refuse',
        clientSecretSecretKey: '',
        ...over,
    });
}

try {
    /* ============================================================ */
    /*  Part A：真实激活 → 验证钩子注册 + 工具 threadId 透传          */
    /* ============================================================ */
    console.log('\n[A] tool.willExecute 钩子 + notify 工具线程透传');
    {
        process.env.ALMA_DT_SELFTEST = '1';
        const { context, eventHandlers, registeredTools } = createContext({
            root: ROOT,
            quiet: true,
            pluginSettings: { clientId: '', clientSecret: '', allowedUnionIds: '' },
        });

        const mod = await import(path.join(ROOT, 'main.ts'));
        const activation = await mod.activate(context);
        const bridge = globalThis.__dingtalkBridgeProbe?.bridge;
        check('激活后探针可用', Boolean(bridge));

        /* --- A1：钩子真的注册了，且按线程禁用状态 cancel --- */
        const hookSet = eventHandlers.get('tool.willExecute');
        check('tool.willExecute 钩子已注册', hookSet instanceof Set && hookSet.size > 0);
        const handler = [...hookSet][0];

        /* 把一个线程标记为「禁用工具」（复刻 noTools 群回合的内部状态） */
        bridge.toolsDisabledThreads.add('thread-disabled');
        const outCancel = {};
        handler({ tool: 'Bash', args: {}, context: { threadId: 'thread-disabled' } }, outCancel);
        check('禁用线程的工具被 cancel', outCancel.cancel === true, JSON.stringify(outCancel));

        const outOk = {};
        handler({ tool: 'Bash', args: {}, context: { threadId: 'thread-normal' } }, outOk);
        check('普通线程的工具不被 cancel', outOk.cancel !== true, JSON.stringify(outOk));

        /* 钩子对缺字段输入不崩 */
        let noCrash = true;
        try {
            handler({}, {});
            handler({ context: {} }, {});
            handler({ context: { threadId: 123 } }, {});
        } catch {
            noCrash = false;
        }
        check('钩子对残缺输入不抛', noCrash);

        /* --- A2：notify 工具把 ToolContext.threadId 透传给 bridge.notify --- */
        const notifyDef = registeredTools.get('dingtalk_notify');
        check('dingtalk_notify 工具已注册', Boolean(notifyDef?.execute));

        const notifyCalls = [];
        const origNotify = bridge.notify.bind(bridge);
        bridge.notify = (unionId, text, opts) => {
            notifyCalls.push({ unionId, text, opts });
            return Promise.resolve({ ok: true });
        };
        await notifyDef.execute({ unionId: 'staff_a', message: 'hi' }, { threadId: 'T1', messageId: 'm1' });
        check('工具透传了 threadId', notifyCalls[0]?.opts?.threadId === 'T1', JSON.stringify(notifyCalls[0]));
        bridge.notify = origNotify;

        bridge.toolsDisabledThreads.delete('thread-disabled');
        await activation.dispose();
        delete process.env.ALMA_DT_SELFTEST;
    }

    /* ============================================================ */
    /*  Part B：notify 白名单 + 禁用线程鉴权（直接构造 bridge）       */
    /* ============================================================ */
    console.log('\n[B] notify 鉴权与白名单防绕过');
    {
        const { context } = createContext({ root: ROOT, quiet: true, pluginSettings: { allowedUnionIds: 'staff_a,staff_b' } });
        const bridge = new DingTalkBridge({ context, config: baseConfig() });

        bridge.secretClientSecret = 'fake-secret';
        /* B1：收件人不在白名单/已知用户 → 拒绝，且不触发出站 */
        fetchLog.length = 0;
        const r1 = await bridge.notify('staff_evil', 'hi');
        check('未授权收件人被拒', r1.ok === false, JSON.stringify(r1));
        check('未授权时不发网络请求', fetchLog.length === 0, `fetch=${fetchLog.length}`);

        /* B2：收件人授权，但线程被禁用工具 → 拒绝，不出站 */
        bridge.toolsDisabledThreads.add('thread-dis');
        fetchLog.length = 0;
        const r2 = await bridge.notify('staff_a', 'hi', { threadId: 'thread-dis' });
        check('禁用线程里发信被拒', r2.ok === false && /禁用/.test(r2.error ?? ''), JSON.stringify(r2));
        check('禁用线程拒绝时不出站', fetchLog.length === 0, `fetch=${fetchLog.length}`);

        /* B3：授权 + 非禁用 → 走真实 sendToUnionUser（fetch 桩返回成功） */
        fetchLog.length = 0;
        const r3 = await bridge.notify('staff_a', 'hi', { threadId: 'thread-ok' });
        check('授权且非禁用时发送成功', r3.ok === true, JSON.stringify(r3));
        check('发送触发了出站', fetchLog.some((u) => u.includes('oauth2/accessToken')), `fetch=${JSON.stringify(fetchLog)}`);

        /* B4：消息过长被拒 */
        const r4 = await bridge.notify('staff_a', 'x'.repeat(4001));
        check('超长消息被拒', r4.ok === false && /过长/.test(r4.error ?? ''), JSON.stringify(r4));
    }

    /* ============================================================ */
    /*  Part C：卡住回合的终结 = stop 远端 + 通知用户（非纯本地 sweep） */
    /* ============================================================ */
    console.log('\n[C] 卡住回合的正确终结');
    {
        const { context } = createContext({ root: ROOT, quiet: true });
        const bridge = new DingTalkBridge({ context, config: baseConfig() });

        /* 装一个假 ws，捕获 stop_generation；replyWebhook 录音，避免真实出站/落盘 */
        const sent = [];
        bridge.socket.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
        const replyCalls = [];
        bridge.dingtalk.replyWebhook = async (w, t) => { replyCalls.push({ w, t }); return { ok: true }; };

        /* 放一个卡死的回合（lastActivity 远早于阈值）和一个新回合 */
        const stale = {
            threadId: 'thread-stale',
            chatId: 'c', webhook: 'http://127.0.0.1/wh/stale',
            senderId: 'staff_a', text: '部分回复',
            tools: [], announcedTools: [],
            startedAt: Date.now() - 30 * 60_000,
            lastActivity: Date.now() - 30 * 60_000,
            finished: false,
        };
        const fresh = {
            threadId: 'thread-fresh',
            chatId: 'c', webhook: 'http://127.0.0.1/wh/fresh',
            senderId: 'staff_a', text: '',
            tools: [], announcedTools: [],
            startedAt: Date.now(), lastActivity: Date.now(),
            finished: false,
        };
        bridge.socket.turns.set(stale.threadId, stale);
        bridge.socket.turns.set(fresh.threadId, fresh);

        fetchLog.length = 0;
        const n = bridge.sweepStaleTurns();
        await new Promise(resolve => setImmediate(resolve));
        check('只终结卡死的回合', n === 1, `n=${n}`);
        check('向远端发了 stop_generation', sent.some((m) => m.type === 'stop_generation' && m.data.threadId === 'thread-stale'), JSON.stringify(sent));
        check('卡死回合被标记 finished', stale.finished === true);
        check('通知了用户（走 reply 回路）', replyCalls.some((r) => String(r.w).includes('/wh/stale')), JSON.stringify(replyCalls));
        /* 关键：不是纯本地清理——远端收到了 stop，用户收到了通知 */
        check('新回合未被误终结', fresh.finished === false);
        check('新回合未收到 stop', !sent.some((m) => m.data.threadId === 'thread-fresh'));
    }

    /* ============================================================ */
    /*  Part D：流式 — 游标保留 + 代码围栏不切断                      */
    /* ============================================================ */
    console.log('\n[D] 流式失败游标保留 + 围栏安全');
    {
        /* D1：未闭合代码围栏内不切断 */
        const openFence = '```js\nconst x = 1\n还在围栏里没结束';
        check('未闭合围栏内不切', DingTalkBridge.takeFlushable(openFence, 0) === '', JSON.stringify(DingTalkBridge.takeFlushable(openFence, 0)));

        /* 围栏闭合后可以在边界切 */
        const closedFence = '```js\ncode\n```\n后面这句完整。';
        const piece = DingTalkBridge.takeFlushable(closedFence, 0);
        check('闭合围栏后可切', piece.endsWith('。'), JSON.stringify(piece));
        check('切点不在围栏中间', !piece.endsWith('```'));

        /* D2：doFlush 失败时保留已发送游标，不回退、不掩饰 */
        const { context } = createContext({ root: ROOT, quiet: true });
        const bridge = new DingTalkBridge({ context, config: baseConfig({ streamingReply: true }) });
        /* replyWebhook 模拟失败 */
        bridge.dingtalk.replyWebhook = async () => ({ ok: false, error: 'simulated fail' });

        const turn = {
            threadId: 't-flush', chatId: 'c', webhook: 'http://127.0.0.1/wh',
            senderId: 'staff_a', text: 'a'.repeat(250),
            tools: [], announcedTools: [],
            startedAt: Date.now(), lastActivity: Date.now(),
            finished: false, flushCount: 0, flushedChars: 0,
        };
        await bridge.doFlush(turn);
        check('失败时游标不推进', turn.flushedChars === 0, `flushedChars=${turn.flushedChars}`);
        check('失败不标 streamed', turn.streamed !== true, `streamed=${turn.streamed}`);
        check('失败时仍占用一次分段计数', turn.flushCount === 1, `flushCount=${turn.flushCount}`);

        /* 失败的那段会在收尾时并入余量重发（这里验证余量包含全部文本） */
        bridge.socket.release = () => {};
        const replied = [];
        bridge.dingtalk.replyWebhook = async (_w, text) => { replied.push(text); return { ok: true }; };
        turn.streamed = false; /* 失败未置真，保持未流式 */
        await bridge.finalizeTurn(turn);
        check('收尾余量包含未发出的全部文本', replied.some((t) => t.includes('a'.repeat(250))), JSON.stringify(replied).slice(0, 120));
    }

    /* ============================================================ */
    /*  Part E：secrets 接口能力探测                                  */
    /* ============================================================ */
    console.log('\n[E] secrets 接口能力探测');
    {
        const { context } = createContext({ root: ROOT, quiet: true });
        const bridge = new DingTalkBridge({
            context,
            config: baseConfig({ clientSecretSecretKey: 'dt.clientSecret', clientSecret: '' }),
            encryptionAvailable: async () => true,
        });

        /* E1：secrets 缺 delete → 能力探测失败，拒绝写入 */
        context.storage.secrets = { get: async () => undefined, set: async () => {} };
        const r1 = await bridge.storeClientSecret('a-secret');
        check('secrets 缺 delete 时拒绝写入', r1 === false, `r=${r1}`);

        /* E2：secrets 齐全 → 正常写入 */
        let written;
        context.storage.secrets = {
            get: async () => written,
            set: async (_k, v) => { written = v; },
            delete: async () => {},
        };
        const r2 = await bridge.storeClientSecret('a-secret');
        check('secrets 齐全时写入成功', r2 === true && written === 'a-secret', `r=${r2} written=${written}`);

        /* E3：loadSecretClientSecret 从 secrets 读到值 */
        context.storage.secrets.get = async () => 'loaded-secret';
        await bridge.loadSecretClientSecret(bridge.cfg());
        check('从 secrets 读到凭据', bridge.secretClientSecret === 'loaded-secret', `v=${bridge.secretClientSecret}`);

        /* E4：非字符串值不被接受（secrets 只存字符串） */
        context.storage.secrets.get = async () => 12345;
        bridge.secretClientSecret = undefined;
        await bridge.loadSecretClientSecret(bridge.cfg());
        check('非字符串 secrets 值被忽略', bridge.secretClientSecret === undefined, `v=${bridge.secretClientSecret}`);
    }
} finally {
    /* 清理：还原 fetch，绝不留全局桩 */
    globalThis.fetch = realFetch;
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
