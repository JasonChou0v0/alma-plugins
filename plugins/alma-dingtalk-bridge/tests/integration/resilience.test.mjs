import assert from 'node:assert/strict';
import { DingTalkBridge } from '../../src/bridge.ts';
import { DingTalkClient } from '../../src/dingtalk-client.ts';

let n = 0; let seq = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`✓ ${name}`); };
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('real network forbidden'); };

function setup(over = {}) {
  const logs = [];
  const log = (...a) => logs.push(a.map(String).join(' '));
  const cfg = { clientId: '', clientSecret: '', robotName: '豆豆', mode: 'per-chat', logRawPayload: false,
    groupAgentPolicy: 'fullTools', allowedUnionIds: ['u1'], adminUnionIds: ['u1'], allowedConversationIds: ['g1'], ...over };
  const saved = {};
  const context = { logger: { info: log, warn: log, error: log }, settings: { get: (k, f) => f, update: async () => {} },
    storage: { local: { get: async (k, f) => saved[k] ?? f, set: async (k, v) => { saved[k] = v; } } },
    chat: { getThread: async (id) => ({ id }) } };
  const bridge = new DingTalkBridge({ context, config: () => cfg });
  const replies = [];
  bridge.dingtalk.replyWebhook = async (_w, text) => { replies.push(text); return { ok: true }; };
  bridge.api.resolveModel = async () => 'm';
  const send = (over2 = {}) => bridge.handleIncoming({ data: {
    msgId: `m${++seq}`, conversationId: 'g1', conversationType: '2', senderUnionId: 'u1', senderNick: '秘密昵称',
    conversationTitle: '秘密群名', msgtype: 'text', text: { content: '这是一段机密正文内容' },
    sessionWebhook: 'https://hook.invalid/x', sessionWebhookExpiredTime: Date.now() + 3_600_000, atUsers: [], ...over2 } });
  return { bridge, logs, replies, send, saved };
}

try {
  await ok('与线程无关的失败（Alma 未连接）保留会话映射', async () => {
    const t = setup();
    t.bridge.sessions.g1 = { threadId: 'th1', createdAt: 1 };
    t.bridge.socket.submit = async () => { throw Object.assign(new Error('Alma 未连接'), { userFacing: true }); };
    await t.send();
    assert.equal(t.bridge.sessions.g1?.threadId, 'th1');
  });
  await ok('线程被隔离时才作废映射', async () => {
    const t = setup();
    t.bridge.sessions.g1 = { threadId: 'th1', createdAt: 1 };
    t.bridge.socket.quarantine('th1');
    t.bridge.socket.submit = async () => { throw new Error('boom'); };
    await t.send();
    assert.equal(t.bridge.sessions.g1, undefined);
  });
  await ok('内部错误原文不发到群里，仅可展示的错误原样展示', async () => {
    const t = setup();
    t.bridge.sessions.g1 = { threadId: 'th1', createdAt: 1 };
    t.bridge.socket.submit = async () => { throw new Error('ECONNREFUSED 127.0.0.1:23001 /Users/x/secret'); };
    await t.send();
    const text = t.replies.join('\n');
    assert(!text.includes('127.0.0.1') && !text.includes('/Users'), text);
    assert(text.includes('内部错误'));
    assert(t.logs.some(l => l.includes('ECONNREFUSED')));
  });
  await ok('普通日志不含昵称、群名、正文', async () => {
    const t = setup();
    t.bridge.sessions.g1 = { threadId: 'th1', createdAt: 1 };
    t.bridge.socket.submit = async () => { throw new Error('x'); };
    await t.send();
    const all = t.logs.join('\n');
    for (const secret of ['秘密昵称', '秘密群名', '机密正文']) assert(!all.includes(secret), `日志泄漏 ${secret}`);
  });
  await ok('连接掉线时状态不再显示运行中', async () => {
    const t = setup();
    t.bridge.running = true;
    t.bridge.dwClient = { connected: false, disconnect() {} };
    assert.equal(t.bridge.getStatus().running, false);
    t.bridge.dwClient = { connected: true, disconnect() {} };
    assert.equal(t.bridge.getStatus().running, true);
  });
  await ok('过期的 webhook 改用主动发送到同一会话', async () => {
    const calls = []; const logger = { info() {}, warn() {}, error() {} };
    const c = new DingTalkClient(() => ({ clientId: 'i', clientSecret: 's', robotCode: 'r' }), logger);
    c.sendToGroup = async (id, text) => { calls.push(['g', id, text]); return { ok: true }; };
    c.sendToUser = async (id, text) => { calls.push(['u', id, text]); return { ok: true }; };
    c.registerWebhook('https://old', { expiresAt: Date.now() - 1000, conversationId: 'cidX' });
    c.registerWebhook('https://oldp', { expiresAt: Date.now() - 1000, staffId: 'staffY' });
    c.registerWebhook('https://nodest', { expiresAt: Date.now() - 1000 });
    await c.replyWebhook('https://old', 'a'); await c.replyWebhook('https://oldp', 'b');
    const r = await c.replyWebhook('https://nodest', 'c');
    assert.deepEqual(calls, [['g', 'cidX', 'a'], ['u', 'staffY', 'b']]); assert.equal(r.ok, false);
  });
  await ok('长期未用的会话映射被清理，旧记录从现在起算', async () => {
    const t = setup(); const now = Date.now();
    t.bridge.sessions = { old: { threadId: 'a', createdAt: 1, lastUsedAt: now - 91 * 86_400_000 },
      fresh: { threadId: 'b', createdAt: 1, lastUsedAt: now - 86_400_000 }, legacy: { threadId: 'c', createdAt: 1 } };
    assert.equal(t.bridge.pruneStaleSessions(now), 1);
    assert.deepEqual(Object.keys(t.bridge.sessions).sort(), ['fresh', 'legacy']);
    assert.equal(t.bridge.sessions.legacy.lastUsedAt, now);
  });
} finally { globalThis.fetch = realFetch; }
console.log(`结果: ${n} 通过, 0 失败`);
process.exit(0);
