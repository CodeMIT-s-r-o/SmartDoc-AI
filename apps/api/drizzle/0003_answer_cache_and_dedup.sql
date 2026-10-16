CREATE TABLE "cost_savings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cost_savings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" uuid NOT NULL,
	"mechanism" text NOT NULL,
	"basis" text NOT NULL,
	"baseline_usd" numeric(14, 10) NOT NULL,
	"actual_usd" numeric(14, 10) NOT NULL,
	"saved_usd" numeric(14, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_savings_mechanism_check" CHECK (mechanism IN ('exact_cache', 'prompt_cache', 'no_answer_gate', 'context_trim', 'embedding_dedup')),
	CONSTRAINT "cost_savings_basis_check" CHECK (basis IN ('estimated', 'replay'))
);
--> statement-breakpoint
CREATE TABLE "response_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "response_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"scope_hash" text NOT NULL,
	"question_norm_hash" text NOT NULL,
	"answer" text NOT NULL,
	"sources" jsonb NOT NULL,
	"cited_sources" integer[] NOT NULL,
	"original_cost_usd" numeric(14, 10) NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_hit_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "response_cache" ADD CONSTRAINT "response_cache_tenant_id_users_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_savings_mechanism_created_idx" ON "cost_savings" USING btree ("mechanism","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "response_cache_key_uq" ON "response_cache" USING btree ("tenant_id","scope_hash","question_norm_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_sha256_uq" ON "documents" USING btree ("tenant_id","sha256") WHERE sha256 IS NOT NULL AND status NOT IN ('failed', 'deleting');--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_sha256_check" CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');