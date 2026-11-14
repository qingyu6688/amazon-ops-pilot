import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadService } from './bootstrap.js';
import { bodySchema, runSchema } from './types/domain.js';
import { publicError, requireCondition } from './utils/errors.js';
import type { OpsService } from './core/service.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, plan: { type: 'string' }, by: { type: 'string' }
} });

async function demo(service: OpsService): Promise<unknown> {
  requireCondition(service.config.mode === 'mock', 'DEMO_ONLY', '演示命令只能使用 mock 配置。');
  const path = fileURLToPath(new URL('../examples/listing.demo.json', import.meta.url));
  const body = bodySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  let run = runSchema.parse(await service.start(`DEMO-${Date.now()}`));
  while (run.stage !== 'listing') {
    run = runSchema.parse(await service.advance(run.id, { confirmed: true, reference: `mock:模拟${run.stage}证据，不能用于生产`,
      ...(run.stage === 'compliance' ? { reviewedAt: new Date().toISOString(), policySources: ['https://sellercentral.amazon.com/help/hub/reference/external/G200390640'] } : {}) }));
  }
  const plan = await service.prepare(run.id, body);
  const submitted = await service.publish(plan.id);
  const verification = await service.verify(plan.id);
  for (let step = 0; step < 3; step += 1) run = runSchema.parse(await service.advance(run.id, { confirmed: true, reference: 'mock:模拟接收、履约与可售证据' }));
  return { simulated: true, notice: '全部为本地模拟，没有连接 Amazon、没有创建真实商品。', runId: run.id, planId: plan.id,
    submissionStatus: submitted.status, stage: run.stage, verification };
}

try {
  const command = positionals[0] ?? 'status';
  const configPath = values.config ?? (command === 'demo' ? fileURLToPath(new URL('../examples/mock.config.json', import.meta.url)) : undefined);
  const service = await loadService(configPath);
  let output: unknown;
  if (command === 'demo') output = await demo(service);
  else if (command === 'status') output = await service.status();
  else if (command === 'show-plan') {
    requireCondition(values.plan, 'PLAN_REQUIRED', '请提供 --plan 计划编号。');
    const plan = (await service.store.read()).plans[values.plan];
    requireCondition(plan, 'PLAN_NOT_FOUND', '未找到发布计划。');
    output = plan;
  } else if (command === 'approve') {
    requireCondition(values.plan && values.by, 'APPROVAL_ARGUMENTS', '请提供 --plan 计划编号和 --by 操作者。');
    output = await service.approve(values.plan, values.by);
  } else throw new Error('不支持的命令。');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error: unknown) {
  console.error(JSON.stringify(publicError(error)));
  process.exitCode = 1;
}
