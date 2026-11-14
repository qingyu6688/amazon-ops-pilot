import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { advanceRun, audit, getRun, startRun, validateCompliance } from './workflow.js';
import { authorizePublish, planDigest, validateScope } from './permissions.js';
import { SCHEMA_NOTICE, validateAttributes } from './schema.js';
import { readCustomSkill } from './custom-skills.js';
import { bodySchema, evidenceSchema, skuSchema, submissionSchema, type AmazonApi, type ListingBody, type Plan, type State, type Submission } from '../types/domain.js';
import { Store } from '../utils/store.js';
import { OpsError, requireCondition } from '../utils/errors.js';
import { digest } from '../utils/hash.js';

const PLAN_BLOCKING = new Set(['submitting', 'unknown', 'accepted']);
const READ_DATA = 'summaries,attributes,issues,offers,fulfillmentAvailability';

export class OpsService {
  constructor(readonly config: Config, readonly root: string, readonly store: Store, readonly api: AmazonApi) {}

  async status(): Promise<unknown> {
    const state = await this.store.read();
    return { mode: this.config.mode, simulated: this.config.mode === 'mock', sellerId: this.config.sellerId,
      marketplaceId: this.config.marketplaceId, region: this.config.region, writePolicy: this.config.writePolicy,
      runs: Object.values(state.runs).filter((run) => run.sellerId === this.config.sellerId && run.marketplaceId === this.config.marketplaceId),
      implemented: ['阶段与证据', '商品类型与定义', '目录查询', '单 SKU 新建 Listing', '验证预览', '回读', 'FBA 库存查询', '报表元数据', '自定义技能'],
      manualHandoffs: ['广告投放', 'FBA 入仓', '订单履约与退款', '认证与税务判断', '已有 SKU 修改'], schemaNotice: SCHEMA_NOTICE };
  }

  async start(sku: string): Promise<unknown> {
    return this.store.transaction(async (state, save) => {
      const run = startRun(state, skuSchema.parse(sku), this.config);
      await save();
      return run;
    });
  }

  async workflowGet(runId: string): Promise<unknown> {
    const state = await this.store.read();
    const run = getRun(state, runId, this.config);
    return { run, plans: Object.values(state.plans).filter((plan) => plan.runId === runId), customSkills: this.config.customSkills.filter((skill) => skill.stages.includes(run.stage)) };
  }

  async advance(runId: string, evidence: unknown): Promise<unknown> {
    return this.store.transaction(async (state, save) => {
      const run = advanceRun(state, getRun(state, runId, this.config), evidence, this.config);
      await save();
      return run;
    });
  }

  async customSkill(name: string): Promise<unknown> {
    return readCustomSkill(this.root, this.config, name);
  }

  async refreshCompliance(runId: string, input: unknown): Promise<unknown> {
    const evidence = evidenceSchema.parse(input);
    validateCompliance(evidence, this.config);
    return this.store.transaction(async (state, save) => {
      const run = getRun(state, runId, this.config);
      requireCondition(run.evidence.compliance, 'COMPLIANCE_NOT_REACHED', '任务尚未完成首次合规阶段，请先按主流程推进。');
      run.evidence.compliance = evidence;
      run.updatedAt = new Date().toISOString();
      audit(state, 'compliance.refresh', 'reviewed', { runId });
      await save();
      return run;
    });
  }

  async marketplaces(): Promise<unknown> {
    return this.api.request('GET', '/sellers/v1/marketplaceParticipations');
  }

  async productTypes(keywords: string): Promise<unknown> {
    return this.api.request('GET', '/definitions/2020-09-01/productTypes', { marketplaceIds: this.config.marketplaceId, keywords });
  }

  async definition(productType: string, attributeNames: string[] = []): Promise<unknown> {
    const definition = await this.api.definition(productType, this.config.marketplaceId);
    const properties = z.record(z.string(), z.unknown()).parse(definition.schema.properties ?? {});
    const selected = attributeNames.length ? Object.fromEntries(attributeNames.filter((name) => Object.hasOwn(properties, name)).map((name) => [name, properties[name]])) : undefined;
    return { metadata: definition.metadata, checksum: definition.checksum,
      required: definition.schema.required ?? [], attributeNames: Object.keys(properties),
      ...(selected ? { properties: selected, conditionalRequirements: definition.schema.allOf ?? [] } : {}), notice: SCHEMA_NOTICE };
  }

  async catalog(asin: string): Promise<unknown> {
    return this.api.request('GET', `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { marketplaceIds: this.config.marketplaceId, includedData: 'summaries,identifiers,attributes' });
  }

  private listingPath(sku: string): string {
    return `/listings/2021-08-01/items/${encodeURIComponent(this.config.sellerId)}/${encodeURIComponent(sku)}`;
  }

  async listing(sku: string): Promise<unknown> {
    return this.api.request('GET', this.listingPath(skuSchema.parse(sku)), { marketplaceIds: this.config.marketplaceId, includedData: READ_DATA });
  }

  async inventory(sku?: string, nextToken?: string): Promise<unknown> {
    return this.api.request('GET', '/fba/inventory/v1/summaries', { granularityType: 'Marketplace', granularityId: this.config.marketplaceId, marketplaceIds: this.config.marketplaceId, details: 'true', ...(sku ? { sellerSkus: skuSchema.parse(sku) } : {}), ...(nextToken ? { nextToken } : {}) });
  }

  async reports(reportType: 'GET_SALES_AND_TRAFFIC_REPORT' | 'GET_FBA_INVENTORY_PLANNING_DATA', nextToken?: string): Promise<unknown> {
    const response = z.object({ reports: z.array(z.object({ reportType: z.string(), marketplaceIds: z.array(z.string()).optional() }).passthrough()), nextToken: z.string().optional() }).passthrough().parse(await this.api.request('GET', '/reports/2021-06-30/reports', nextToken ? { nextToken } : { reportTypes: reportType, marketplaceIds: this.config.marketplaceId, pageSize: '10' }));
    return { ...response, reports: response.reports.filter((report) => report.reportType === reportType && (!report.marketplaceIds || report.marketplaceIds.includes(this.config.marketplaceId))) };
  }

  private async assertNewSku(sku: string): Promise<void> {
    try { await this.listing(sku); }
    catch (error: unknown) {
      if (error instanceof OpsError && error.status === 404) return;
      throw error;
    }
    throw new OpsError('SKU_EXISTS', '该 SKU 已存在；首版不执行可能覆盖已有数据的整项更新。');
  }

  private async checkParticipation(): Promise<void> {
    const result = z.object({ payload: z.array(z.object({ marketplace: z.object({ id: z.string() }), participation: z.object({ isParticipating: z.boolean() }) })) }).parse(await this.marketplaces());
    requireCondition(result.payload.some((item) => item.marketplace.id === this.config.marketplaceId && item.participation.isParticipating), 'MARKETPLACE_NOT_PARTICIPATING', '当前授权未参与目标站点，不能准备发布。');
  }

  private async preview(sku: string, body: ListingBody): Promise<Submission> {
    return submissionSchema.parse(await this.api.request('PUT', this.listingPath(sku), {
      marketplaceIds: this.config.marketplaceId, mode: 'VALIDATION_PREVIEW', includedData: 'issues'
    }, body, true));
  }

  private assertPreview(preview: Submission, acknowledgedWarnings: string[]): void {
    requireCondition(preview.status !== 'INVALID' && !preview.issues.some((issue) => issue.severity === 'ERROR'), 'PREVIEW_INVALID', 'Amazon 验证预览未通过；请用预览工具查看并修复问题。');
    requireCondition(!preview.issues.some((issue) => issue.severity === 'WARNING' && !acknowledgedWarnings.includes(issue.code)), 'WARNINGS_UNREVIEWED', '存在尚未确认的预览警告，请先检查警告代码。');
  }

  async validateListing(sku: string, input: unknown): Promise<unknown> {
    const body = bodySchema.parse(input);
    const definition = await this.api.definition(body.productType, this.config.marketplaceId);
    validateAttributes(body, definition);
    const preview = await this.preview(skuSchema.parse(sku), body);
    return { simulated: this.config.mode === 'mock', schemaChecksum: definition.checksum, preview, notice: SCHEMA_NOTICE };
  }

  async prepare(runId: string, input: unknown, acknowledgedWarnings: string[] = []): Promise<Plan> {
    const body = bodySchema.parse(input);
    return this.store.transaction(async (state, save) => {
      const run = getRun(state, runId, this.config);
      requireCondition(run.stage === 'listing', 'WORKFLOW_GATE', '请先按主流程完成需求、选品、合规、利润和供应链阶段。');
      requireCondition(run.evidence.compliance, 'COMPLIANCE_REQUIRED', '缺少合规证据。');
      validateCompliance(run.evidence.compliance, this.config);
      requireCondition(!Object.values(state.plans).some((plan) => plan.runId === runId && PLAN_BLOCKING.has(plan.status)), 'RUN_ALREADY_SUBMITTED', '任务已有已接收、提交中或结果未知的计划，不能另建计划重发。');
      validateScope(run.sku, body, this.config);
      await this.checkParticipation();
      await this.assertNewSku(run.sku);
      const definition = await this.api.definition(body.productType, this.config.marketplaceId);
      validateAttributes(body, definition);
      const preview = await this.preview(run.sku, body);
      this.assertPreview(preview, acknowledgedWarnings);
      const now = Date.now();
      const base = { id: randomUUID(), runId, mode: this.config.mode, sellerId: this.config.sellerId, marketplaceId: this.config.marketplaceId, region: this.config.region, sku: run.sku, body,
        schemaChecksum: definition.checksum, configDigest: digest(this.config), preview, acknowledgedWarnings,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.config.planTtlMinutes * 60_000).toISOString(), status: 'prepared' as const };
      const plan: Plan = { ...base, digest: planDigest(base) };
      state.plans[plan.id] = plan;
      audit(state, 'listing.prepare', 'validated', { runId, planId: plan.id });
      await save();
      return plan;
    });
  }

  private getPlan(state: State, planId: string): Plan {
    const plan = state.plans[planId];
    requireCondition(plan, 'PLAN_NOT_FOUND', '未找到发布计划。');
    requireCondition(plan.mode === this.config.mode && plan.region === this.config.region && plan.sellerId === this.config.sellerId && plan.marketplaceId === this.config.marketplaceId, 'PLAN_SCOPE', '计划与当前模式、区域、卖家或站点不一致。');
    return plan;
  }

  async approve(planId: string, approvedBy: string): Promise<unknown> {
    requireCondition(approvedBy.trim(), 'APPROVER_REQUIRED', '授权必须记录操作者。');
    return this.store.transaction(async (state, save) => {
      const plan = this.getPlan(state, planId);
      requireCondition(plan.status === 'prepared' && plan.digest === planDigest(plan) && Date.parse(plan.expiresAt) > Date.now(), 'PLAN_NOT_APPROVABLE', '计划已使用、过期或被修改，请重新准备。');
      const approval = { planId, digest: plan.digest, approvedBy, expiresAt: plan.expiresAt };
      state.approvals[planId] = approval;
      audit(state, 'listing.approve', 'approved', { runId: plan.runId, planId });
      await save();
      return approval;
    });
  }

  async publish(planId: string): Promise<Plan> {
    return this.store.transaction(async (state, save) => {
      const plan = this.getPlan(state, planId);
      const run = getRun(state, plan.runId, this.config);
      requireCondition(run.stage === 'listing', 'WORKFLOW_GATE', '当前任务不在上架阶段。');
      requireCondition(run.evidence.compliance, 'COMPLIANCE_REQUIRED', '缺少合规证据。');
      validateCompliance(run.evidence.compliance, this.config);
      authorizePublish(state, plan, this.config);
      requireCondition(!Object.values(state.plans).some((other) => other.id !== plan.id && other.runId === plan.runId && PLAN_BLOCKING.has(other.status)), 'RUN_ALREADY_SUBMITTED', '任务已有提交记录，不能通过另一个计划重复发布。');
      await this.checkParticipation();
      await this.assertNewSku(plan.sku);
      const definition = await this.api.definition(plan.body.productType, this.config.marketplaceId);
      requireCondition(definition.checksum === plan.schemaChecksum, 'SCHEMA_CHANGED', '商品定义已变化，请重新准备并授权计划。');
      validateAttributes(plan.body, definition);
      this.assertPreview(await this.preview(plan.sku, plan.body), plan.acknowledgedWarnings);
      // 网络检查可能耗时；在不可逆请求前重新检查期限与次数。
      authorizePublish(state, plan, this.config);
      plan.status = 'submitting';
      const approval = state.approvals[plan.id];
      if (approval) approval.consumedAt = new Date().toISOString();
      audit(state, 'publish.attempt', 'submitting', { runId: run.id, planId });
      await save();
      return this.submitOnce(plan, state, save);
    });
  }

  private async submitOnce(plan: Plan, state: State, save: () => Promise<void>): Promise<Plan> {
    try {
      const submission = submissionSchema.parse(await this.api.request('PUT', this.listingPath(plan.sku), { marketplaceIds: this.config.marketplaceId, includedData: 'issues' }, plan.body));
      plan.submission = submission;
      plan.status = submission.status === 'ACCEPTED' && submission.submissionId ? 'accepted' : submission.status === 'INVALID' ? 'invalid' : 'unknown';
    } catch {
      // 正式写入没有自动重试；即使响应丢失，也必须保留去重记录。
      plan.status = 'unknown';
    }
    audit(state, 'publish.result', plan.status, { runId: plan.runId, planId: plan.id });
    await save();
    return plan;
  }

  async verify(planId: string): Promise<unknown> {
    return this.store.transaction(async (state, save) => {
      const plan = this.getPlan(state, planId);
      const listing = z.object({ summaries: z.array(z.object({ marketplaceId: z.string(), status: z.array(z.string()).default([]) })).default([]), issues: z.array(z.object({ severity: z.string() })).default([]) }).passthrough().parse(await this.listing(plan.sku));
      const buyable = listing.summaries.some((summary) => summary.marketplaceId === plan.marketplaceId && summary.status.includes('BUYABLE'));
      const verification = { checkedAt: new Date().toISOString(), buyable, hasErrors: listing.issues.some((issue) => issue.severity === 'ERROR'), listing, note: plan.status === 'unknown' || plan.status === 'submitting' ? '当前只证明观察到的状态；未知提交不会因此自动判定成功。' : '平台接收与前台可售分别记录。' };
      plan.verification = verification;
      audit(state, 'listing.verify', buyable ? 'buyable' : 'not_buyable', { runId: plan.runId, planId });
      await save();
      return verification;
    });
  }
}
