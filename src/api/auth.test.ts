import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '../config/profiles.js';
import { TokenProvider } from './auth.js';

const profile = { apiBaseUrl: 'https://api.example', clientId: 'id', clientSecret: 'secret' } as Profile;
const tokenResponse = () => new Response(JSON.stringify({ access_token: 'a.b.c', expires_in: 300 }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('TokenProvider', () => {
  it('fetches one token for concurrent callers', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    const tokens = new TokenProvider(profile);
    await Promise.all(Array.from({ length: 9 }, () => tokens.getToken()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries when rate limited', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0.01' } }))
      .mockResolvedValueOnce(tokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    expect(await new TokenProvider(profile).getToken()).toBe('a.b.c');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
