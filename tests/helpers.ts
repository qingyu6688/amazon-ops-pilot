import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { configSchema, type Config } from '../src/core/config.js';
import { createService } from '../src/bootstrap.js';
import { bodySchema, runSchema, type AmazonApi, type ListingBody, type Run } from '../src/types/domain.js';
import type { OpsService } from '../src/core/service.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const cleanup: string[] = [];

export function mockRequest(service: OpsService, implementation: AmazonApi['request']): void {
  mock.method(service.api, 'request', implementation);
}

export async function fixture(): Promise<{ service: OpsService; config: Config; root: string; body: ListingBody }> {
  const root = await mkdtemp(join(tmpdir(), 'amazon-ops-pilot-test-'));
  cleanup.push(root);
  const config = configSchema.parse(JSON.parse(await readFile(join(ROOT, 'examples/mock.config.json'), 'utf8')));
  const body = bodySchema.parse(JSON.parse(await readFile(join(ROOT, 'examples/listing.demo.json'), 'utf8')));
  return { service: createService({ config, root }), config, root, body };
}

export function evidence(): { confirmed: true; reference: string; reviewedAt: string; policySources: string[] } {
  return { confirmed: true, reference: 'test:明确的模拟证据', reviewedAt: new Date().toISOString(), policySources: ['https://sellercentral.amazon.com/help/hub/reference/external/G200390640'] };
}

export async function ready(service: OpsService, sku = 'DEMO-TEST'): Promise<Run> {
  let run = runSchema.parse(await service.start(sku));
  while (run.stage !== 'listing') run = runSchema.parse(await service.advance(run.id, evidence()));
  return run;
}
