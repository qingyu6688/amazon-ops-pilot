import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it, mock, type Mock } from 'node:test';
import { LiveAmazonApi } from '../src/api/amazon.js';
import { configSchema } from '../src/core/config.js';
import { publicError } from '../src/utils/errors.js';

const ENV_KEYS = ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_LWA_REFRESH_TOKEN'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function config(): ReturnType<typeof configSchema.parse> {
  return configSchema.parse({ version: 1, mode: 'live', sellerId: 'TEST_SELLER', marketplaceId: 'TEST_MARKET', region: 'NA', writePolicy: {
    mode: 'disabled', expiresAt: '2099-01-01T00:00:00.000Z', authorizedBy: '测试', maxDailySubmissions: 1,
    scope: { skuPrefix: 'TEST-', productTypes: ['TEST_PRODUCT'], currency: 'USD', minPrice: 1, maxPrice: 50, maxQuantity: 1, fulfillmentChannels: ['DEFAULT'] }
  } });
}

function authorize(): void {
  process.env.AMAZON_LWA_CLIENT_ID = 'test-client-id';
  process.env.AMAZON_LWA_CLIENT_SECRET = 'test-only-not-a-real-secret';
  process.env.AMAZON_LWA_REFRESH_TOKEN = 'test-only-not-a-real-refresh-token';
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function queuedFetch(...responses: Response[]): Mock<typeof fetch> {
  return mock.fn<typeof fetch>(async () => {
    const response = responses.shift();
    assert.ok(response, '测试没有为额外网络请求准备响应。');
    return response;
  });
}

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('SP-API 认证与传输', () => {
  it('刷新并缓存 LWA 令牌，使用正确区域和请求头', async () => {
    authorize();
    const fetcher = queuedFetch(json({ access_token: 'test-access', expires_in: 3600 }), json({ ok: true }), json({ ok: true }));
    const api = new LiveAmazonApi(config(), fetcher);
    await api.request('GET', '/sellers/v1/marketplaceParticipations');
    await api.request('GET', '/sellers/v1/marketplaceParticipations');
    assert.equal(fetcher.mock.callCount(), 3);
    assert.equal(String(fetcher.mock.calls[1]?.arguments[0]), 'https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations');
    const headers = new Headers(fetcher.mock.calls[1]?.arguments[1]?.headers);
    assert.equal(headers.get('x-amz-access-token'), 'test-access');
    assert.equal(headers.get('authorization'), null);
  });
  it('生产写入遇到 503 不自动重试', async () => {
    authorize();
    const fetcher = queuedFetch(json({ access_token: 'test-access', expires_in: 3600 }), json({ message: '不要返回此原文' }, 503));
    await assert.rejects(new LiveAmazonApi(config(), fetcher).request('PUT', '/listings/2021-08-01/items/TEST/SKU', {}, {}), { status: 503 });
    assert.equal(fetcher.mock.callCount(), 2);
  });
  it('只读限流可有界重试', async () => {
    authorize();
    const fetcher = queuedFetch(json({ access_token: 'test-access', expires_in: 3600 }), json({}, 429), json({ ok: true }));
    assert.deepStrictEqual(await new LiveAmazonApi(config(), fetcher).request('GET', '/sellers/v1/marketplaceParticipations'), { ok: true });
    assert.equal(fetcher.mock.callCount(), 3);
  });
  it('不向调用方暴露认证响应或密钥', async () => {
    authorize();
    const fetcher = queuedFetch(json({ secret: 'test-only-not-a-real-secret' }, 401));
    let result: unknown;
    try { await new LiveAmazonApi(config(), fetcher).request('GET', '/sellers/v1/marketplaceParticipations'); }
    catch (error: unknown) { result = publicError(error); }
    assert.ok(!JSON.stringify(result).includes('test-only-not-a-real-secret'));
    assert.partialDeepStrictEqual(result, { code: 'LWA_AUTH' });
  });
  it('动态定义下载必须通过来源与 MD5 校验', async () => {
    authorize();
    const schema = JSON.stringify({ type: 'object', required: ['item_name'] });
    const checksum = createHash('md5').update(schema).digest('base64');
    const fetcher = queuedFetch(json({ access_token: 'test-access', expires_in: 3600 }),
      json({ schema: { link: { resource: 'https://test-listing-schema.s3.amazonaws.com/schema.json' }, checksum } }), new Response(schema));
    const definition = await new LiveAmazonApi(config(), fetcher).definition('TEST_PRODUCT', 'TEST_MARKET');
    assert.equal(definition.checksum, checksum);
    assert.ok(String(fetcher.mock.calls[1]?.arguments[0]).includes('requirementsEnforced=ENFORCED'));
  });
  it('拒绝定义链接重定向到任意站点', async () => {
    authorize();
    const fetcher = queuedFetch(json({ access_token: 'test-access', expires_in: 3600 }),
      json({ schema: { link: { resource: 'https://attacker.test/schema.json' }, checksum: 'invalid' } }));
    await assert.rejects(new LiveAmazonApi(config(), fetcher).definition('TEST_PRODUCT', 'TEST_MARKET'), { code: 'SCHEMA_URL' });
    assert.equal(fetcher.mock.callCount(), 2);
  });
  it('定义内容被替换时不能继续', async () => {
    authorize();
    const fetcher = queuedFetch(json({ access_token: 'test-access', expires_in: 3600 }),
      json({ schema: { link: { resource: 'https://test-schema.s3.amazonaws.com/schema.json' }, checksum: 'wrong-checksum' } }), json({ type: 'object' }));
    await assert.rejects(new LiveAmazonApi(config(), fetcher).definition('TEST_PRODUCT', 'TEST_MARKET'), { code: 'SCHEMA_CHECKSUM' });
  });
});
