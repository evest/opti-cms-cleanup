import type { Profile } from '../config/profiles.js';

// Tokens live for ~300s; refresh a bit early.
const REFRESH_MARGIN_MS = 30_000;

export class TokenProvider {
  private token?: string;
  private expiresAt = 0;

  constructor(private readonly profile: Profile) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.token;

    const res = await fetch(`${this.profile.apiBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.profile.clientId,
        client_secret: this.profile.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
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
