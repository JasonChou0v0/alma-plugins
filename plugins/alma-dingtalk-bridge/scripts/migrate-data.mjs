#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dataPaths } from '../src/paths.mjs';

/** Run only while the plugin and dashboard collector are stopped. Existing unequal files fail closed. */
export function migrateData({ dataDir, legacyLogsDir, legacySnapshot }) {
    const paths = dataPaths(dataDir);
    const candidates = [];
    if (legacyLogsDir && fs.existsSync(legacyLogsDir)) {
        for (const name of fs.readdirSync(legacyLogsDir)) {
            if (/^dingtalk-(?:bridge-\d{4}-\d{2}-\d{2}\.log|payloads-\d{4}-\d{2}-\d{2}\.jsonl)$/.test(name)) {
                candidates.push([path.resolve(legacyLogsDir, name), path.join(paths.logs, name)]);
            }
        }
    }
    if (legacySnapshot && fs.existsSync(legacySnapshot)) candidates.push([path.resolve(legacySnapshot), paths.snapshot]);
    const plan = [];
    let alreadyLinked = 0;
    for (const [source, target] of candidates) {
        if (source === target) continue;
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) {
            if (fs.realpathSync(source) === path.resolve(target)) { alreadyLinked++; continue; }
            throw new Error('旧路径是非预期符号链接，停止迁移');
        }
        if (!stat.isFile()) throw new Error('旧产物不是普通文件，停止迁移');
        const bytes = fs.readFileSync(source);
        if (fs.existsSync(target)) {
            if (fs.lstatSync(target).isSymbolicLink() || !fs.readFileSync(target).equals(bytes)) {
                throw new Error('新目录有不同内容的同名文件，停止迁移，未覆盖任何产物');
            }
        }
        plan.push({ source, target, bytes });
    }
    // All conflicts are checked before the first write.
    for (const item of plan) {
        fs.mkdirSync(path.dirname(item.target), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(item.target)) fs.copyFileSync(item.source, item.target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(item.target, 0o600);
        if (!fs.readFileSync(item.target).equals(item.bytes) || !fs.readFileSync(item.source).equals(item.bytes)) {
            throw new Error('迁移期间源文件发生变化，保留源文件；请停用插件和采集器后重试');
        }
        const link = item.source + '.migrate-' + randomUUID();
        try {
            fs.symlinkSync(path.relative(path.dirname(item.source), item.target), link);
            fs.renameSync(link, item.source);
        } finally {
            if (fs.existsSync(link) || (() => { try { return fs.lstatSync(link).isSymbolicLink(); } catch { return false; } })()) fs.unlinkSync(link);
        }
    }
    return { migrated: plan.length, alreadyLinked };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
    if (!args.includes('--offline') || !value('--data-dir') || !value('--legacy-logs')) {
        console.error('先停用插件和采集器，再执行：node scripts/migrate-data.mjs --offline --data-dir <宿主storagePath> --legacy-logs <旧日志目录> [--legacy-snapshot <旧data.json>]');
        process.exitCode = 1;
    } else {
        console.log(JSON.stringify(migrateData({ dataDir: value('--data-dir'), legacyLogsDir: value('--legacy-logs'), legacySnapshot: value('--legacy-snapshot') })));
    }
}
