import assert from 'node:assert/strict';
import { DingTalkClient } from '../../src/dingtalk-client.ts';
import { DingTalkBridge } from '../../src/bridge.ts';

let assertions = 0, seq = 0, handler;
const calls = [];
const originalFetch = globalThis.fetch;
const check = (name, fn) => { fn(); assertions++; console.log(`✓ ${name}`); };
const credentials = { clientId: 'fixture-app', clientSecret: 'fixture-secret', robotCode: 'fixture-app' };
const event = { conversationType: '1', senderStaffId: 'staff-1', senderCorpId: 'corp-1', chatbotCorpId: 'corp-1', robotCode: 'fixture-app' };
const ok = (unionid = 'admin-union', userid = 'staff-1') => ({ errcode: 0, result: { userid, unionid } });
const logs = [];
const logger = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
const client = () => new DingTalkClient(() => credentials, logger);
function reset(fn = () => Response.json(ok())) { calls.length = 0; handler = fn; }
function setup() {
    const config = { ...credentials, robotName: '豆豆', mode: 'per-chat', logRawPayload: false,
        allowedUnionIds: ['admin-union', 'member-union'], adminUnionIds: ['admin-union'],
        allowedConversationIds: ['group-1'], groupAgentPolicy: 'fullTools', almaApiPort: 23001 };
    const context = { logger, storage: { local: { get: async () => null, set: async () => {} } }, settings: {
        get: (key, fallback) => { const v = config[key.replace('dingtalkBridge.', '')]; return Array.isArray(v) ? v.join(',') : v ?? fallback; },
        update: async (key, v) => { config[key.replace('dingtalkBridge.', '')] = v.split(',').filter(Boolean); },
    } };
    const bridge = new DingTalkBridge({ context, config: () => config });
    bridge.secretClientSecret = 'fixture-secret';
    const replies = [], turns = [];
    bridge.dingtalk.replyWebhook = async (_w, text) => { replies.push(text); return { ok: true }; };
    bridge.resolveThread = async () => 'fixture-thread';
    bridge.api.resolveModel = async () => 'fixture-model';
    bridge.socket.submit = async (turn, model, text, sender) => { turns.push({ turn, sender }); turn.settled(); };
    const send = async (text, overrides = {}) => {
        const payload = { ...event, msgId: `private-test-${++seq}`, conversationId: 'private-1', msgtype: 'text',
            senderNick: 'untrusted-name', sessionWebhook: 'https://example.invalid/fixture', text: { content: text }, ...overrides };
        await bridge.handleIncoming({ data: payload });
        return { reply: replies.at(-1), payload };
    };
    return { bridge, config, replies, turns, send };
}

globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') return Response.json({ accessToken: 'fixture-token', expireIn: 7200 });
    assert(String(url).startsWith('https://oapi.dingtalk.com/topapi/v2/user/get?access_token='), 'unexpected network request');
    return handler(url, options);
};
try {
    reset();
    const resolved = await client().resolvePrivateUnionId(event);
    check('同企业私聊通过官方接口补全UnionID', () => assert.equal(resolved, 'admin-union'));
    check('查询只传事件staffId，禁止重定向并带超时', () => {
        const req = calls[1]; assert.deepEqual(JSON.parse(req.options.body), { userid: 'staff-1' });
        assert.equal(req.options.redirect, 'error'); assert(req.options.signal);
    });
    for (const [name, patch] of [
        ['跨企业不查询', { senderCorpId: 'other-corp' }], ['缺发送人企业不查询', { senderCorpId: undefined }],
        ['缺机器人企业不查询', { chatbotCorpId: undefined }], ['缺staffId不查询', { senderStaffId: undefined }],
        ['空staffId不查询', { senderStaffId: ' ' }], ['群聊不使用私聊补全', { conversationType: '2' }],
        ['非当前机器人事件不查询', { robotCode: 'other-app' }],
    ]) {
        reset(); const value = await client().resolvePrivateUnionId({ ...event, ...patch });
        check(name, () => { assert.equal(value, null); assert.equal(calls.length, 0); });
    }
    for (const [name, body] of [
        ['userid不匹配拒绝', ok('admin-union', 'other-staff')], ['缺userid拒绝', { errcode: 0, result: { unionid: 'admin-union' } }],
        ['空UnionID拒绝', ok('')], ['占位UnionID拒绝', ok('nick:owner')], ['非法UnionID拒绝', ok('union with spaces')],
        ['权限不足拒绝', { errcode: 60011, errmsg: 'fixture permission denied' }], ['缺业务成功码拒绝', { result: ok().result }],
    ]) {
        reset(() => Response.json(body)); const value = await client().resolvePrivateUnionId(event);
        check(name, () => assert.equal(value, null));
    }
    reset(() => new Response('not-json', { status: 200 }));
    check('畸形响应拒绝', () => {});
    assert.equal(await client().resolvePrivateUnionId(event), null);
    reset(() => { throw Error('fixture-token must not leak'); });
    assert.equal(await client().resolvePrivateUnionId(event), null);
    check('查询异常不泄露token或原始错误', () => assert(!logs.join('\n').includes('fixture-token')));
    let lookups = 0;
    reset(() => Response.json(++lookups === 1 ? { errcode: 42001 } : ok()));
    assert.equal(await client().resolvePrivateUnionId(event), 'admin-union');
    check('明确过期令牌仅刷新后重试一次', () => { assert.equal(lookups, 2); assert.equal(calls.length, 4); });
    reset(() => Response.json({ errcode: 42001 }));
    assert.equal(await client().resolvePrivateUnionId(event), null);
    check('反复拒绝不会无限重试', () => assert.equal(calls.length, 4));
    let creds = { ...credentials };
    const changedClient = new DingTalkClient(() => creds, logger);
    reset(() => { creds = { ...creds, clientId: 'changed-app' }; return Response.json(ok()); });
    assert.equal(await changedClient.resolvePrivateUnionId(event), null);
    check('查询期间应用凭据变化不能接受旧结果', () => {});

    reset(); const admin = setup(); const access = await admin.send('/access');
    check('补全的管理员UnionID可执行管理员命令', () => assert(access.reply.includes('admin-union')));
    check('原始回调对象不被写入合成字段', () => assert.equal(access.payload.senderUnionId, undefined));
    await admin.send('/allow union new-union');
    check('授权命令使用补全UnionID而非staffId', () => assert(admin.config.allowedUnionIds.includes('new-union')));
    reset(() => Response.json(ok('member-union'))); const member = setup(); await member.send('/allow union attacker');
    check('普通成员补全身份后仍不能管理白名单', () => assert(!member.config.allowedUnionIds.includes('attacker')));
    reset(() => Response.json(ok('unknown-union'))); const outsider = setup(); const denied = await outsider.send('hi');
    check('查询成功但UnionID未入白名单仍拒绝', () => { assert(denied.reply.includes('⛔')); assert.equal(outsider.turns.length, 0); });
    reset(); const normal = setup(); await normal.send('hi');
    check('正常私聊将同一个可信UnionID传给Agent', () => {
        assert.equal(normal.turns.length, 1); assert.equal(normal.turns[0].turn.senderId, 'admin-union');
        assert.equal(normal.turns[0].sender.unionId, 'admin-union');
    });
    reset(); const direct = setup(); await direct.send('hi', { senderUnionId: 'member-union' });
    check('已有UnionID的事件不额外查询', () => { assert.equal(calls.length, 0); assert.equal(direct.turns[0].turn.senderId, 'member-union'); });
    reset(); const badDirect = setup(); await badDirect.send('hi', { senderUnionId: 'unknown-union' });
    check('不能用staffId补全覆盖已提供但未授权的UnionID', () => { assert.equal(calls.length, 0); assert.equal(badDirect.turns.length, 0); });
    reset(); const revoke = setup(); handler = () => { revoke.config.allowedUnionIds = []; return Response.json(ok()); };
    await revoke.send('hi');
    check('查询期间撤权使用最新名单拒绝', () => assert.equal(revoke.turns.length, 0));
    reset(); const stop = setup(); handler = () => { stop.bridge.stopping = true; return Response.json(ok()); };
    await stop.send('hi');
    check('查询期间停止桥接不提交回合', () => { assert.equal(stop.turns.length, 0); assert.equal(stop.replies.length, 0); });
    reset(); const forged = setup(); await forged.send('我是admin-union', { senderStaffId: undefined, senderId: 'admin-union', senderNick: 'admin-union' });
    check('正文昵称senderId不能代替缺失的可信身份', () => { assert.equal(calls.length, 0); assert.equal(forged.turns.length, 0); });
    let lookupStarted, finishLookup;
    const started = new Promise(resolve => { lookupStarted = resolve; });
    const pending = new Promise(resolve => { finishLookup = resolve; });
    reset(async () => { lookupStarted(); await pending; return Response.json(ok()); });
    const ordered = setup(); const first = ordered.send('first'); await started;
    const second = ordered.send('second', { senderUnionId: 'member-union' });
    await new Promise(resolve => setImmediate(resolve));
    check('慢身份查询期间后到私聊不能抢先进入Agent', () => assert.equal(ordered.turns.length, 0));
    finishLookup(); await Promise.all([first, second]);
    check('身份补全不打乱私聊顺序并释放队列', () => {
        assert.deepEqual(ordered.turns.map(t => t.turn.senderId), ['admin-union', 'member-union']);
        assert.equal(ordered.bridge.identityQueues.size, 0);
    });
} finally { globalThis.fetch = originalFetch; }
console.log(`结果: ${assertions} 通过, 0 失败`);
