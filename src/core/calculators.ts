import { z } from 'zod';

export const economicsSchema = z.object({
  unitPrice: z.number().positive(), purchase: z.number().nonnegative(), packaging: z.number().nonnegative(),
  freightAndImport: z.number().nonnegative(), platform: z.number().nonnegative(), fulfillment: z.number().nonnegative(),
  returnsReserve: z.number().nonnegative(), advertising: z.number().nonnegative(), otherVariable: z.number().nonnegative().default(0)
}).strict();

export function economics(input: z.infer<typeof economicsSchema>): Record<string, number | string> {
  const { unitPrice, advertising, ...costs } = input;
  const beforeAds = unitPrice - Object.values(costs).reduce((sum, value) => sum + value, 0);
  return { contributionBeforeAds: Number(beforeAds.toFixed(4)), contributionAfterAds: Number((beforeAds - advertising).toFixed(4)),
    breakEvenAcos: beforeAds / unitPrice, notice: '这是按输入计算的单件贡献，不是净利润；未计入的固定开支和适用税费需另算。' };
}

export const replenishmentSchema = z.object({
  averageDailySales: z.number().nonnegative(), sellable: z.number().int().nonnegative(),
  reliableInbound: z.number().int().nonnegative(), leadTimeDays: z.number().int().nonnegative(), safetyDays: z.number().int().nonnegative()
}).strict();

export function replenishment(input: z.infer<typeof replenishmentSchema>): Record<string, number | null | string> {
  const target = Math.ceil(input.averageDailySales * (input.leadTimeDays + input.safetyDays));
  return { coverageDays: input.averageDailySales ? input.sellable / input.averageDailySales : null,
    targetUnits: target, suggestedUnits: Math.max(0, target - input.sellable - input.reliableInbound),
    notice: '仅作规划；可靠在途必须能在需要时间前到达，还应核对季节、库容、最小采购量与资金。不会自动采购。' };
}
