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
  AWS_REGION: z.string().default('eu-central-1'),
  /** Private docs bucket; credentials come from the default chain (instance role, or make creds). */
  S3_DOCS_BUCKET: z.string().min(3),
  THROTTLE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Daily AI spend across all users; each user also has users.daily_limit_usd. */
  GLOBAL_DAILY_CAP_USD: z.coerce.number().positive().default(2),
  /** The chat model the AI service uses (same variable), so budget estimates use its price. */
  RAG_CHAT_MODEL: z.string().min(1).default('gpt-6-luna'),
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
