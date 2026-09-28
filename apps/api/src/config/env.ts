import { z } from 'zod';

/** Environment contract for the API. Validated once at boot so misconfiguration fails fast. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  AI_URL: z.url(),
  INTERNAL_TOKEN: z.string().min(16),
  COGNITO_USER_POOL_ID: z.string().regex(/^[a-z]{2}-[a-z]+-\d_[0-9A-Za-z]+$/),
  COGNITO_CLIENT_ID: z.string().min(1),
  /** Managed-login domain, e.g. https://smartdoc-dev-codemit.auth.eu-central-1.amazoncognito.com */
  COGNITO_DOMAIN: z.url(),
  THROTTLE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Reverse proxies in front of the API: 0 locally, 2 in prod (CloudFront + Caddy). */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  APP_VERSION: z.string().default('dev'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
