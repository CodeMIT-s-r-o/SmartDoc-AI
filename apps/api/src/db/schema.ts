/**
 * SmartDoc AI database schema (Drizzle owns it; the Python services read and write it with SQL).
 * See docs/IMPLEMENTATION_PLAN.md §4. Kept in one file so drizzle-kit needs no module resolution.
 *
 * Conventions:
 * - snake_case columns via `casing: 'snake_case'` (drizzle.config.ts and the runtime client).
 * - `tenant_id` (= Cognito `sub` in v1) references users(id) ON DELETE CASCADE on every tenant table.
 * - Status columns are text + CHECK, not pg enums, so adding a state is a one-line migration.
 * - Money is numeric(14,10) USD; surrogate integer keys are identity columns (no sequence grants).
 * - Hand-written SQL lives in drizzle/*_custom_*.sql: extensions, the HNSW index, the price
 *   EXCLUDE constraint, the ledger triggers and the price seed.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  halfvec,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const EMBEDDING_DIMENSIONS = 1536;

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const usd = () => numeric({ precision: 14, scale: 10 });
const tenantId = () =>
  uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

// --- Identity -----------------------------------------------------------------------------------

export const users = pgTable('users', {
  /** Cognito `sub`. */
  id: uuid().primaryKey(),
  email: text().notNull(),
  dailyLimitUsd: numeric({ precision: 10, scale: 4 }).notNull().default('0.25'),
  createdAt: createdAt(),
  lastSeenAt: timestamp({ withTimezone: true }),
});

// --- Documents and ingestion --------------------------------------------------------------------

export const DOCUMENT_STATUSES = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
  'deleting',
] as const;

export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    title: text().notNull(),
    originalFilename: text().notNull(),
    s3Key: text().notNull(),
    /** Pinned at /complete so the worker reads exactly the validated object version. */
    s3VersionId: text(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    status: text({ enum: DOCUMENT_STATUSES }).notNull().default('uploading'),
    errorCode: text(),
    errorMessage: text(),
    pageCount: integer(),
    chunkCount: integer(),
    embedTokens: integer(),
    embedTokensSaved: integer(),
    embedCostUsd: usd(),
    injectionFlaggedChunks: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    readyAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('documents_tenant_status_idx').on(t.tenantId, t.status),
    check('documents_status_check', inList('status', DOCUMENT_STATUSES)),
  ],
);

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const JOB_STAGES = ['downloading', 'parsing', 'chunking', 'embedding', 'indexing'] as const;

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    status: text({ enum: JOB_STATUSES }).notNull().default('queued'),
    stage: text({ enum: JOB_STAGES }),
    /** Incremented when a worker claims the job, so an OOM-killed poison pill cannot loop forever. */
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp({ withTimezone: true }),
    lockedBy: text(),
    /** Fencing token: a worker that lost its lease cannot commit results. */
    leaseToken: uuid(),
    errorCode: text(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ingestion_jobs_active_document_uq')
      .on(t.documentId)
      .where(sql`status IN ('queued', 'running')`),
    index('ingestion_jobs_queued_run_after_idx')
      .on(t.runAfter)
      .where(sql`status = 'queued'`),
    check('ingestion_jobs_status_check', inList('status', JOB_STATUSES)),
    check('ingestion_jobs_stage_check', sql`stage IS NULL OR ${inList('stage', JOB_STAGES)}`),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    tenantId: tenantId(),
    chunkIndex: integer().notNull(),
    content: text().notNull(),
    sectionPath: text(),
    pageStart: integer().notNull(),
    pageEnd: integer().notNull(),
    charStart: integer().notNull(),
    tokenCount: integer().notNull(),
    /** sha256(embedding_model + embedded input): enables vector reuse across re-uploads. */
    contentHash: text().notNull(),
    embeddingModel: text().notNull(),
    embedding: halfvec({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    tsv: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(section_path, '') || ' ' || content)`,
    ),
    injectionScore: real(),
    injectionFlags: text().array(),
  },
  (t) => [
    // The HNSW index (halfvec_cosine_ops) is created in custom SQL; see the file header.
    index('chunks_tsv_gin_idx').using('gin', t.tsv),
    index('chunks_tenant_document_idx').on(t.tenantId, t.documentId),
    index('chunks_tenant_hash_model_idx').on(t.tenantId, t.contentHash, t.embeddingModel),
    uniqueIndex('chunks_document_chunk_uq').on(t.documentId, t.chunkIndex),
    check('chunks_pages_check', sql`page_start >= 1 AND page_end >= page_start`),
  ],
);

// --- Conversations ------------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: tenantId(),
    title: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_tenant_updated_idx').on(t.tenantId, t.updatedAt.desc())],
);

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export const MESSAGE_STATUSES = [
  'streaming',
  'complete',
  'aborted',
  'error',
  'no_answer',
  'cached',
  'degraded',
] as const;

export interface Citation {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  section: string | null;
  pageStart: number;
  pageEnd: number;
  /** Redacted when the source document is deleted. */
  snippet?: string;
  score: number;
  cited: boolean;
}

export const messages = pgTable(
  'messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    tenantId: tenantId(),
    role: text({ enum: MESSAGE_ROLES }).notNull(),
    /** Client-generated idempotency key: a retried send never triggers a second LLM call. */
    clientMessageId: uuid(),
    content: text().notNull().default(''),
    status: text({ enum: MESSAGE_STATUSES }).notNull().default('complete'),
    ragRequestId: uuid(),
    citations: jsonb().$type<Citation[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    uniqueIndex('messages_conversation_client_message_uq').on(t.conversationId, t.clientMessageId),
    check('messages_role_check', inList('role', MESSAGE_ROLES)),
    check('messages_status_check', inList('status', MESSAGE_STATUSES)),
  ],
);

export const feedback = pgTable(
  'feedback',
  {
    messageId: uuid()
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    tenantId: tenantId(),
    requestId: uuid(),
    rating: smallint().notNull(),
    reasons: text().array(),
    comment: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('feedback_tenant_created_idx').on(t.tenantId, t.createdAt),
    check('feedback_rating_check', sql`rating IN (-1, 1)`),
  ],
);

// --- RAG telemetry ------------------------------------------------------------------------------

export const RAG_STATUSES = [
  'answered',
  'no_answer_gate',
  'no_answer_model',
  'cached',
  'degraded',
  'aborted',
  'error',
] as const;

export const ragRequests = pgTable(
  'rag_requests',
  {
    /** Equals the requestId that flows through NestJS, Python, the SSE stream and the logs. */
    id: uuid().primaryKey(),
    tenantId: tenantId(),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    traceId: text(),
    config: jsonb().notNull(),
    configHash: text().notNull(),
    promptVersion: text().notNull(),
    model: text().notNull(),
    responseModel: text(),
    serviceTier: text(),
    status: text({ enum: RAG_STATUSES }).notNull(),
    cacheType: text(),
    rewritten: boolean().notNull().default(false),
    maxCos: real(),
    maxMatchedLexemes: integer(),
    ftsNonempty: boolean(),
    nChunks: integer(),
    nCitations: integer(),
    citationCoverage: real(),
    citationsValid: boolean(),
    injectionFlaggedChunks: integer().notNull().default(0),
    totalMs: integer(),
    retrievalMs: integer(),
    ttftMs: integer(),
    llmMs: integer(),
    costUsd: usd(),
    usageEstimated: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('rag_requests_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('rag_requests_created_idx').on(t.createdAt),
    index('rag_requests_status_idx').on(t.status),
    check('rag_requests_status_check', inList('status', RAG_STATUSES)),
  ],
);

export const retrievals = pgTable(
  'retrievals',
  {
    requestId: uuid()
      .notNull()
      .references(() => ragRequests.id, { onDelete: 'cascade' }),
    rank: integer().notNull(),
    /** No FK: telemetry must survive document deletion. */
    chunkId: uuid().notNull(),
    documentId: uuid().notNull(),
    vectorScore: real(),
    /** ts_rank_cd, which has no IDF term: deliberately not called BM25. */
    ftsRank: real(),
    matchedLexemes: integer(),
    rrfScore: real().notNull(),
    cited: boolean().notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.rank] })],
);

// --- Cost ledger --------------------------------------------------------------------------------

export const modelPrices = pgTable(
  'model_prices',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    model: text().notNull(),
    /** OpenAI `service_tier` of the call: 'default' or 'flex' (Flex is billed at 50%). */
    serviceTier: text().notNull().default('default'),
    effectiveFrom: timestamp({ withTimezone: true }).notNull(),
    /** NULL = still current. Overlaps per (model, tier) are rejected by an EXCLUDE constraint. */
    effectiveTo: timestamp({ withTimezone: true }),
    inputUsdPerMtok: usd().notNull(),
    cachedInputUsdPerMtok: usd().notNull(),
    cacheWriteUsdPerMtok: usd().notNull(),
    outputUsdPerMtok: usd().notNull(),
    sourceUrl: text().notNull(),
  },
  () => [
    check('model_prices_range_check', sql`effective_to IS NULL OR effective_to > effective_from`),
  ],
);

export const LLM_PURPOSES = [
  'chat',
  'rewrite',
  'query_embed',
  'doc_embed',
  'judge',
  'eval',
] as const;

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** No FKs on request/document: the money record must survive any later failure or delete. */
    requestId: uuid(),
    documentId: uuid(),
    tenantId: tenantId(),
    purpose: text({ enum: LLM_PURPOSES }).notNull(),
    model: text().notNull(),
    responseModel: text(),
    /** Filled by the pricing trigger, together with cost_usd. */
    priceId: integer().references(() => modelPrices.id),
    serviceTier: text().notNull().default('default'),
    reasoningEffort: text(),
    openaiResponseId: text().unique(),
    inputTokens: integer().notNull(),
    /** Subsets of input_tokens, as in OpenAI's usage payload. */
    cachedTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    /** Includes reasoning tokens (never add reasoning_tokens on top). */
    outputTokens: integer().notNull().default(0),
    reasoningTokens: integer().notNull().default(0),
    costUsd: usd(),
    /** True when a stream was aborted and output tokens had to be estimated. */
    usageEstimated: boolean().notNull().default(false),
    latencyMs: integer(),
    ttftMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index('llm_calls_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('llm_calls_request_idx').on(t.requestId),
    index('llm_calls_purpose_created_idx').on(t.purpose, t.createdAt),
    check('llm_calls_purpose_check', inList('purpose', LLM_PURPOSES)),
    check(
      'llm_calls_tokens_check',
      sql`input_tokens >= 0 AND cached_tokens >= 0 AND cache_write_tokens >= 0
        AND cached_tokens + cache_write_tokens <= input_tokens
        AND output_tokens >= 0 AND reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens`,
    ),
  ],
);

export const userDailyUsage = pgTable(
  'user_daily_usage',
  {
    tenantId: tenantId(),
    /** Calendar day in Europe/Bratislava. */
    day: date().notNull(),
    spentUsd: usd().notNull().default('0'),
    reservedUsd: usd().notNull().default('0'),
    /** Chat requests (purpose = 'chat') only. */
    requests: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day] }),
    // A release that runs twice, or on the wrong day, fails loudly instead of freeing budget.
    check('user_daily_usage_reserved_check', sql`reserved_usd >= 0`),
  ],
);

export const appDailyUsage = pgTable(
  'app_daily_usage',
  {
    day: date().primaryKey(),
    spentUsd: usd().notNull().default('0'),
    reservedUsd: usd().notNull().default('0'),
  },
  () => [check('app_daily_usage_reserved_check', sql`reserved_usd >= 0`)],
);

/**
 * One row per chat request that holds budget. The stored `day` makes the release land on the day
 * that was charged even across midnight; `expires_at` lets the housekeeping tick release what a
 * crashed request left behind.
 */
export const budgetReservations = pgTable(
  'budget_reservations',
  {
    /** The rag request id that flows through NestJS, Python and the ledger. */
    requestId: uuid().primaryKey(),
    tenantId: tenantId(),
    /** Calendar day in Europe/Bratislava that the reservation was charged to. */
    day: date().notNull(),
    estUsd: usd().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    releasedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('budget_reservations_open_expires_idx')
      .on(t.expiresAt)
      .where(sql`released_at IS NULL`),
    check('budget_reservations_est_check', sql`est_usd > 0`),
  ],
);
