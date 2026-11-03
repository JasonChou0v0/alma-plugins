import assert from 'node:assert/strict';
import { DingTalkClient } from '../../src/dingtalk-client.ts';
import { AlmaSocket } from '../../src/alma-socket.ts';

const logger = { info() {}, warn() {}, error() {} };
const realFetch = globalThis.fetch; let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`✓ ${name}`); };
const creds = () => ({ clientId: 'id', clientSecret: 'sec', robotCode: 'bot' });
try {
  await ok('并发取令牌只发一次请求', async () => {
    let tokenCalls = 0;
    globalThis.fetch = async (url) => { tokenCalls++; await new Promise(r => setTimeout(r, 20)); return Response.json({ accessToken: 'T1', expireIn: 7200 }); };
    const c = new DingTalkClient(creds, logger);
    const all = await Promise.all([c.getAccessToken(), c.getAccessToken(), c.getAccessToken()]);
    assert.deepEqual(all, ['T1', 'T1', 'T1']); assert.equal(tokenCalls, 1);
    assert.equal(await c.getAccessToken(), 'T1'); assert.equal(tokenCalls, 1);
  });
  await ok('清令牌后，旧的在途请求不会把旧令牌写回缓存', async () => {
    let release; const gate = new Promise(r => { release = r; });
    let calls = 0;
    globalThis.fetch = async () => { calls++; const mine = calls; if (mine === 1) await gate; return Response.json({ accessToken: `T${mine}`, expireIn: 7200 }); };
    const c = new DingTalkClient(creds, logger);
    const first = c.getAccessToken(); c.clearToken(); release(); await first;
    assert.equal(await c.getAccessToken(), 'T2');
  });
  await ok('发送遇到 401 会换新令牌重试一次并成功', async () => {
    const seen = []; let tokenN = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('accessToken')) return Response.json({ accessToken: `T${++tokenN}`, expireIn: 7200 });
      seen.push(init.headers['x-acs-dingtalk-access-token']);
      return seen.length === 1 ? new Response('expired', { status: 401 }) : Response.json({ processQueryKey: 'k' });
    };
    const c = new DingTalkClient(creds, logger);
    const r = await c.sendToGroup('cid', 'hi');
    assert.equal(r.ok, true); assert.deepEqual(seen, ['T1', 'T2']);
  });
  await ok('连续 401 只重试一次，不会无限循环', async () => {
    let sends = 0;
    globalThis.fetch = async (url) => String(url).includes('accessToken') ? Response.json({ accessToken: 'T', expireIn: 7200 }) : (sends++, new Response('no', { status: 401 }));
    const r = await new DingTalkClient(creds, logger).sendToUser('u', 'hi');
    assert.equal(r.ok, false); assert.equal(sends, 2);
  });
  await ok('超时等不确定结果不重试，避免重复发送', async () => {
    let sends = 0;
    globalThis.fetch = async (url) => { if (String(url).includes('accessToken')) return Response.json({ accessToken: 'T', expireIn: 7200 }); sends++; throw new Error('timeout'); };
    const r = await new DingTalkClient(creds, logger).sendToUser('u', 'hi');
    assert.equal(r.ok, false); assert.equal(sends, 1);
  });
  await ok('非令牌类的 403 不重试', async () => {
    let sends = 0;
    globalThis.fetch = async (url) => String(url).includes('accessToken') ? Response.json({ accessToken: 'T', expireIn: 7200 }) : (sends++, new Response('forbidden', { status: 403 }));
    await new DingTalkClient(creds, logger).sendToGroup('c', 'x'); assert.equal(sends, 1);
  });
  await ok('隔离线程记录有上限且 forgetThread 可清除', () => {
    const s = new AlmaSocket(() => 'ws://127.0.0.1:1/ws', logger, {});
    for (let i = 0; i < 300; i++) s.quarantine(`t${i}`);
    assert.equal(s.quarantined.size, 200); assert(!s.quarantined.has('t0')); assert(s.quarantined.has('t299'));
    s.forgetThread('t299'); assert(!s.quarantined.has('t299'));
    s.close();
  });
} finally { globalThis.fetch = realFetch; }
console.log(`结果: ${n} 通过, 0 失败`);
