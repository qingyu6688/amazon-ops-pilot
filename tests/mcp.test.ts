import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { z } from 'zod';
import { cleanup, evidence, fixture, ROOT } from './helpers.js';
import { runSchema } from '../src/types/domain.js';

afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'amazon-ops-pilot-test-'))) throw new Error('临时目录不在允许范围内。');
    await rm(root, { recursive: true, force: true });
  }
});

it('通过实际 stdio 子进程发现工具并完成模拟上架闭环', { timeout: 30_000 }, async () => {
  const { config, root, body } = await fixture();
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/server.js')], cwd: ROOT,
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), AMAZON_OPS_CONFIG: configPath } });
  const client = new Client({ name: 'amazon-ops-pilot-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((tool) => tool.name === 'amazon_listing_publish')?.annotations?.readOnlyHint, false);
    assert.equal(tools.some((tool) => tool.name.includes('approve')), false);
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true);
      const text = response.content.find((part) => part.type === 'text');
      if (!text || text.type !== 'text') throw new Error('缺少工具文本结果。');
      return JSON.parse(text.text) as unknown;
    };
    assert.partialDeepStrictEqual(await call('amazon_ops_status', {}), { mode: 'mock', simulated: true });
    let run = runSchema.parse(await call('amazon_workflow_start', { sku: 'DEMO-PROTOCOL' }));
    while (run.stage !== 'listing') run = runSchema.parse(await call('amazon_workflow_advance', { runId: run.id, evidence: evidence() }));
    const plan = z.object({ id: z.string(), status: z.string() }).parse(await call('amazon_listing_prepare', { runId: run.id, body }));
    assert.partialDeepStrictEqual(await call('amazon_listing_publish', { planId: plan.id }), { status: 'accepted' });
    assert.partialDeepStrictEqual(await call('amazon_listing_verify', { planId: plan.id }), { buyable: true, hasErrors: false });
    const duplicate = await client.callTool({ name: 'amazon_listing_publish', arguments: { planId: plan.id } });
    assert.equal(duplicate.isError, true);
  } finally { await client.close(); await transport.close(); }
});
