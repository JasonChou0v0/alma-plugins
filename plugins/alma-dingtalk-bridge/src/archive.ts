/**
 * 本机归档与日志文件的共用工具：私有权限写入、敏感字段脱敏、按天数清理。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_RETENTION_DAYS = 7;
const LOG_RETENTION_DAYS = 14;
const pruned = new Map<string, string>();

/** 递归把 sessionWebhook 之类的可回复地址替换掉；不修改入参。 */
export function redactSecrets<T>(value: T): T {
    if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = /webhook|access_?token|secret/i.test(k) && typeof v === 'string' ? '[redacted]' : redactSecrets(v);
        }
        return out as T;
    }
    return value;
}

/** 删除超过保留天数的归档和日志（按文件名里的日期判断，只动本插件命名的文件）。 */
export function pruneOld(dir: string, retentionDays: number, now = new Date()): number {
    const today = now.toISOString().slice(0, 10);
    if (pruned.get(dir) === today) return 0;
    pruned.set(dir, today);
    let removed = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            const m = name.match(/^(dingtalk-payloads|dingtalk-bridge)-(\d{4}-\d{2}-\d{2})\.(jsonl|log)(\.1)?$/);
            if (!m) continue;
            const keep = m[1] === 'dingtalk-payloads' ? retentionDays : LOG_RETENTION_DAYS;
            const ageDays = (Date.parse(today) - Date.parse(m[2])) / 86_400_000;
            if (ageDays > keep) {
                try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* 下次再清 */ }
            }
        }
    } catch { /* 目录不存在等情况不影响主流程 */ }
    return removed;
}

export function appendPrivate(dir: string, record: unknown, retentionDays = DEFAULT_RETENTION_DAYS): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneOld(dir, retentionDays);
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `dingtalk-payloads-${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(redactSecrets(record))}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}
