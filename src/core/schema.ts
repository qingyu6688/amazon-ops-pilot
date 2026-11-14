import { Ajv2019 } from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import type { Definition, ListingBody } from '../types/domain.js';
import { OpsError, requireCondition } from '../utils/errors.js';

export const SCHEMA_NOTICE = '本地仅校验标准 JSON Schema 2019-09 词汇；Amazon 自定义词汇及平台业务约束以强制验证预览与提交后问题为准。';

export function validateAttributes(body: ListingBody, definition: Definition): void {
  const schema = structuredClone(definition.schema);
  // Amazon 元模式 URI 不提供网络下载；本地检查不冒充完整的平台规则引擎。
  delete schema.$schema;
  delete schema.$id;
  delete schema.$vocabulary;
  const validator = new Ajv2019({ strict: false, allErrors: true, validateFormats: true });
  addFormats.default(validator);
  let validate;
  try { validate = validator.compile(schema); }
  catch { throw new OpsError('SCHEMA_UNSUPPORTED', '商品定义包含本地无法处理的结构；请检查定义，不能跳过后直接发布。'); }
  requireCondition(validate(body.attributes), 'ATTRIBUTES_INVALID', `商品属性未通过本地定义检查：${validate.errors?.map((error) => `${error.instancePath || '/'}${typeof error.params.missingProperty === 'string' ? ` 缺少 ${error.params.missingProperty}` : ''}（${error.keyword}）`).join('；') ?? '未知属性问题'}`);
}
