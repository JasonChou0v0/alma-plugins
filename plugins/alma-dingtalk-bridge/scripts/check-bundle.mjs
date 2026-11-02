import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (Bun.version !== '1.3.14') throw new Error('请使用 Bun 1.3.14 校验预打包产物');
const current = await readFile(resolve(root, 'main.js'));
const parent = resolve(root, 'tmp');
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(resolve(parent, 'bundle-'));
try {
  const target = resolve(temporary, 'main.js');
  const result = spawnSync(process.execPath, ['build', 'main.ts', '--outfile', target,
    '--target', 'node', '--format', 'esm', '--external', 'electron', '--external', 'zod'],
    { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('构建失败');
  const rebuilt = await readFile(target);
  if (!current.equals(rebuilt)) throw new Error('main.js 与源码不一致；请 bun run build 并提交产物');
  console.log('main.js 与锁定依赖下重新构建的产物逐字节一致');
} finally {
  await rm(temporary, { recursive: true, force: true });
  // 只移除空的本次临时父目录，保留任何其他内容。
  const { rmdir } = await import('node:fs/promises');
  await rmdir(parent).catch(() => {});
}
