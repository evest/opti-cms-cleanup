import type { Profile } from '../config/profiles.js';

// Tokens live for ~300s; refresh a bit early.
const REFRESH_MARGIN_MS = 30_000;
const MAX_RETRIES = 5;

export class TokenProvider {
  private token?: string;
  private expiresAt = 0;
  /** Shared by concurrent callers, so parallel requests at startup fetch one token, not one each. */
  private pending?: Promise<string>;

  constructor(private readonly profile: Profile) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.token;
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.profile.apiBaseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.profile.clientId,
          client_secret: this.profile.clientSecret,
        }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { access_token: string; expires_in: number };
      this.token = body.access_token;
      this.expiresAt = Date.now() + body.expires_in * 1000;
      return this.token;
    }
  }

  /** Decoded (unverified) JWT payload; used to confirm which instance the credentials point at. */
  async getClaims(): Promise<TokenClaims> {
    const payload = (await this.getToken()).split('.')[1] ?? '';
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenClaims;
  }
}

export interface TokenClaims {
  sub: string;
  scope?: string;
  instanceId?: string;
  siteUrl?: string;
}
