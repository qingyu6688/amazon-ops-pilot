import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const lists = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return lists.flat();
}

try {
  const targets = [...await files(join(root, 'skills')), ...await files(join(root, 'examples/custom-skills')), ...await files(join(root, 'docs')), join(root, 'README.md')];
  let checked = 0;
  for (const path of targets.filter((item) => item.endsWith('.md'))) {
    const text = await readFile(path, 'utf8');
    if (text.includes('\uFFFD')) throw new Error(`文件编码异常：${path}`);
    if (path.endsWith('SKILL.md')) {
      if (!/^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---/u.test(text)) throw new Error(`技能头格式不正确：${path}`);
      if (text.includes('[TODO')) throw new Error(`存在未完成模板：${path}`);
      checked += 1;
    }
    for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
      const link = match[1];
      if (!link || /^(https?:|mailto:|#)/u.test(link)) continue;
      await access(resolve(dirname(path), decodeURIComponent(link.split('#')[0])));
    }
  }
  process.stdout.write(`已验证 ${checked} 个技能及项目 Markdown 本地链接。\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '技能校验失败。');
  process.exitCode = 1;
}
