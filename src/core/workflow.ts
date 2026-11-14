import { randomUUID } from 'node:crypto';
import { STAGES, evidenceSchema, type Evidence, type Run, type Stage, type State } from '../types/domain.js';
import type { Config } from './config.js';
import { requireCondition } from '../utils/errors.js';

export const STAGE_LABELS: Record<Stage, string> = {
  discovery: '需求确认', selection: '选品', compliance: '合规', economics: '利润', sourcing: '供应链',
  listing: '上架', fulfillment: '履约', launch: '启动', operations: '日常运营', review: '复盘'
};

export function audit(state: State, action: string, outcome: string, ids: { runId?: string; planId?: string } = {}): void {
  state.audit.push({ id: randomUUID(), at: new Date().toISOString(), action, outcome, ...ids });
}

export function getRun(state: State, id: string, config: Config): Run {
  const run = state.runs[id];
  requireCondition(run, 'RUN_NOT_FOUND', '未找到运营任务。');
  requireCondition(run.mode === config.mode && run.sellerId === config.sellerId && run.marketplaceId === config.marketplaceId, 'RUN_SCOPE', '任务与当前模式、卖家或站点不一致。');
  return run;
}

export function startRun(state: State, sku: string, config: Config): Run {
  const duplicate = Object.values(state.runs).some((run) => run.sku === sku && run.mode === config.mode && run.sellerId === config.sellerId && run.marketplaceId === config.marketplaceId);
  requireCondition(!duplicate, 'DUPLICATE_RUN', '同一卖家、站点、SKU 已有任务，请继续已有任务。');
  const now = new Date().toISOString();
  const run: Run = { id: randomUUID(), mode: config.mode, sellerId: config.sellerId, marketplaceId: config.marketplaceId, sku, stage: 'discovery', evidence: {}, createdAt: now, updatedAt: now };
  state.runs[run.id] = run;
  audit(state, 'workflow.start', 'created', { runId: run.id });
  return run;
}

export function validateCompliance(evidence: Evidence, config: Config, now = Date.now()): void {
  const reviewed = Date.parse(evidence.reviewedAt ?? '');
  requireCondition(Number.isFinite(reviewed) && reviewed <= now && now - reviewed <= config.policyMaxAgeDays * 86_400_000, 'POLICY_STALE', '合规复核时间缺失、在未来或超过本项目配置的有效期。');
  requireCondition(evidence.policySources?.length, 'POLICY_SOURCES', '合规阶段必须记录实际核对的官方规则链接。');
  for (const source of evidence.policySources) {
    const url = new URL(source);
    const official = /(^|\.)amazon\.(com|cn|co\.uk|co\.jp|de|fr|it|es|ca|com\.au|in)$/u.test(url.hostname) || url.hostname === 'developer-docs.amazon';
    requireCondition(url.protocol === 'https:' && official && !url.username && !url.password, 'POLICY_SOURCE_HOST', '平台规则必须引用 Amazon 官方 HTTPS 页面。');
  }
}

export function advanceRun(state: State, run: Run, input: unknown, config: Config): Run {
  const evidence = evidenceSchema.parse(input);
  if (run.stage === 'compliance') validateCompliance(evidence, config);
  if (run.stage === 'listing') {
    requireCondition(Object.values(state.plans).some((plan) => plan.runId === run.id && plan.status === 'accepted'), 'LISTING_NOT_ACCEPTED', '尚无平台接收回执，不能完成上架提交阶段。');
  }
  if (run.stage === 'launch') {
    requireCondition(Object.values(state.plans).some((plan) => plan.runId === run.id && plan.status === 'accepted' && plan.verification?.buyable === true && plan.verification?.hasErrors === false && typeof plan.verification.checkedAt === 'string' && Date.now() - Date.parse(plan.verification.checkedAt) <= 300_000), 'NOT_BUYABLE', '请先在五分钟内回读 Listing，确认对应站点可售且没有错误级问题。');
  }
  run.evidence[run.stage] = evidence;
  run.stage = STAGES[STAGES.indexOf(run.stage) + 1] ?? 'operations';
  run.updatedAt = new Date().toISOString();
  audit(state, 'workflow.advance', run.stage, { runId: run.id });
  return run;
}
