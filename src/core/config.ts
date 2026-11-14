import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { modeSchema, stageSchema } from '../types/domain.js';

const scopeSchema = z.object({
  skuPrefix: z.string().min(2), productTypes: z.array(z.string()).min(1),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  minPrice: z.number().positive(), maxPrice: z.number().positive(),
  maxQuantity: z.number().int().nonnegative(),
  fulfillmentChannels: z.array(z.string()).min(1)
}).strict().refine((scope) => scope.maxPrice >= scope.minPrice, '价格上限不能小于下限');

export const configSchema = z.object({
  version: z.literal(1), mode: modeSchema,
  sellerId: z.string().min(1), marketplaceId: z.string().min(1), region: z.enum(['NA', 'EU', 'FE']),
  stateDirectory: z.string().default('.amazon-ops'),
  policyMaxAgeDays: z.number().int().min(1).max(365).default(7),
  planTtlMinutes: z.number().int().min(1).max(60).default(15),
  writePolicy: z.object({
    mode: z.enum(['disabled', 'approval', 'bounded']),
    expiresAt: z.iso.datetime(), maxDailySubmissions: z.number().int().min(1).max(100),
    authorizedBy: z.string().min(1), scope: scopeSchema
  }).strict(),
  customSkills: z.array(z.object({
    name: z.string().regex(/^[a-z0-9-]+$/u), path: z.string(), stages: z.array(stageSchema).min(1)
  }).strict()).default([])
}).strict().refine((config) => new Set(config.customSkills.map((skill) => skill.name)).size === config.customSkills.length, '自定义技能名称不能重复');

export type Config = z.infer<typeof configSchema>;
export interface LoadedConfig { config: Config; root: string }

export async function loadConfig(path = process.env.AMAZON_OPS_CONFIG ?? 'amazon-ops.config.json'): Promise<LoadedConfig> {
  const absolute = resolve(path);
  return { config: configSchema.parse(JSON.parse(await readFile(absolute, 'utf8'))), root: dirname(absolute) };
}
