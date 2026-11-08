import type { Profile } from '../config/profiles.js';
import { TokenProvider } from './auth.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`${method} ${path} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  /** ProblemDetails `code`, e.g. "DependencyConflict". */
  get code(): string | undefined {
    return (this.body as { code?: string } | undefined)?.code;
  }
}

export interface Page<T> {
  items: T[];
  pageIndex: number;
  pageSize: number;
  totalCount?: number;
}

const MAX_RETRIES = 5;

export class CmsClient {
  readonly tokens: TokenProvider;
  private readonly baseUrl: string;

  constructor(readonly profile: Profile) {
    this.tokens = new TokenProvider(profile);
    this.baseUrl = `${profile.apiBaseUrl}/v1`;
  }

  async request<T>(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.tokens.getToken()}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      const text = await res.text();
      const body = text ? safeJson(text) : undefined;
      if (!res.ok) throw new ApiError(res.status, method, path, body);
      return body as T;
    }
  }

  get<T>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, { headers });
  }

  /** Pages through a pageIndex/pageSize endpoint. totalCount is only an estimate, so stop on a short page. */
  async getAll<T>(path: string, pageSize = 100): Promise<T[]> {
    const all: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let pageIndex = 0; ; pageIndex++) {
      const page = await this.get<Page<T> | T[]>(`${path}${sep}pageIndex=${pageIndex}&pageSize=${pageSize}`);
      // Some endpoints (e.g. propertygroups) are not paged and return a plain array or a single page.
      if (Array.isArray(page)) return page;
      all.push(...page.items);
      if (page.pageSize === undefined || page.items.length < pageSize) return all;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
