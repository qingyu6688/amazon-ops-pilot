import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { cleanup, evidence, fixture, mockRequest, ready } from './helpers.js';
import { runSchema } from '../src/types/domain.js';

afterEach(async () => {
  mock.restoreAll();
  for (const root of cleanup.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'amazon-ops-pilot-test-'))) throw new Error('临时目录不在允许范围内。');
    await rm(root, { recursive: true, force: true });
  }
});

describe('运营阶段与回执', () => {
  it('阻止未经过前置阶段就准备上架', async () => {
    const { service, body } = await fixture();
    const run = runSchema.parse(await service.start('DEMO-TEST'));
    await assert.rejects(service.prepare(run.id, body), { code: 'WORKFLOW_GATE' });
  });
  it('拒绝缺失确认、空引用与重复 SKU 任务', async () => {
    const { service } = await fixture();
    const run = runSchema.parse(await service.start('DEMO-TEST'));
    await assert.rejects(service.advance(run.id, { confirmed: 'true', reference: '' }));
    await assert.rejects(service.start('DEMO-TEST'), { code: 'DUPLICATE_RUN' });
  });
  it('拒绝过期或伪装域名的合规来源', async () => {
    const { service } = await fixture();
    let run = runSchema.parse(await service.start('DEMO-TEST'));
    run = runSchema.parse(await service.advance(run.id, evidence()));
    run = runSchema.parse(await service.advance(run.id, evidence()));
    await assert.rejects(service.advance(run.id, { ...evidence(), reviewedAt: '2020-01-01T00:00:00.000Z' }), { code: 'POLICY_STALE' });
    await assert.rejects(service.advance(run.id, { ...evidence(), policySources: ['https://amazon.com.attacker.test/policy'] }), { code: 'POLICY_SOURCE_HOST' });
  });
  it('允许官方新文档域名，允许真实复核后更新合规证据', async () => {
    const { service } = await fixture();
    const run = await ready(service);
    const updated = runSchema.parse(await service.refreshCompliance(run.id, { ...evidence(), policySources: ['https://developer-docs.amazon/sp-api/docs/product-type-definitions-api'] }));
    assert.equal(updated.stage, 'listing');
    assert.ok(String(updated.evidence.compliance?.policySources?.[0]).includes('developer-docs.amazon/'));
  });
  it('仅准备草稿不能当作平台已接收', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    await service.prepare(run.id, body);
    await assert.rejects(service.advance(run.id, evidence()), { code: 'LISTING_NOT_ACCEPTED' });
  });
  it('接收后仍要求可售回读，之后才能进入日常运营', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    await service.publish(plan.id);
    await service.advance(run.id, evidence());
    await service.advance(run.id, evidence());
    await assert.rejects(service.advance(run.id, evidence()), { code: 'NOT_BUYABLE' });
    await service.verify(plan.id);
    assert.equal(runSchema.parse(await service.advance(run.id, evidence())).stage, 'operations');
  });
});

describe('发布权限与去重', () => {
  it('平台预览错误和明确 INVALID 都不能生成可发布计划', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const original = service.api.request.bind(service.api);
    mockRequest(service, async (method, path, query, payload, preview) => preview ? { status: 'INVALID', issues: [{ code: 'MISSING_VALUE', severity: 'ERROR', message: '缺少属性' }] } : original(method, path, query, payload, preview));
    await assert.rejects(service.prepare(run.id, body), { code: 'PREVIEW_INVALID' });
    assert.equal(Object.values((await service.store.read()).plans).length, 0);
  });
  it('卖家没有参与站点时不能准备计划', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const original = service.api.request.bind(service.api);
    mockRequest(service, async (method, path, query, payload, preview) => path.includes('marketplaceParticipations') ? { payload: [] } : original(method, path, query, payload, preview));
    await assert.rejects(service.prepare(run.id, body), { code: 'MARKETPLACE_NOT_PARTICIPATING' });
  });
  it('已存在 SKU 时拒绝整体写入', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const original = service.api.request.bind(service.api);
    mockRequest(service, async (method, path, query, payload, preview) => method === 'GET' && path.startsWith('/listings/') ? { sku: run.sku, summaries: [] } : original(method, path, query, payload, preview));
    await assert.rejects(service.prepare(run.id, body), { code: 'SKU_EXISTS' });
  });
  it('过期发布策略和过期合规证据会阻止写入', async () => {
    const { service, config, body } = await fixture();
    config.writePolicy.expiresAt = new Date(Date.now() - 1000).toISOString();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    await assert.rejects(service.publish(plan.id), { code: 'WRITE_POLICY_EXPIRED' });
    await service.store.transaction(async (state, save) => {
      state.runs[run.id]!.evidence.compliance!.reviewedAt = '2020-01-01T00:00:00.000Z';
      await save();
    });
    await assert.rejects(service.publish(plan.id), { code: 'POLICY_STALE' });
  });
  it('禁写模式仍可验证，但不能提交', async () => {
    const { service, config, body } = await fixture();
    config.writePolicy.mode = 'disabled';
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    await assert.rejects(service.publish(plan.id), { code: 'WRITE_DISABLED' });
  });
  it('逐单授权仅用于具体未修改计划', async () => {
    const { service, config, body } = await fixture();
    config.writePolicy.mode = 'approval';
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    await assert.rejects(service.publish(plan.id), { code: 'APPROVAL_REQUIRED' });
    await service.approve(plan.id, '测试操作者');
    assert.equal((await service.publish(plan.id)).status, 'accepted');
    await assert.rejects(service.publish(plan.id), { code: 'PLAN_ALREADY_USED' });
    assert.ok((await service.store.read()).approvals[plan.id]?.consumedAt);
  });
  it('篡改计划正文后不能沿用原摘要或授权', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    await service.store.transaction(async (state, save) => {
      state.plans[plan.id]!.body.attributes.brand = [{ value: '被篡改的品牌' }];
      await save();
    });
    await assert.rejects(service.publish(plan.id), { code: 'PLAN_TAMPERED' });
  });
  it('价格、数量、币种及跨站点属性均受范围约束', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const price = structuredClone(body);
    price.attributes.purchasable_offer = [{ currency: 'USD', marketplace_id: 'ATVPDKIKX0DER', our_price: [{ schedule: [{ value_with_tax: 999 }] }] }];
    await assert.rejects(service.prepare(run.id, price), { code: 'PRICE_SCOPE' });
    const quantity = structuredClone(body);
    quantity.attributes.fulfillment_availability = [{ fulfillment_channel_code: 'DEFAULT', quantity: 101 }];
    await assert.rejects(service.prepare(run.id, quantity), { code: 'QUANTITY_SCOPE' });
    const currency = structuredClone(body);
    currency.attributes.purchasable_offer = [{ currency: 'EUR', marketplace_id: 'ATVPDKIKX0DER', our_price: [{ schedule: [{ value_with_tax: 25 }] }] }];
    await assert.rejects(service.prepare(run.id, currency), { code: 'OFFER_SCOPE' });
    const marketplace = structuredClone(body);
    marketplace.attributes.brand = [{ value: 'Demo', marketplace_id: 'OTHER' }];
    await assert.rejects(service.prepare(run.id, marketplace), { code: 'ATTRIBUTE_MARKETPLACE' });
  });
  it('拒绝额外折扣字段以免绕过常规价格限制', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    body.attributes.purchasable_offer = [{ currency: 'USD', marketplace_id: 'ATVPDKIKX0DER', discounted_price: 1, our_price: [{ schedule: [{ value_with_tax: 25 }] }] }];
    await assert.rejects(service.prepare(run.id, body));
  });
  it('过期计划不能提交；配置变化使旧计划失效', async () => {
    const { service, config, body } = await fixture();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    const clock = mock.method(Date, 'now', () => Date.parse(plan.expiresAt) + 1);
    await assert.rejects(service.publish(plan.id), { code: 'PLAN_EXPIRED' });
    clock.mock.restore();
    config.writePolicy.scope.maxPrice = 49;
    await assert.rejects(service.publish(plan.id), { code: 'CONFIG_CHANGED' });
  });
  it('正式提交失败时保存未知状态，不能创建新计划绕过去重', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    const original = service.api.request.bind(service.api);
    let writes = 0;
    mockRequest(service, async (method, path, query, payload, preview) => {
      if (method === 'PUT' && !preview) { writes += 1; throw new Error('模拟响应丢失'); }
      return original(method, path, query, payload, preview);
    });
    assert.equal((await service.publish(plan.id)).status, 'unknown');
    await assert.rejects(service.publish(plan.id), { code: 'PLAN_ALREADY_USED' });
    await assert.rejects(service.prepare(run.id, body), { code: 'RUN_ALREADY_SUBMITTED' });
    assert.equal(writes, 1);
  });
  it('同一任务的多个草稿也只能正式提交一次', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const first = await service.prepare(run.id, body);
    const second = await service.prepare(run.id, body);
    await service.publish(first.id);
    await assert.rejects(service.publish(second.id), { code: 'RUN_ALREADY_SUBMITTED' });
  });
  it('按 UTC 日限制正式尝试次数', async () => {
    const { service, config, body } = await fixture();
    config.writePolicy.maxDailySubmissions = 1;
    const first = await ready(service, 'DEMO-FIRST');
    await service.publish((await service.prepare(first.id, body)).id);
    const second = await ready(service, 'DEMO-SECOND');
    const plan = await service.prepare(second.id, body);
    await assert.rejects(service.publish(plan.id), { code: 'DAILY_LIMIT' });
  });
  it('定义变化和未确认警告均会阻止正式写入', async () => {
    const { service, body } = await fixture();
    const run = await ready(service);
    const plan = await service.prepare(run.id, body);
    const definition = await service.api.definition(body.productType, service.config.marketplaceId);
    const spy = mock.method(service.api, 'definition', async () => ({ ...definition, checksum: 'new-definition' }));
    await assert.rejects(service.publish(plan.id), { code: 'SCHEMA_CHANGED' });
    spy.mock.restore();
    const original = service.api.request.bind(service.api);
    mockRequest(service, async (method, path, query, payload, preview) => preview ? { status: 'VALID', issues: [{ code: 'REVIEW_ME', severity: 'WARNING', message: '需要复核' }] } : original(method, path, query, payload, preview));
    await assert.rejects(service.publish(plan.id), { code: 'WARNINGS_UNREVIEWED' });
  });
});
