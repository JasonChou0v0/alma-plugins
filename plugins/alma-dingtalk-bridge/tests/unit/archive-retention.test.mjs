import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPrivate, pruneOld, redactSecrets } from '../../src/archive.ts';
import { createLogger } from '../../src/log.ts';

const parent = fileURLToPath(new URL('../../tmp', import.meta.url)); fs.mkdirSync(parent, { recursive: true });
const base = fs.mkdtempSync(path.join(parent, 'archive-'));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };
try {
  ok('webhook 与令牌字段被脱敏且不改入参', () => {
    const src = { sessionWebhook: 'https://x/secret', a: { access_token: 't', keep: 1 }, list: [{ clientSecret: 's' }] };
    const out = redactSecrets(src);
    assert.equal(out.sessionWebhook, '[redacted]'); assert.equal(out.a.access_token, '[redacted]');
    assert.equal(out.a.keep, 1); assert.equal(out.list[0].clientSecret, '[redacted]');
    assert.equal(src.sessionWebhook, 'https://x/secret');
  });
  const dir = path.join(base, 'logs'); fs.mkdirSync(dir);
  const old = path.join(dir, 'dingtalk-payloads-2020-01-01.jsonl'); const oldLog = path.join(dir, 'dingtalk-bridge-2020-01-01.log.1');
  const other = path.join(dir, 'other-plugin.log');
  for (const f of [old, oldLog, other]) fs.writeFileSync(f, 'x');
  ok('超期归档和日志被清理，其他文件不动', () => {
    assert.equal(pruneOld(dir, 7, new Date('2026-01-01T00:00:00Z')), 2);
    assert(!fs.existsSync(old)); assert(!fs.existsSync(oldLog)); assert(fs.existsSync(other));
  });
  ok('写入归档为 0600 且 webhook 已脱敏', () => {
    appendPrivate(dir, { payload: { sessionWebhook: 'https://leak' } });
    const f = fs.readdirSync(dir).find(x => x.startsWith('dingtalk-payloads-'));
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert(!text.includes('https://leak')); assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  });
  ok('日志超限时滚动保留旧内容而不是清空', () => {
    const lg = createLogger({ info() {}, warn() {}, error() {} }, path.join(base, 'roll'));
    lg.info('first'); const file = lg.filePath();
    fs.appendFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10));
    lg.info('second');
    assert(fs.readFileSync(`${file}.1`, 'utf8').includes('first'));
    assert(fs.readFileSync(file, 'utf8').includes('second'));
  });
  ok('30天归档不会被先写入的普通日志按7天删除', () => {
    const root = path.join(base, 'custom'); const logs = path.join(root, 'logs'); fs.mkdirSync(logs, { recursive: true });
    const day = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const archive = path.join(logs, `dingtalk-payloads-${day}.jsonl`); fs.writeFileSync(archive, 'fixture');
    createLogger({ info() {}, warn() {}, error() {} }, root).info('first');
    appendPrivate(logs, { fixture: true }, 30); assert(fs.existsSync(archive));
  });
  ok('日志始终使用当前配置，归档关闭后仍按配置清理且同日变更可生效', () => {
    const root = path.join(base, 'configured'); const logs = path.join(root, 'logs'); fs.mkdirSync(logs, { recursive: true });
    const day = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const archive = path.join(logs, `dingtalk-payloads-${day}.jsonl`); fs.writeFileSync(archive, 'fixture');
    let days = 30; const log = createLogger({ info() {}, warn() {}, error() {} }, root, () => days);
    log.info('first'); assert(fs.existsSync(archive)); days = 7; log.info('second'); assert(!fs.existsSync(archive));
  });
  ok('目录暂不存在时不缓存失败，当日恢复后仍清理', () => {
    const logs = path.join(base, 'later'); pruneOld(logs, 7); fs.mkdirSync(logs);
    const archive = path.join(logs, 'dingtalk-payloads-2020-01-01.jsonl'); fs.writeFileSync(archive, 'fixture');
    assert.equal(pruneOld(logs, 7), 1); assert(!fs.existsSync(archive));
  });
} finally { fs.rmSync(base, { recursive: true, force: true }); try { fs.rmdirSync(parent); } catch {} }
console.log(`结果: ${n} 通过, 0 失败`);
