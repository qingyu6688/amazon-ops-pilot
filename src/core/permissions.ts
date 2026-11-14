import { z } from 'zod';
import type { Config } from './config.js';
import type { ListingBody, Plan, State } from '../types/domain.js';
import { requireCondition } from '../utils/errors.js';
import { digest } from '../utils/hash.js';

const priceSchema = z.object({ schedule: z.array(z.object({ value_with_tax: z.number().positive(), start_at: z.string().optional(), end_at: z.string().optional() }).strict()).min(1) }).strict();
const offerSchema = z.object({
  currency: z.string(), marketplace_id: z.string(), audience: z.enum(['ALL', 'B2B']).optional(),
  our_price: z.array(priceSchema).min(1)
}).strict();
const fulfillmentSchema = z.object({ fulfillment_channel_code: z.string(), quantity: z.number().int().nonnegative().optional(), lead_time_to_ship_max_days: z.number().int().nonnegative().optional() }).strict();

export function validateScope(sku: string, body: ListingBody, config: Config): void {
  const scope = config.writePolicy.scope;
  requireCondition(sku.startsWith(scope.skuPrefix), 'SKU_SCOPE', '商品编号不在已配置的前缀范围内。');
  requireCondition(scope.productTypes.includes(body.productType), 'PRODUCT_TYPE_SCOPE', '商品类型不在已配置范围内。');
  const offers = z.array(offerSchema).min(1).parse(body.attributes.purchasable_offer);
  for (const offer of offers) {
    requireCondition(offer.currency === scope.currency && offer.marketplace_id === config.marketplaceId, 'OFFER_SCOPE', '报价币种或站点不在授权范围内。');
    for (const price of offer.our_price.flatMap((item) => item.schedule)) {
      requireCondition(price.value_with_tax >= scope.minPrice && price.value_with_tax <= scope.maxPrice, 'PRICE_SCOPE', '商品价格超出已配置上下限。');
    }
  }
  const availability = z.array(fulfillmentSchema).min(1).parse(body.attributes.fulfillment_availability);
  requireCondition(availability.every((item) => scope.fulfillmentChannels.includes(item.fulfillment_channel_code)), 'FULFILLMENT_SCOPE', '配送渠道不在授权范围内。');
  requireCondition(availability.reduce((sum, item) => sum + (item.quantity ?? 0), 0) <= scope.maxQuantity, 'QUANTITY_SCOPE', '提交的库存数量超出授权上限。');
  verifyMarketplaceAttributes(body.attributes, config.marketplaceId);
}

function verifyMarketplaceAttributes(value: unknown, marketplaceId: string): void {
  if (Array.isArray(value)) {
    for (const item of value) verifyMarketplaceAttributes(item, marketplaceId);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'marketplace_id') requireCondition(item === marketplaceId, 'ATTRIBUTE_MARKETPLACE', '属性中混入了其他站点。');
      verifyMarketplaceAttributes(item, marketplaceId);
    }
  }
}

export function planDigest(plan: Omit<Plan, 'digest'> | Plan): string {
  return digest({ id: plan.id, runId: plan.runId, mode: plan.mode, sellerId: plan.sellerId,
    marketplaceId: plan.marketplaceId, region: plan.region, sku: plan.sku, body: plan.body,
    schemaChecksum: plan.schemaChecksum, configDigest: plan.configDigest,
    acknowledgedWarnings: plan.acknowledgedWarnings, createdAt: plan.createdAt, expiresAt: plan.expiresAt });
}

export function authorizePublish(state: State, plan: Plan, config: Config, now = Date.now()): void {
  requireCondition(config.writePolicy.mode !== 'disabled', 'WRITE_DISABLED', '正式提交已禁用；可继续查询、准备草稿和验证预览。');
  requireCondition(Date.parse(config.writePolicy.expiresAt) > now, 'WRITE_POLICY_EXPIRED', '发布策略已过期，请由操作者更新授权。');
  requireCondition(Date.parse(plan.expiresAt) > now, 'PLAN_EXPIRED', '计划已过期，请重新获取商品定义并验证。');
  requireCondition(plan.status === 'prepared', 'PLAN_ALREADY_USED', '计划已提交、正在提交或结果未知，不能重复发送。');
  requireCondition(plan.digest === planDigest(plan), 'PLAN_TAMPERED', '计划内容与摘要不一致，不能发布。');
  requireCondition(plan.configDigest === digest(config), 'CONFIG_CHANGED', '配置已变化，请重新准备计划。');
  validateScope(plan.sku, plan.body, config);
  const day = new Date(now).toISOString().slice(0, 10);
  const attempts = state.audit.filter((entry) => entry.action === 'publish.attempt' && entry.at.startsWith(day)).length;
  requireCondition(attempts < config.writePolicy.maxDailySubmissions, 'DAILY_LIMIT', '已达到 UTC 自然日发布次数上限，未知结果也计入。');
  if (config.writePolicy.mode === 'approval') {
    const approval = state.approvals[plan.id];
    requireCondition(approval && approval.digest === plan.digest && Date.parse(approval.expiresAt) > now && !approval.consumedAt, 'APPROVAL_REQUIRED', '需要操作者为此计划创建未过期的一次性授权。');
  }
}
