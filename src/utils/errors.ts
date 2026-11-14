import { ZodError } from 'zod';

export class OpsError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'OpsError';
  }
}

export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new OpsError(code, message);
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof OpsError) return { code: error.code, message: error.message };
  if (error instanceof ZodError) {
    return { code: 'INVALID_INPUT', message: `参数不符合要求：${error.issues.map((issue) => issue.path.join('.') || '根对象').join('、')}` };
  }
  return { code: 'INTERNAL_ERROR', message: '操作未完成。请检查配置、文件权限和网络；不要在重试前假定平台写入失败。' };
}
