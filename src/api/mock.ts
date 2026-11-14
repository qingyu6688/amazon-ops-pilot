import type { AmazonApi, Definition, Plan } from '../types/domain.js';
import type { Config } from '../core/config.js';
import { OpsError } from '../utils/errors.js';
import { digest } from '../utils/hash.js';

const SCHEMA: Record<string, unknown> = {
  type: 'object', required: ['item_name', 'brand', 'purchasable_offer', 'fulfillment_availability'],
  properties: {
    item_name: { type: 'array', minItems: 1, items: { type: 'object', required: ['value'], properties: { value: { type: 'string', minLength: 1 } } } },
    brand: { type: 'array', minItems: 1 }, purchasable_offer: { type: 'array', minItems: 1 },
    fulfillment_availability: { type: 'array', minItems: 1 }
  }
};

export class MockAmazonApi implements AmazonApi {
  constructor(private readonly config: Config, private readonly plans: () => Promise<Plan[]>) {}

  async request(method: 'GET' | 'PUT', path: string, _query: Record<string, string> = {}, body?: unknown, preview = false): Promise<unknown> {
    if (path === '/sellers/v1/marketplaceParticipations') return { payload: [{ marketplace: { id: this.config.marketplaceId }, participation: { isParticipating: true } }] };
    if (path === '/definitions/2020-09-01/productTypes') return { productTypes: [{ name: 'DEMO_PRODUCT', displayName: '模拟商品类型，仅供演练' }] };
    if (path.startsWith('/listings/')) {
      const sku = decodeURIComponent(path.split('/').at(-1) ?? '');
      if (method === 'PUT') return { status: preview ? 'VALID' : 'ACCEPTED', submissionId: `mock-${digest(body).slice(0, 16)}`, issues: [] };
      const found = (await this.plans()).find((plan) => plan.sku === sku && plan.status === 'accepted');
      if (!found) throw new OpsError('AMAZON_HTTP', '模拟商品不存在。', 404);
      return { sku, summaries: [{ marketplaceId: this.config.marketplaceId, asin: 'DEMOASIN01', status: ['BUYABLE', 'DISCOVERABLE'] }], attributes: found.body.attributes, issues: [] };
    }
    if (path.startsWith('/fba/inventory/')) return { payload: { inventorySummaries: [], note: '模拟库存，不代表生产库存。' } };
    if (path.startsWith('/reports/')) return { reports: [], note: '模拟报表元数据。' };
    if (path.startsWith('/catalog/')) return { asin: path.split('/').at(-1), note: '模拟目录数据。' };
    throw new OpsError('MOCK_UNSUPPORTED', '模拟模式尚未提供此接口。');
  }

  async definition(productType: string, _marketplaceId: string): Promise<Definition> {
    if (productType !== 'DEMO_PRODUCT') throw new OpsError('MOCK_PRODUCT_TYPE', '模拟模式只支持 DEMO_PRODUCT，不能当作真实类目定义。');
    return { metadata: { productType, simulated: true }, schema: structuredClone(SCHEMA), checksum: digest(SCHEMA) };
  }
}
