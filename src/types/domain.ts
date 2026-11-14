import { z } from 'zod';

export const STAGES = ['discovery', 'selection', 'compliance', 'economics', 'sourcing', 'listing', 'fulfillment', 'launch', 'operations', 'review'] as const;
export const stageSchema = z.enum(STAGES);
export const modeSchema = z.enum(['mock', 'live']);
export const skuSchema = z.string().min(1).max(40)
  .refine((value) => !/\p{Cc}/u.test(value), '商品编号不能包含控制字符')
  .refine((value) => value !== '.' && value !== '..', '商品编号不能是路径保留段');
export const bodySchema = z.object({
  productType: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/u),
  requirements: z.literal('LISTING'),
  attributes: z.record(z.string(), z.unknown())
}).strict();
export const issueSchema = z.object({
  code: z.string(), message: z.string(), severity: z.enum(['ERROR', 'WARNING', 'INFO'])
}).passthrough();
export const submissionSchema = z.object({
  status: z.enum(['ACCEPTED', 'INVALID', 'VALID']),
  submissionId: z.string().optional(),
  issues: z.array(issueSchema).default([])
}).passthrough();
export const evidenceSchema = z.object({
  confirmed: z.literal(true),
  reference: z.string().min(3).max(2000),
  notes: z.string().max(4000).default(''),
  reviewedAt: z.iso.datetime().optional(),
  policySources: z.array(z.url()).optional()
}).strict();
export const runSchema = z.object({
  id: z.string(), mode: modeSchema, sellerId: z.string(), marketplaceId: z.string(),
  sku: skuSchema, stage: stageSchema,
  evidence: z.record(z.string(), evidenceSchema),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
});
export const planSchema = z.object({
  id: z.string(), runId: z.string(), mode: modeSchema,
  sellerId: z.string(), marketplaceId: z.string(), region: z.enum(['NA', 'EU', 'FE']), sku: skuSchema,
  body: bodySchema, schemaChecksum: z.string(), configDigest: z.string(),
  preview: submissionSchema, acknowledgedWarnings: z.array(z.string()),
  digest: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  status: z.enum(['prepared', 'submitting', 'accepted', 'invalid', 'unknown']),
  submission: submissionSchema.optional(), verification: z.record(z.string(), z.unknown()).optional()
});
export const approvalSchema = z.object({
  planId: z.string(), digest: z.string(), approvedBy: z.string().min(1),
  expiresAt: z.iso.datetime(), consumedAt: z.iso.datetime().optional()
});
export const auditSchema = z.object({
  id: z.string(), at: z.iso.datetime(), action: z.string(),
  runId: z.string().optional(), planId: z.string().optional(), outcome: z.string()
});
export const stateSchema = z.object({
  version: z.literal(1),
  runs: z.record(z.string(), runSchema), plans: z.record(z.string(), planSchema),
  approvals: z.record(z.string(), approvalSchema), audit: z.array(auditSchema)
});

export type Stage = z.infer<typeof stageSchema>;
export type ListingBody = z.infer<typeof bodySchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Run = z.infer<typeof runSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Submission = z.infer<typeof submissionSchema>;
export type State = z.infer<typeof stateSchema>;
export interface Definition {
  metadata: Record<string, unknown>;
  schema: Record<string, unknown>;
  checksum: string;
}
export interface AmazonApi {
  request(method: 'GET' | 'PUT', path: string, query?: Record<string, string>, body?: unknown, preview?: boolean): Promise<unknown>;
  definition(productType: string, marketplaceId: string): Promise<Definition>;
}
