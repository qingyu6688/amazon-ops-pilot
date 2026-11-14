import { cp, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { destination: { type: 'string' } } });
const source = fileURLToPath(new URL('../skills/amazon-ops-pilot', import.meta.url));
const destination = resolve(values.destination ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills/amazon-ops-pilot'));

try {
  let exists = false;
  try { await stat(destination); exists = true; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (exists) throw new Error('目标技能目录已存在。请先审阅差异，本命令不会覆盖已有技能。');
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  process.stdout.write(`主技能已安装到：${destination}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '安装失败。');
  process.exitCode = 1;
}
