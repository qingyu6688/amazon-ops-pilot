import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cleanup, fixture, ready } from './helpers.js';
import { readCustomSkill } from '../src/core/custom-skills.js';
import { economics, replenishment } from '../src/core/calculators.js';
import { configSchema } from '../src/core/config.js';
import { Store } from '../src/utils/store.js';

afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'amazon-ops-pilot-test-'))) throw new Error('临时目录不在允许范围内。');
    await rm(root, { recursive: true, force: true });
  }
});

describe('计算、存储与用户技能', () => {
  it('按明确成本计算贡献，补货不把零销量当作无限可售', () => {
    assert.partialDeepStrictEqual(economics({ unitPrice: 25, purchase: 5, packaging: 0, freightAndImport: 2, platform: 3.75, fulfillment: 4.5, returnsReserve: 1, advertising: 4, otherVariable: 0 }), { contributionBeforeAds: 8.75, contributionAfterAds: 4.75, breakEvenAcos: 0.35 });
    assert.partialDeepStrictEqual(replenishment({ averageDailySales: 5, sellable: 100, reliableInbound: 20, leadTimeDays: 40, safetyDays: 10 }), { coverageDays: 20, targetUnits: 250, suggestedUnits: 130 });
    assert.equal(replenishment({ averageDailySales: 0, sellable: 10, reliableInbound: 0, leadTimeDays: 10, safetyDays: 5 }).coverageDays, null);
  });
  it('严格配置拒绝未知开关和字符串布尔值', async () => {
    const { config } = await fixture();
    assert.throws(() => configSchema.parse({ ...config, enableAllWrites: true }));
    assert.throws(() => configSchema.parse({ ...config, mode: 'false' }));
  });
  it('动态定义检查可以发现必填字段缺失', async () => {
    const { service, body } = await fixture();
    delete body.attributes.item_name;
    await assert.rejects(service.validateListing('DEMO-TEST', body), { code: 'ATTRIBUTES_INVALID' });
  });
  it('真实持久化记录可由重启后的模拟适配器回读，模拟与生产分目录', async () => {
    const { service, body, config, root } = await fixture();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    await service.publish(plan.id);
    const state = await new Store(root, config.stateDirectory, 'mock').read();
    assert.equal(state.plans[plan.id]?.status, 'accepted');
    assert.equal(Object.values((await new Store(root, config.stateDirectory, 'live').read()).plans).length, 0);
  });
  it('独占锁会阻止另一进程或工具并发写入', async () => {
    const { service } = await fixture();
    await service.store.transaction(async () => {
      await assert.rejects(service.store.transaction(async () => true), { code: 'STORE_LOCKED' });
    });
  });
  it('损坏状态不能被当作空状态静默覆盖', async () => {
    const { service } = await fixture();
    await mkdir(service.store.directory, { recursive: true });
    await writeFile(join(service.store.directory, 'store.json'), '{broken');
    await assert.rejects(service.start('DEMO-TEST'));
    assert.equal(await readFile(join(service.store.directory, 'store.json'), 'utf8'), '{broken');
  });
  it('只读取登记的项目内技能，目录联接逃逸被阻止', async () => {
    const { root, config } = await fixture();
    const outside = await fixture();
    await writeFile(join(outside.root, 'SKILL.md'), '---\nname: outside\ndescription: 外部技能\n---\n外部内容');
    await symlink(outside.root, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    config.customSkills = [{ name: 'outside', path: 'linked/SKILL.md', stages: ['listing'] }];
    await assert.rejects(readCustomSkill(root, config, 'outside'), { code: 'SKILL_PATH' });
    await assert.rejects(readCustomSkill(root, config, 'unknown'), { code: 'SKILL_NOT_REGISTERED' });
    await mkdir(join(root, 'custom'), { recursive: true });
    await writeFile(join(root, 'custom/SKILL.md'), '---\nname: inside\ndescription: 内部技能\n---\n品牌偏好');
    config.customSkills = [{ name: 'inside', path: 'custom/SKILL.md', stages: ['listing'] }];
    assert.ok(String((await readCustomSkill(root, config, 'inside')).content).includes('品牌偏好'));
  });
});
