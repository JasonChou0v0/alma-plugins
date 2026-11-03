import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (Bun.version !== '1.3.14') throw new Error('请使用 Bun 1.3.14 运行测试');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--unit', '--integration'].includes(args[0]))) {
    throw new Error('用法：bun scripts/test.mjs [--unit|--integration]');
}
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
