#!/usr/bin/env node
/**
 * 从插件日志采集消息明细，生成看板用的 data.json。
 *
 * 用法：node dashboard/collect.mjs [--watch]
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataPaths } from '../src/paths.mjs';
import * as path from 'node:path';

const { logs: LOG_DIR, dashboard: DASHBOARD_DIR, snapshot: OUT } = dataPaths(process.env.ALMA_DINGTALK_DATA_DIR);
const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

/** 解析一行的字段串：conv=ok staff=- sender=xxx ... */
function parseFields(raw) {
  const fields = {};
  const re = /(\w+)=(?:"([^"]*)"|(\[[^\]]*\])|(\S+))/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    fields[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return fields;
}

/**
 * 读取全量归档（dingtalk-payloads-YYYY-MM-DD.jsonl）
 * 返回 msgId -> { inbound, outbound[] }
 */
function readPayloadArchive(day) {
    const file = path.join(LOG_DIR, `dingtalk-payloads-${day}.jsonl`);
    const map = new Map();
    if (!fs.existsSync(file)) return map;

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }

        if (rec.direction === 'out') {
            map.get('__out__') ?? map.set('__out__', []);
            map.get('__out__').push(rec);
            continue;
        }

        const msgId = rec?.payload?.msgId;
        if (!msgId) continue;
        const entry = map.get(msgId) ?? { inbound: null, outbound: [] };
        entry.inbound = rec;
        map.set(msgId, entry);
    }
    return map;
}

function collect() {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `dingtalk-bridge-${today}.log`);

  if (!fs.existsSync(file)) {
    return { total: 0, delivered: 0, commands: 0, dropped: 0, entries: [], error: `日志不存在: ${file}` };
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const entries = [];
  let cur = null;

  for (const line of lines) {
    const m = line.match(/^(\S+Z)\s+\[(\w+)\]\s(.*)$/);
    if (!m) continue;
    const [, ts, level, msg] = m;

    const recv = msg.match(/^收到钉钉消息\s+(\S+)/);
    if (recv) {
      cur = { ts, msgId: recv[1], level, kind: 'recv' };
      continue;
    }

    /*
     * 某些路径（如测试直调 handleIncoming）不经过「收到钉钉消息」，
     * 因此「入站字段」也要能作为一条记录的起点。
     */
    if (msg.startsWith('入站字段:')) {
      if (!cur || cur.fields) {
        cur = { ts, msgId: '', level, kind: 'recv' };
      }
    }

    if (cur && msg.startsWith('入站字段:')) {
      const raw = msg.replace('入站字段:', '').trim();

      /*
       * 按「key=value」顺序解析，value 允许含空格（convTitle 可能是"研发 讨论群"）。
       * 用位置切分比正则更稳：先找出所有 key= 的位置，再截取到下一个 key 之前。
       */
      const keyRe = /(\w+)=/g;
      const marks = [];
      let km;
      while ((km = keyRe.exec(raw)) !== null) marks.push({ key: km[1], start: km.index, valStart: km.index + km[0].length });

      const fields = {};
      for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
        fields[marks[i].key] = raw.slice(marks[i].valStart, end).trim();
      }

      cur.fields = fields;
      continue;
    }

    if (cur && msg.startsWith('原始载荷')) {
      try {
        cur.rawPayload = JSON.parse(msg.slice(msg.indexOf(':') + 1).trim());
      } catch {
        cur.rawPayloadText = msg;
      }
      continue;
    }

    if (cur && msg.startsWith('对话消息')) {
      cur.text = msg.replace(/^对话消息（[^）]*）:\s*/, '');
      cur.state = 'delivered';
      entries.push(cur);
      cur = null;
      continue;
    }

    if (cur && msg.startsWith('执行命令')) {
      cur.text = msg;
      cur.state = 'command';
      entries.push(cur);
      cur = null;
      continue;
    }

    if (cur && /(忽略|跳过|缺少)/.test(msg)) {
      cur.text = msg;
      cur.state = 'dropped';
      entries.push(cur);
      cur = null;
      continue;
    }
  }

  const todayEntries = entries.filter((e) => e.ts.startsWith(today));
  const archive = readPayloadArchive(today);

  return {
    generatedAt: new Date().toISOString(),
    total: todayEntries.length,
    delivered: todayEntries.filter((e) => e.state === 'delivered').length,
    commands: todayEntries.filter((e) => e.state === 'command').length,
    dropped: todayEntries.filter((e) => e.state === 'dropped').length,
    entries: todayEntries
      .map((e) => ({
        ts: e.ts,
        msgId: e.msgId || `(no-id-${e.ts})`,
        fields: e.fields ?? {},
        text: e.text ?? '',
        command: e.state === 'command',
        dropped: e.state === 'dropped',
        rawPayload: e.rawPayload ?? archive.get(e.msgId)?.inbound?.payload ?? null,
        rawHeaders: archive.get(e.msgId)?.inbound?.headers ?? null,
      }))
      .reverse(),
  };
}

function write() {
  const data = collect();
  fs.mkdirSync(DASHBOARD_DIR, { recursive: true, mode: 0o700 });
  fs.copyFileSync(HTML, path.join(DASHBOARD_DIR, 'index.html'));
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(
    `[dashboard] ${data.total} 条（投递 ${data.delivered} / 命令 ${data.commands} / 丢弃 ${data.dropped}）→ ${OUT}`,
  );
  return data;
}

write();

if (process.argv.includes('--watch')) {
  console.log('[dashboard] 监听日志变化，每 5 秒刷新…');
  setInterval(write, 5000);
}
