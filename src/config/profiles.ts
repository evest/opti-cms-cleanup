import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import 'dotenv/config';

const ProfileSchema = z.object({
  instance: z.string(),
  environment: z.enum(['Test1', 'Test2', 'Production']),
  cmsUrl: z.string().url(),
  // Optional overrides; by default derived from the profile name (see envPrefix).
  clientIdEnv: z.string().optional(),
  clientSecretEnv: z.string().optional(),
  apiBaseUrl: z.string().url().default('https://api.cms.optimizely.com'),
});

const ProfilesFileSchema = z.record(z.string(), ProfileSchema);

export type Profile = z.infer<typeof ProfileSchema> & {
  name: string;
  clientId: string;
  clientSecret: string;
};

const PROFILES_PATH = resolve(process.cwd(), 'profiles.json');

export function loadProfiles(): Record<string, z.infer<typeof ProfileSchema>> {
  if (!existsSync(PROFILES_PATH)) {
    throw new Error(`profiles.json not found at ${PROFILES_PATH}. Copy profiles.example.json to get started.`);
  }
  return ProfilesFileSchema.parse(JSON.parse(readFileSync(PROFILES_PATH, 'utf8')));
}

export function getProfile(name: string): Profile {
  const profiles = loadProfiles();
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Unknown profile "${name}". Available: ${Object.keys(profiles).join(', ') || '(none)'}`);
  }
  const { clientIdEnv, clientSecretEnv } = credentialEnvNames(name, profile);
  const clientId = process.env[clientIdEnv];
  const clientSecret = process.env[clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(`Missing ${clientIdEnv} and/or ${clientSecretEnv} in environment/.env`);
  }
  return { ...profile, name, clientId, clientSecret };
}

export function credentialEnvNames(
  name: string,
  profile: Pick<z.infer<typeof ProfileSchema>, 'clientIdEnv' | 'clientSecretEnv'>,
): { clientIdEnv: string; clientSecretEnv: string } {
  return {
    clientIdEnv: profile.clientIdEnv ?? `${envPrefix(name)}_CLIENT_ID`,
    clientSecretEnv: profile.clientSecretEnv ?? `${envPrefix(name)}_CLIENT_SECRET`,
  };
}

/** "acme-test1" -> "ACME_TEST1" */
export function envPrefix(profileName: string): string {
  return profileName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}
