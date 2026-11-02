import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (Bun.version !== '1.3.14') throw new Error(`需要 Bun 1.3.14，当前为 ${Bun.version}；请修正 PATH`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['build', 'main.ts', '--outfile', 'main.js',
  '--target', 'node', '--format', 'esm', '--external', 'electron', '--external', 'zod'],
  { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
