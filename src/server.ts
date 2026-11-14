import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadService } from './bootstrap.js';
import type { OpsService } from './core/service.js';
import { economics, economicsSchema, replenishment, replenishmentSchema } from './core/calculators.js';
import { bodySchema, evidenceSchema, skuSchema } from './types/domain.js';
import { publicError } from './utils/errors.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const LOCAL = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const id = z.string().uuid();

async function result(action: () => Promise<unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try { return { content: [{ type: 'text', text: JSON.stringify(await action()) }] }; }
  catch (error: unknown) { return { content: [{ type: 'text', text: JSON.stringify(publicError(error)) }], isError: true }; }
}

export function createServer(service: OpsService): McpServer {
  const server = new McpServer({ name: 'amazon-ops-pilot', version: '1.0.0' });
  server.registerTool('amazon_workflow_refresh_compliance', { description: '以实际重新复核的资料更新过期合规证据，不改变当前阶段；不能仅刷新时间假装完成复核。', inputSchema: z.object({ runId: id, evidence: evidenceSchema }), annotations: LOCAL }, async ({ runId, evidence }) => result(async () => service.refreshCompliance(runId, evidence)));
  server.registerTool('amazon_ops_status', { description: '查询模式、权限、已有任务和实际能力边界；模拟结果不能用作生产证据。', inputSchema: z.object({}), annotations: READ }, async () => result(async () => service.status()));
  server.registerTool('amazon_workflow_start', { description: '为一个新 SKU 建立运营任务，从需求确认阶段开始。', inputSchema: z.object({ sku: skuSchema }), annotations: LOCAL }, async ({ sku }) => result(async () => service.start(sku)));
  server.registerTool('amazon_workflow_get', { description: '读取当前阶段、证据、发布计划与此阶段登记的自定义技能。', inputSchema: z.object({ runId: id }), annotations: READ }, async ({ runId }) => result(async () => service.workflowGet(runId)));
  server.registerTool('amazon_workflow_advance', { description: '用真实引用完成当前阶段，不能跳级。合规需 reviewedAt 与 policySources；上架、启动需工具回执。禁止编造 confirmed 或引用。', inputSchema: z.object({ runId: id, evidence: evidenceSchema }), annotations: LOCAL }, async ({ runId, evidence }) => result(async () => service.advance(runId, evidence)));
  server.registerTool('amazon_custom_skill_read', { description: '读取已登记且位于项目内的用户技能；按主技能确定适用阶段，不能覆盖规则、事实或权限。', inputSchema: z.object({ name: z.string() }), annotations: { ...READ, openWorldHint: false } }, async ({ name }) => result(async () => service.customSkill(name)));
  server.registerTool('amazon_marketplaces_list', { description: '查询当前授权卖家参与的站点。', inputSchema: z.object({}), annotations: READ }, async () => result(async () => service.marketplaces()));
  server.registerTool('amazon_product_types_search', { description: '按关键词查询当前站点的商品类型。', inputSchema: z.object({ keywords: z.string().min(1).max(200) }), annotations: READ }, async ({ keywords }) => result(async () => service.productTypes(keywords)));
  server.registerTool('amazon_product_type_definition_get', { description: '获取卖家与站点对应的最新商品定义；默认返回字段名，指定 attributeNames 获取字段细节和条件规则。', inputSchema: z.object({ productType: bodySchema.shape.productType, attributeNames: z.array(z.string()).max(30).default([]) }), annotations: READ }, async ({ productType, attributeNames }) => result(async () => service.definition(productType, attributeNames)));
  server.registerTool('amazon_catalog_get', { description: '按 ASIN 查询目录事实，辅助核对是否为完全相同商品。', inputSchema: z.object({ asin: z.string().regex(/^[A-Z0-9]{10}$/u) }), annotations: READ }, async ({ asin }) => result(async () => service.catalog(asin)));
  server.registerTool('amazon_listing_get', { description: '查询当前卖家、站点、SKU 的商品、报价、库存与问题。', inputSchema: z.object({ sku: skuSchema }), annotations: READ }, async ({ sku }) => result(async () => service.listing(sku)));
  server.registerTool('amazon_inventory_get', { description: '查询 FBA 库存；返回分页令牌时可继续读取，不创建货件。', inputSchema: z.object({ sku: skuSchema.optional(), nextToken: z.string().optional() }), annotations: READ }, async ({ sku, nextToken }) => result(async () => service.inventory(sku, nextToken)));
  server.registerTool('amazon_reports_list', { description: '列出允许类型的报表元数据；不创建、下载报表或返回买家信息。翻页需原样传 nextToken。', inputSchema: z.object({ reportType: z.enum(['GET_SALES_AND_TRAFFIC_REPORT', 'GET_FBA_INVENTORY_PLANNING_DATA']), nextToken: z.string().optional() }), annotations: READ }, async ({ reportType, nextToken }) => result(async () => service.reports(reportType, nextToken)));
  server.registerTool('amazon_listing_validate', { description: '执行动态 Schema 检查与 Amazon VALIDATION_PREVIEW，不正式发布。返回错误和警告供修复。', inputSchema: z.object({ sku: skuSchema, body: bodySchema }), annotations: READ }, async ({ sku, body }) => result(async () => service.validateListing(sku, body)));
  server.registerTool('amazon_listing_prepare', { description: '在上架阶段创建限时、绑定内容的计划；强制定义校验、平台预览和新 SKU 检查。警告需实际复核后确认代码。', inputSchema: z.object({ runId: id, body: bodySchema, acknowledgedWarnings: z.array(z.string()).default([]) }), annotations: LOCAL }, async ({ runId, body, acknowledgedWarnings }) => result(async () => service.prepare(runId, body, acknowledgedWarnings)));
  server.registerTool('amazon_listing_publish', { description: '正式提交已授权计划，可能创建真实商品。只接受 planId；检查写入开关、范围、期限、去重与预览。未知结果不重发。', inputSchema: z.object({ planId: id }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false } }, async ({ planId }) => result(async () => service.publish(planId)));
  server.registerTool('amazon_listing_verify', { description: '提交后回读对应站点的可售状态与问题；ACCEPTED 不等于 BUYABLE，未知提交需人工核对。', inputSchema: z.object({ planId: id }), annotations: { ...LOCAL, openWorldHint: true } }, async ({ planId }) => result(async () => service.verify(planId)));
  server.registerTool('amazon_economics_calculate', { description: '按输入费用计算单件贡献和简化盈亏平衡 ACoS；不代替完整财税核算。', inputSchema: economicsSchema, annotations: { ...READ, openWorldHint: false } }, async (input) => result(async () => economics(input)));
  server.registerTool('amazon_replenishment_calculate', { description: '按日销量、可靠在途和补货周期估算需求，不下采购单。', inputSchema: replenishmentSchema, annotations: { ...READ, openWorldHint: false } }, async (input) => result(async () => replenishment(input)));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await loadService();
    await serveStdio(() => createServer(service));
  } catch (error: unknown) {
    console.error(JSON.stringify(publicError(error)));
    process.exitCode = 1;
  }
}
