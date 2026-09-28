-- Extensions are created by the superuser bootstrap (deploy/db/init-roles.sh); these are no-ops
-- there, and they document the dependency for any other environment.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "app_daily_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"spent_usd" numeric(14, 10) DEFAULT '0' NOT NULL,
	"reserved_usd" numeric(14, 10) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"section_path" text,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"char_start" integer NOT NULL,
	"token_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" halfvec(1536) NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(section_path, '') || ' ' || content)) STORED,
	"injection_score" real,
	"injection_flags" text[],
	CONSTRAINT "chunks_pages_check" CHECK (page_start >= 1 AND page_end >= page_start)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"original_filename" text NOT NULL,
	"s3_key" text NOT NULL,
	"s3_version_id" text,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"error_code" text,
	"error_message" text,
	"page_count" integer,
	"chunk_count" integer,
	"embed_tokens" integer,
	"embed_tokens_saved" integer,
	"embed_cost_usd" numeric(14, 10),
	"injection_flagged_chunks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "documents_status_check" CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed', 'deleting'))
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid,
	"rating" smallint NOT NULL,
	"reasons" text[],
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_rating_check" CHECK (rating IN (-1, 1))
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_token" uuid,
	"error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_jobs_status_check" CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "ingestion_jobs_stage_check" CHECK (stage IS NULL OR stage IN ('downloading', 'parsing', 'chunking', 'embedding', 'indexing'))
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" uuid,
	"document_id" uuid,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"response_model" text,
	"price_id" integer,
	"service_tier" text DEFAULT 'default' NOT NULL,
	"reasoning_effort" text,
	"openai_response_id" text,
	"input_tokens" integer NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 10),
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"ttft_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_openaiResponseId_unique" UNIQUE("openai_response_id"),
	CONSTRAINT "llm_calls_purpose_check" CHECK (purpose IN ('chat', 'rewrite', 'query_embed', 'doc_embed', 'judge', 'eval')),
	CONSTRAINT "llm_calls_tokens_check" CHECK (input_tokens >= 0 AND cached_tokens >= 0 AND cache_write_tokens >= 0
        AND cached_tokens + cache_write_tokens <= input_tokens
        AND output_tokens >= 0 AND reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"client_message_id" uuid,
	"content" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"rag_request_id" uuid,
	"citations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK (role IN ('user', 'assistant')),
	CONSTRAINT "messages_status_check" CHECK (status IN ('streaming', 'complete', 'aborted', 'error', 'no_answer', 'cached', 'degraded'))
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "model_prices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"model" text NOT NULL,
	"service_tier" text DEFAULT 'default' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"input_usd_per_mtok" numeric(14, 10) NOT NULL,
	"cached_input_usd_per_mtok" numeric(14, 10) NOT NULL,
	"cache_write_usd_per_mtok" numeric(14, 10) NOT NULL,
	"output_usd_per_mtok" numeric(14, 10) NOT NULL,
	"source_url" text NOT NULL,
	CONSTRAINT "model_prices_range_check" CHECK (effective_to IS NULL OR effective_to > effective_from)
);
--> statement-breakpoint
CREATE TABLE "rag_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"trace_id" text,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"response_model" text,
	"service_tier" text,
	"status" text NOT NULL,
	"cache_type" text,
	"rewritten" boolean DEFAULT false NOT NULL,
	"max_cos" real,
	"max_matched_lexemes" integer,
	"fts_nonempty" boolean,
	"n_chunks" integer,
	"n_citations" integer,
	"citation_coverage" real,
	"citations_valid" boolean,
	"injection_flagged_chunks" integer DEFAULT 0 NOT NULL,
	"total_ms" integer,
	"retrieval_ms" integer,
	"ttft_ms" integer,
	"llm_ms" integer,
	"cost_usd" numeric(14, 10),
	"usage_estimated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_requests_status_check" CHECK (status IN ('answered', 'no_answer_gate', 'no_answer_model', 'cached', 'degraded', 'aborted', 'error'))
);
--> statement-breakpoint
CREATE TABLE "retrievals" (
	"request_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"vector_score" real,
	"fts_rank" real,
	"matched_lexemes" integer,
	"rrf_score" real NOT NULL,
	"cited" boolean DEFAULT false NOT NULL,
	CONSTRAINT "retrievals_request_id_rank_pk" PRIMARY KEY("request_id","rank")
);
--> statement-breakpoint
CREATE TABLE "user_daily_usage" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"spent_usd" numeric(14, 10) DEFAULT '0' NOT NULL,
	"reserved_usd" numeric(14, 10) DEFAULT '0' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_daily_usage_tenant_id_day_pk" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"daily_limit_usd" numeric(10, 4) DEFAULT '0.25' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_price_id_model_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."model_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_requests" ADD CONSTRAINT "rag_requests_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_requests" ADD CONSTRAINT "rag_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrievals" ADD CONSTRAINT "retrievals_request_id_rag_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."rag_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_daily_usage" ADD CONSTRAINT "user_daily_usage_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_tenant_document_idx" ON "chunks" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "chunks_tenant_hash_model_idx" ON "chunks" USING btree ("tenant_id","content_hash","embedding_model");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_chunk_uq" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "conversations_tenant_updated_idx" ON "conversations" USING btree ("tenant_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_tenant_status_idx" ON "documents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "feedback_tenant_created_idx" ON "feedback" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_jobs_active_document_uq" ON "ingestion_jobs" USING btree ("document_id") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "ingestion_jobs_queued_run_after_idx" ON "ingestion_jobs" USING btree ("run_after") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "llm_calls_tenant_created_idx" ON "llm_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_request_idx" ON "llm_calls" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "llm_calls_purpose_created_idx" ON "llm_calls" USING btree ("purpose","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_client_message_uq" ON "messages" USING btree ("conversation_id","client_message_id");--> statement-breakpoint
CREATE INDEX "rag_requests_tenant_created_idx" ON "rag_requests" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "rag_requests_created_idx" ON "rag_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "rag_requests_status_idx" ON "rag_requests" USING btree ("status");