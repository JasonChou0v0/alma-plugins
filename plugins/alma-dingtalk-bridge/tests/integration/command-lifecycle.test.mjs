import assert from 'node:assert/strict';
import { DingTalkBridge } from '../../src/bridge.ts';
import { AlmaApi } from '../../src/alma-api.ts';
let n = 0, seq = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`✓ ${name}`); };
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('real network forbidden'); };
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const logger = { info() {}, warn() {}, error() {} };
function setup(over = {}) {
  const cfg = { allowedUnionIds: ['admin', 'member', 'member2'], adminUnionIds: ['admin'], allowedConversationIds: ['g', 'g2'],
    groupAgentPolicy: 'fullTools', mode: 'per-chat', defaultModel: 'fake:model', logRawPayload: false, ...over };
  const writes = [], replies = [], created = [], socketMessages = [];
  let fallbacks = 0;
  const b = new DingTalkBridge({ context: { logger, settings: {}, storage: { local: {
    set: async (key, value) => writes.push({ key, value: JSON.parse(JSON.stringify(value)) }),
  } }, chat: { createThread: async () => { fallbacks++; return { id: 'fallback' }; } } }, config: () => cfg });
  b.api.resolveModel = async () => 'fake:model';
  b.api.resolveWorkspaceId = async () => 'old-workspace';
  b.api.getWorkspaces = async () => [{ id: 'new-workspace', name: 'Fixture' }];
  b.api.createThread = async body => { created.push(body); return { id: 'new-thread' }; };
  b.socket.ws = { readyState: 1, send: raw => socketMessages.push(JSON.parse(raw)) };
  b.dingtalk.replyWebhook = async (_w, text, _title, allowed) => {
    assert(allowed?.() ?? true); replies.push(text); return { ok: true };
  };
  const send = (text, sender = 'admin', chat = 'g', conversationType = '2') => b.handleIncoming({ data: {
    msgId: `command-${++seq}`, senderUnionId: sender, conversationId: chat, conversationType,
    msgtype: 'text', text: { content: text }, sessionWebhook: 'https://fixture.invalid/webhook',
  } });
  return { b, cfg, writes, replies, created, socketMessages, send, fallbacks: () => fallbacks };
}
const seed = t => {
  t.b.sessions.g = { threadId: 'old-thread', createdAt: Date.now() };
  t.b.workspaceOverrides.g = 'old-workspace';
  t.b.textHistory.set('g', [{ role: 'user', content: 'OLD_HISTORY_SENTINEL' }]);
};
const activeAgent = (t, chat = 'g') => {
  const turn = { threadId: 'agent-thread', chatId: chat, senderId: 'admin', conversationType: '2', agentEnabled: true,
    webhook: 'https://fixture.invalid/webhook', finished: false, tools: [], announcedTools: [], text: 'LATE_AGENT_SENTINEL',
    startedAt: Date.now(), lastActivity: Date.now() };
  t.b.sessions[chat] = { threadId: turn.threadId, createdAt: Date.now() };
  t.b.socket.turns.set(turn.threadId, turn); return turn;
};
try {
  for (const [name, change] of [
    ['用户撤权', t => { t.cfg.allowedUnionIds = []; }],
    ['管理员降级', t => { t.cfg.adminUnionIds = []; }],
    ['群撤权', t => { t.cfg.allowedConversationIds = []; }],
    ['切换模式', t => { t.cfg.mode = 'per-sender'; }],
    ['桥接重启', t => { t.b.startEpoch++; }],
    ['撤权后恢复', t => { t.cfg.adminUnionIds = []; t.b.reconcilePermissions(); t.cfg.adminUnionIds = ['admin']; }],
  ]) await test(`/use查询期间${name}：不写存储、不建线程、不回复成功`, async () => {
    const t = setup(); seed(t);
    t.b.api.getWorkspaces = async () => { change(t); return [{ id: 'new-workspace' }]; };
    await t.send('/use new-workspace');
    assert.equal(t.writes.length, 0); assert.equal(t.created.length, 0); assert.equal(t.replies.length, 0);
    assert.equal(t.b.sessions.g.threadId, 'old-thread'); assert.equal(t.b.workspaceOverrides.g, 'old-workspace');
  });
  for (const stage of ['model', 'workspace', 'create-success', 'create-failure']) await test(`/new在${stage}期间撤权：不继续写入或回退`, async () => {
    const t = setup(); seed(t); delete t.b.workspaceOverrides.g;
    const revoke = () => { t.cfg.adminUnionIds = []; };
    if (stage === 'model') t.b.api.resolveModel = async () => { revoke(); return 'fake:model'; };
    if (stage === 'workspace') t.b.api.resolveWorkspaceId = async () => { revoke(); return 'old-workspace'; };
    if (stage.startsWith('create')) t.b.api.createThread = async () => { revoke(); if (stage.endsWith('failure')) throw Error('fixture'); return { id: 'late-thread' }; };
    await t.send('/new');
    assert.equal(t.writes.length, 0); assert.equal(t.fallbacks(), 0); assert.equal(t.replies.length, 0);
    assert.equal(t.b.sessions.g.threadId, 'old-thread'); assert(t.b.textHistory.has('g'));
  });
  await test('存储请求进行中撤权，不发起后续覆盖写入或成功回复', async () => {
    const t = setup(); seed(t);
    t.b.ctx.storage.local.set = async key => { t.writes.push(key); t.cfg.adminUnionIds = []; };
    await t.send('/use new-workspace');
    assert.equal(t.writes.length, 1); assert.equal(t.b.workspaceOverrides.g, 'old-workspace'); assert.equal(t.replies.length, 0);
  });
  await test('正常/use将新线程绑定所选工作区，保存后回复成功', async () => {
    const t = setup(); seed(t); await t.send('/use new-workspace');
    assert.equal(t.created[0].workspaceId, 'new-workspace'); assert.equal(t.b.workspaceOverrides.g, 'new-workspace');
    assert.equal(t.writes.length, 2); assert(t.replies.some(x => x.includes('已切换')));
  });
  await test('建线程失败时保留原工作区、映射与普通历史', async () => {
    const t = setup(); seed(t); t.b.api.createThread = async () => { throw Error('PRIVATE_CREATE_ERROR'); };
    await t.send('/use new-workspace');
    assert.equal(t.b.sessions.g.threadId, 'old-thread'); assert.equal(t.b.workspaceOverrides.g, 'old-workspace');
    assert(t.b.textHistory.has('g')); assert.equal(t.writes.length, 0); assert.equal(t.fallbacks(), 0);
    assert(!t.replies.join('').includes('PRIVATE_CREATE_ERROR'));
  });
  await test('持久化失败不报告操作成功', async () => {
    const t = setup(); t.b.ctx.storage.local.set = async () => { throw Error('PRIVATE_STORAGE_ERROR'); };
    await t.send('/new'); assert(!t.replies.join('').includes('已新建')); assert(!t.replies.join('').includes('PRIVATE_STORAGE_ERROR'));
  });
  await test('只读命令等待期间撤权也不输出结果', async () => {
    const t = setup(); t.b.api.getWorkspaces = async () => { t.cfg.allowedUnionIds = []; return [{ id: 'PRIVATE_WORKSPACE' }]; };
    await t.send('/ws', 'member'); assert.equal(t.replies.length, 0);
  });
  await test('webhook取得令牌或重试前重新检查命令回复权限', async () => {
    const t = setup(); let authorization;
    t.b.dingtalk.replyWebhook = async (_w, _text, _title, allowed) => { authorization = allowed; return { ok: true }; };
    await t.send('/status', 'member'); assert(authorization()); t.cfg.allowedUnionIds = []; assert(!authorization());
  });
  await test('命令异常和/status不回显内部标记或本机路径', async () => {
    const t = setup(); const secret = 'INTERNAL_SENTINEL /Users/fixture/private';
    t.b.api.getWorkspaces = async () => { throw Error(secret); }; t.b.lastError = secret;
    await t.send('/ws', 'member'); await t.send('/status', 'member');
    assert.equal(t.replies.length, 2); assert(!t.replies.join('').includes('INTERNAL_SENTINEL')); assert(!t.replies.join('').includes('/Users/'));
  });
  await test('普通成员/stop不能停止管理员Agent', async () => {
    const t = setup(); const agent = activeAgent(t); await t.send('/stop', 'member');
    assert.equal(t.socketMessages.length, 0); assert(!agent.stopRequested);
  });
  await test('普通成员/stop只中止自己的纯聊天，忽略迟到回复', async () => {
    const t = setup(); const completion = deferred(); let signal;
    t.b.api.completeText = async (_m, _messages, s) => { signal = s; return completion.promise; };
    const request = t.send('hello', 'member'); await tick();
    await t.send('/stop', 'member'); assert(signal.aborted);
    completion.resolve('LATE_TEXT_SENTINEL'); await request;
    assert(!t.replies.join('').includes('LATE_TEXT_SENTINEL')); assert(!t.b.textHistory.has('g'));
  });
  await test('另一个普通成员不能中止他人的纯聊天', async () => {
    const t = setup(); const controller = new AbortController();
    t.b.textTurns.set('g', { turn: { senderId: 'member2', chatId: 'g' }, controller });
    await t.send('/stop', 'member'); assert(!controller.signal.aborted);
    await t.send('/stop', 'admin'); assert(controller.signal.aborted);
  });
  await test('single模式也不能从其他聊天停止正在运行的回合', async () => {
    const t = setup({ mode: 'single' }); const controller = new AbortController();
    t.b.textTurns.set('global', { turn: { senderId: 'member', chatId: 'g2' }, controller });
    await t.send('/stop', 'member'); assert(!controller.signal.aborted);
  });
  await test('管理员停止Agent会隔离旧线程、释放回合并抑制迟到输出', async () => {
    const t = setup(); const agent = activeAgent(t); let settled = false; agent.settled = () => { settled = true; };
    await t.send('/stop'); await tick();
    assert(t.socketMessages.some(x => x.type === 'stop_generation')); assert(t.b.socket.isQuarantined(agent.threadId));
    assert(!t.b.socket.getTurn(agent.threadId)); assert(settled);
    await t.b.finalizeTurn(agent); assert(!t.replies.join('').includes('LATE_AGENT_SENTINEL'));
  });
  await test('普通成员/new清空普通历史，不建线程、不改管理员映射或工作区', async () => {
    const t = setup(); seed(t); t.b.textHistory.set('g2', [{ role: 'user', content: 'other' }]);
    await t.send('/new', 'member'); assert(!t.b.textHistory.has('g')); assert(t.b.textHistory.has('g2'));
    assert.equal(t.b.sessions.g.threadId, 'old-thread'); assert.equal(t.b.workspaceOverrides.g, 'old-workspace');
    assert.equal(t.created.length, 0); assert.equal(t.writes.length, 0);
  });
  await test('管理员/new同时重置当前Agent和普通聊天', async () => {
    const t = setup(); seed(t); await t.send('/new');
    assert.equal(t.b.sessions.g.threadId, 'new-thread'); assert(!t.b.textHistory.has('g'));
  });
  await test('per-sender模式的/new仅清空本人纯聊天', async () => {
    const t = setup({ mode: 'per-sender' }); t.b.textHistory.set('g::member', []); t.b.textHistory.set('g::member2', []);
    await t.send('/new', 'member'); assert(!t.b.textHistory.has('g::member')); assert(t.b.textHistory.has('g::member2'));
  });
  await test('清空会话取消在途普通聊天，迟到结果不恢复历史', async () => {
    const t = setup(); const completion = deferred(); let signal;
    t.b.api.completeText = async (_m, _messages, s) => { signal = s; return completion.promise; };
    const request = t.send('hello', 'member'); await tick(); t.b.clearSessions(); assert(signal.aborted);
    completion.resolve('LATE_TEXT_SENTINEL'); await request;
    assert.equal(t.b.textHistory.size, 0); assert.equal(t.replies.length, 0); assert.deepEqual(t.b.sessions, {});
  });
  await test('清空期间旧的建线程请求返回，不重新绑定或报成功', async () => {
    const t = setup(); const creation = deferred(); t.b.api.createThread = async () => creation.promise;
    const request = t.send('/new'); await tick(); t.b.clearSessions(); creation.resolve({ id: 'late-thread' }); await request;
    assert.deepEqual(t.b.sessions, {}); assert.equal(t.replies.length, 0);
  });
  await test('清空会话后排队的旧消息不会重建上下文', async () => {
    const t = setup(); const completion = deferred(); let calls = 0;
    t.b.api.completeText = async () => { calls++; return completion.promise; };
    const first = t.send('one', 'member'); await tick(); const second = t.send('two', 'member'); await tick();
    t.b.clearSessions(); completion.resolve('LATE_TEXT_SENTINEL'); await Promise.all([first, second]);
    assert.equal(calls, 1); assert.equal(t.b.textHistory.size, 0); assert(!t.replies.join('').includes('LATE_TEXT_SENTINEL'));
  });
  await test('模型设置查询也接收取消信号', async () => {
    const controller = new AbortController(); let observed;
    globalThis.fetch = async (_url, options) => { observed = options.signal; return Response.json({ chat: { defaultModel: 'fake:model' } }); };
    await new AlmaApi(() => 'http://fixture.invalid', logger).resolveModel('', controller.signal);
    assert.equal(observed, controller.signal); globalThis.fetch = () => { throw Error('real network forbidden'); };
  });
  await test('授权管理等待期间撤权，不回复含白名单的结果', async () => {
    const t = setup();
    t.b.authorization.run = async () => { t.cfg.adminUnionIds = []; return 'PRIVATE_ACCESS_LIST'; };
    await t.send('/access'); assert.equal(t.replies.length, 0);
  });
  await test('宿主生成异常也不向聊天输出原始错误', async () => {
    const t = setup(); const agent = activeAgent(t);
    t.b.socket.cb.onError(agent, 'INTERNAL_SENTINEL /Users/fixture/private'); await tick();
    assert.equal(t.replies.length, 1); assert(!t.replies[0].includes('INTERNAL_SENTINEL')); assert(!t.replies[0].includes('/Users/'));
  });
  await test('清空会话持久化失败必须可观测，普通历史仍已清除', async () => {
    const t = setup(); seed(t); t.b.ctx.storage.local.set = async () => { throw Error('fixture storage failure'); };
    await assert.rejects(t.b.clearSessions()); assert.equal(t.b.textHistory.size, 0); assert.deepEqual(t.b.sessions, {});
  });
} finally { globalThis.fetch = realFetch; }
console.log(`结果: ${n} 通过, 0 失败`);
