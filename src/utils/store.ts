import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stateSchema, type State } from '../types/domain.js';
import { OpsError } from './errors.js';

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export class Store {
  readonly directory: string;
  constructor(root: string, directory: string, mode: 'mock' | 'live') {
    this.directory = resolve(root, directory, mode);
  }

  async read(): Promise<State> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(resolve(this.directory, 'store.json'), 'utf8')));
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return { version: 1, runs: {}, plans: {}, approvals: {}, audit: [] };
      throw error;
    }
  }

  async save(state: State): Promise<void> {
    stateSchema.parse(state);
    const temporary = resolve(this.directory, `store-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, resolve(this.directory, 'store.json'));
  }

  async transaction<T>(action: (state: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = resolve(this.directory, 'store.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error: unknown) {
      if (hasCode(error, 'EEXIST')) throw new OpsError('STORE_LOCKED', '另一个操作持有状态锁；如曾异常退出，请先确认进程已停止，再处理锁文件。');
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      const state = await this.read();
      return await action(state, async (): Promise<void> => this.save(state));
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
