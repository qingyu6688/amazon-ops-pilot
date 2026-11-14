import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AmazonApi, Definition } from '../types/domain.js';
import type { Config } from '../core/config.js';
import { OpsError, requireCondition } from '../utils/errors.js';

const ENDPOINTS = { NA: 'https://sellingpartnerapi-na.amazon.com', EU: 'https://sellingpartnerapi-eu.amazon.com', FE: 'https://sellingpartnerapi-fe.amazon.com' } as const;
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const sleep = async (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds));

async function limitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  requireCondition(reader, 'EMPTY_RESPONSE', '平台响应缺少响应体。');
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new OpsError('RESPONSE_TOO_LARGE', '平台响应超过本项目允许的大小。');
    }
    parts.push(part.value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export class LiveAmazonApi implements AmazonApi {
  private token = '';
  private expiresAt = 0;
  private tokenRequest: Promise<string> | undefined;
  private readonly credentials: { clientId: string; clientSecret: string; refreshToken: string };

  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {
    const { AMAZON_LWA_CLIENT_ID: clientId, AMAZON_LWA_CLIENT_SECRET: clientSecret, AMAZON_LWA_REFRESH_TOKEN: refreshToken } = process.env;
    requireCondition(clientId && clientSecret && refreshToken, 'CREDENTIALS_MISSING', '生产模式需要配置 LWA 客户端、密钥和刷新令牌；不要把凭据发到对话中。');
    this.credentials = { clientId, clientSecret, refreshToken };
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    this.tokenRequest ??= this.refreshAccessToken();
    try { return await this.tokenRequest; }
    finally { this.tokenRequest = undefined; }
  }

  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret, refresh_token: this.credentials.refreshToken });
    let response: Response;
    try {
      response = await this.fetcher('https://api.amazon.com/auth/o2/token', {
        method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch { throw new OpsError('LWA_NETWORK', 'LWA 认证请求未完成，请检查网络。'); }
    requireCondition(response.ok, 'LWA_AUTH', `LWA 认证失败（HTTP ${response.status}），请检查授权及凭据。`);
    const result = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(JSON.parse(await limitedText(response)));
    this.token = result.access_token;
    this.expiresAt = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
    return this.token;
  }

  async request(method: 'GET' | 'PUT', path: string, query: Record<string, string> = {}, body?: unknown, preview = false): Promise<unknown> {
    const url = new URL(path, ENDPOINTS[this.config.region]);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const attempts = method === 'GET' || preview ? MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await this.send(method, url, body);
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Math.min(5000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
        await response.body?.cancel();
        await sleep(wait);
        continue;
      }
      if (!response.ok) {
        if (response.status === 401) this.expiresAt = 0;
        await response.body?.cancel();
        throw new OpsError('AMAZON_HTTP', `Amazon 接口返回 HTTP ${response.status}；请检查权限、参数、限流和服务状态。`, response.status);
      }
      return JSON.parse(await limitedText(response)) as unknown;
    }
    throw new OpsError('AMAZON_RETRY_EXHAUSTED', '读取或验证请求已达到重试上限。');
  }

  private async send(method: 'GET' | 'PUT', url: URL, body: unknown): Promise<Response> {
    const token = await this.accessToken();
    try {
      return await this.fetcher(url, {
        method, headers: { 'x-amz-access-token': token, 'content-type': 'application/json', 'user-agent': 'amazon-ops-pilot/1.0.0 (Language=TypeScript)', 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/gu, '') },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch { throw new OpsError('AMAZON_NETWORK', 'Amazon 请求结果未确认；若涉及正式提交，必须先回读核对，不能直接重发。'); }
  }

  async definition(productType: string, marketplaceId: string): Promise<Definition> {
    const metadata = z.record(z.string(), z.unknown()).parse(await this.request('GET', `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`, {
      marketplaceIds: marketplaceId, sellerId: this.config.sellerId, requirements: 'LISTING', requirementsEnforced: 'ENFORCED', productTypeVersion: 'LATEST'
    }));
    const descriptor = z.object({ schema: z.object({ link: z.object({ resource: z.url() }), checksum: z.string().min(1) }) }).parse(metadata);
    const url = new URL(descriptor.schema.link.resource);
    requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)(amazonaws\.com|amazon\.com)$/u.test(url.hostname), 'SCHEMA_URL', '平台定义链接不在允许的 Amazon HTTPS 域名中。');
    const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    requireCondition(response.ok, 'SCHEMA_DOWNLOAD', '商品定义下载失败，请重新获取定义。');
    const text = await limitedText(response);
    requireCondition(createHash('md5').update(text).digest('base64') === descriptor.schema.checksum, 'SCHEMA_CHECKSUM', '商品定义校验和不匹配，已停止。');
    return { metadata, schema: z.record(z.string(), z.unknown()).parse(JSON.parse(text)), checksum: descriptor.schema.checksum };
  }
}
