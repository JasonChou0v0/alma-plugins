import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 日常测试允许兼容的 1.x 版本；发布前的构建与产物校验仍严格要求 1.3.14。
if (!Bun.version.startsWith('1.')) throw new Error(`需要 Bun 1.x，当前为 ${Bun.version}`);
if (Bun.version !== '1.3.14') console.warn(`提示：锁定版本是 1.3.14，当前 ${Bun.version}；发布前请用锁定版本复测`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--unit', '--integration'].includes(args[0]))) {
    throw new Error('用法：bun scripts/test.mjs [--unit|--integration]');
}
const typecheck = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', root], { cwd: root, stdio: 'inherit' });
if (typecheck.status !== 0) { console.error('类型检查未通过'); process.exit(typecheck.status || 1); }
console.log('类型检查通过');
const groups = args.length ? [args[0].slice(2)] : ['unit', 'integration'];
let completed = 0;
for (const group of groups) {
    const directory = resolve(root, 'tests', group);
    const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort();
    if (!files.length) throw new Error(`没有找到 ${group} 测试，拒绝空跑成功`);
    for (const file of files) {
        console.log(`\n[test] ${group}/${file}`);
        const result = spawnSync(process.execPath, [resolve(directory, file)], { cwd: root, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exit(result.status || 1);
        completed++;
    }
}
console.log(`\n离线测试：${completed} 个套件全部通过`);
