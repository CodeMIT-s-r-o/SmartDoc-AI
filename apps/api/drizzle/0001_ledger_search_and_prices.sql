-- Hand-written migration: what drizzle-kit cannot express (see the header of src/db/schema.ts).

-- Vector search: HNSW over halfvec with cosine distance. Kept out of the Drizzle schema because
-- drizzle-kit renders vector operator classes unreliably.
CREATE INDEX "chunks_embedding_hnsw_idx" ON "chunks"
  USING hnsw ("embedding" halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
--> statement-breakpoint

-- At most one price per model and service tier at any instant.
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_no_overlap"
  EXCLUDE USING gist (model WITH =, service_tier WITH =, tstzrange(effective_from, effective_to) WITH &&);
--> statement-breakpoint

-- Both services update these tables, so the timestamp is maintained by the database.
CREATE FUNCTION "set_updated_at"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "documents_set_updated_at" BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "ingestion_jobs_set_updated_at" BEFORE UPDATE ON "ingestion_jobs"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "conversations_set_updated_at" BEFORE UPDATE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint

-- Cost ledger, step 1: price every call from the row valid at created_at. Writers insert raw token
-- counts only, so the formula lives in one place. A missing price fails the insert loudly.
--   ordinary = input - cached - cache_write   (cached and cache_write are subsets of input)
--   cost     = (ordinary*p_in + cached*p_cached + cache_write*p_write + output*p_out) / 1e6
-- reasoning_tokens are already included in output_tokens and are never added on top.
CREATE FUNCTION "llm_calls_apply_price"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  p public.model_prices%ROWTYPE;
BEGIN
  SELECT * INTO p
    FROM public.model_prices
   WHERE model = NEW.model
     AND service_tier = NEW.service_tier
     AND tstzrange(effective_from, effective_to) @> NEW.created_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no price for model "%" (tier "%") at %', NEW.model, NEW.service_tier, NEW.created_at;
  END IF;

  NEW.price_id := p.id;
  NEW.cost_usd := (
      (NEW.input_tokens - NEW.cached_tokens - NEW.cache_write_tokens) * p.input_usd_per_mtok
    + NEW.cached_tokens * p.cached_input_usd_per_mtok
    + NEW.cache_write_tokens * p.cache_write_usd_per_mtok
    + NEW.output_tokens * p.output_usd_per_mtok
  ) / 1000000;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "llm_calls_apply_price" BEFORE INSERT ON "llm_calls"
  FOR EACH ROW EXECUTE FUNCTION "llm_calls_apply_price"();
--> statement-breakpoint

-- Cost ledger, step 2: accrue spend into the daily budget rows (Europe/Bratislava days).
-- Lock order matches the budget reservation (user row, then app row) so the two never deadlock.
CREATE FUNCTION "llm_calls_accrue_usage"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  d date := (NEW.created_at AT TIME ZONE 'Europe/Bratislava')::date;
BEGIN
  INSERT INTO public.user_daily_usage AS u (tenant_id, day, spent_usd, requests)
  VALUES (NEW.tenant_id, d, NEW.cost_usd, CASE WHEN NEW.purpose = 'chat' THEN 1 ELSE 0 END)
  ON CONFLICT (tenant_id, day) DO UPDATE
    SET spent_usd = u.spent_usd + EXCLUDED.spent_usd,
        requests = u.requests + EXCLUDED.requests;

  INSERT INTO public.app_daily_usage AS a (day, spent_usd)
  VALUES (d, NEW.cost_usd)
  ON CONFLICT (day) DO UPDATE
    SET spent_usd = a.spent_usd + EXCLUDED.spent_usd;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "llm_calls_accrue_usage" AFTER INSERT ON "llm_calls"
  FOR EACH ROW EXECUTE FUNCTION "llm_calls_accrue_usage"();
--> statement-breakpoint

-- Price seed, verified against OpenAI's pricing and model pages on 2026-09-27.
-- Changing a price: set effective_to on the current row and insert a new one (never UPDATE prices).
INSERT INTO "model_prices"
  (model, service_tier, effective_from, input_usd_per_mtok, cached_input_usd_per_mtok,
   cache_write_usd_per_mtok, output_usd_per_mtok, source_url)
VALUES
  ('gpt-6-luna', 'default', '2026-09-22T00:00:00Z', 0.10, 0.01, 0.125, 0.50,
   'https://developers.openai.com/api/docs/models/gpt-6-luna'),
  ('gpt-6-luna', 'flex', '2026-09-22T00:00:00Z', 0.05, 0.005, 0.0625, 0.25,
   'https://developers.openai.com/api/docs/pricing'),
  ('gpt-5.6-luna', 'default', '2026-09-01T00:00:00Z', 0.20, 0.02, 0.25, 1.20,
   'https://developers.openai.com/api/docs/models/gpt-5.6-luna'),
  ('text-embedding-3-small', 'default', '2026-09-01T00:00:00Z', 0.02, 0, 0, 0,
   'https://developers.openai.com/api/docs/pricing');
--> statement-breakpoint

-- Least privilege beyond the default DML grants (deploy/db/init-roles.sh): prices change only via
-- migrations, and the cost ledger is append-only for the application role.
REVOKE INSERT, UPDATE, DELETE ON "model_prices" FROM smartdoc_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "llm_calls" FROM smartdoc_app;
