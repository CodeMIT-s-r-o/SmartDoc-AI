.DEFAULT_GOAL := help
COMPOSE := docker compose
CDK := yarn workspace @smartdoc/cdk cdk
AWS_ADMIN_PROFILE ?= codemit
DEV_APP_PROFILE ?= smartdoc-dev-app
DEV_STACKS := SmartDoc-Dev-Storage SmartDoc-Dev-Auth

.PHONY: replay replay-report restore-drill hooks secrets eval eval-retrieval eval-fixture eval-ci eval-ingest eval-generate golden-review corpus-check budget help install up down reset-db logs ps lint typecheck test test-db check format spike \
	cdk-bootstrap cdk-diff-dev cdk-dev dev-config creds invite login-url

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

.env:
	cp .env.example .env
	@echo "Created .env from .env.example. Add your OPENAI_API_KEY."

install: ## Install JS and Python dependencies on the host (editor support, tests)
	yarn install
	yarn build:contracts
	cd services/ai && uv sync

up: .env ## Build and start the local stack, wait until every service is healthy
	$(COMPOSE) up -d --build --wait

down: ## Stop the local stack (keeps the database volume)
	$(COMPOSE) down

reset-db: ## Stop the stack and delete the local database volume
	$(COMPOSE) down -v

logs: ## Follow logs of all services
	$(COMPOSE) logs -f

ps: ## Show service status
	$(COMPOSE) ps

hooks: ## Use the repository's git hooks (gitleaks on every commit)
	git config core.hooksPath .githooks

secrets: ## Scan the whole git history for secrets (gitleaks, values redacted)
	gitleaks git --redact --no-banner .

lint: ## Lint TypeScript and Python
	yarn lint && yarn format:check
	cd services/ai && uv run ruff check . && uv run ruff format --check .

typecheck: ## Type-check TypeScript and Python
	yarn typecheck
	cd services/ai && uv run mypy

test: ## Run unit and e2e tests (no network, no API calls)
	yarn test
	cd services/ai && uv run pytest

# Tests use their own database, so the running dev worker never picks up test jobs.
TEST_DB_URL = postgresql://smartdoc_app:$${DB_APP_PASSWORD:-smartdoc_app_dev}@127.0.0.1:$${DB_PORT:-5432}/smartdoc_test

test-db: ## Database tests against smartdoc_test in the running stack (as the app role)
	cd services/ai && TEST_DATABASE_URL=$(TEST_DB_URL) uv run pytest tests/test_schema_contract.py tests/db -q
	TEST_DATABASE_URL=$(TEST_DB_URL) yarn workspace @smartdoc/api test:db

check: lint typecheck test ## Everything CI will run (without a database)

format: ## Auto-format TypeScript and Python
	yarn format
	cd services/ai && uv run ruff format .

corpus-check: ## Verify the hand-downloaded eval corpus against eval/corpus/manifest.json
	python3 services/ai/scripts/check_corpus.py eval/corpus

eval-ingest: .env ## Ingest the eval corpus into smartdoc_eval through the real worker code (~$0.01)
	cd services/ai && uv run python -m evals.ingest

eval-generate: .env ## Generate golden/retrieval candidates from the eval corpus (~$0.02; overwrites them)
	cd services/ai && uv run python -m evals.generate

eval: .env ## Run the eval: retrieval metrics plus live LLM answers (~$0.02); writes eval/results/
	cd services/ai && uv run python -m evals.run $(ARGS)

eval-retrieval: ## Retrieval metrics only, from the cached question embeddings (no API calls)
	cd services/ai && uv run python -m evals.run --offline $(ARGS)

eval-fixture: ## Dump the ingested eval corpus to eval/fixtures (after the corpus or ingest changed)
	docker compose exec -T db pg_dump -U smartdoc_owner -d smartdoc_eval -Fc -Z 9 --data-only \
	  -t users -t documents -t chunks > eval/fixtures/eval_corpus.dump

restore-drill: ## Back up DB (default smartdoc), restore into a scratch Postgres, verify, print the RTO
	DB=$(or $(DB),smartdoc) scripts/restore-drill.sh

eval-ci: ## Tier-1 eval as CI runs it: fresh database + committed fixture, no API calls
	scripts/eval-ci.sh $(ARGS)

replay: .env ## Cost replay: naive vs sensible vs optimized on synthetic traffic (~$0.35)
	cd services/ai && uv run python -m evals.replay $(ARGS)

replay-report: ## Copy the newest full replay into the Cost page (apps/web/src/cost/replay.json)
	cd services/ai && uv run python -m evals.replay --report \
	  "$$(ls -t ../../eval/results/replay-*.json | grep -v -- -pilot | head -1)"

golden-review: ## Review golden candidates next to the cited PDF pages: http://127.0.0.1:8766
	cd services/ai && uv run python -m evals.review

spike: .env ## Block 0 OpenAI spike: streaming, prompt cache, temperature, Flex (< $0.01)
	cd services/ai && uv run --env-file ../../.env python scripts/spike_openai.py

cdk-bootstrap: ## One-time: bootstrap CDK in eu-central-1 for the admin profile
	$(CDK) bootstrap --profile $(AWS_ADMIN_PROFILE)

cdk-diff-dev: ## Show pending changes to the dev stacks
	$(CDK) diff $(DEV_STACKS) --profile $(AWS_ADMIN_PROFILE)

cdk-dev: ## Deploy the dev stacks (docs bucket, SmartDocDevApp role, Cognito), refresh .env.dev-aws
	$(CDK) deploy $(DEV_STACKS) --profile $(AWS_ADMIN_PROFILE)
	AWS_PROFILE=$(AWS_ADMIN_PROFILE) scripts/dev-config.sh

dev-config: ## Write .env.dev-aws (non-secret dev config) from SSM
	AWS_PROFILE=$(AWS_ADMIN_PROFILE) scripts/dev-config.sh

creds: ## Export 12-hour SmartDocDevApp credentials for the api container, then recreate api
	(umask 077 && aws configure export-credentials --profile $(DEV_APP_PROFILE) --format env-no-export > .env.aws)
	@echo "Wrote .env.aws (valid for 12 hours)."
	@if $(COMPOSE) ps --status running --services 2>/dev/null | grep -qx api; then $(COMPOSE) up -d api; fi

invite: ## Invite a user to the dev pool: make invite EMAIL=you@example.com [ADMIN=1]
	AWS_PROFILE=$(AWS_ADMIN_PROFILE) scripts/invite-user.sh $(EMAIL) $(if $(ADMIN),--admin)

budget: ## Set a user's daily AI budget (budget demo): make budget EMAIL=you@example.com USD=0.001
	@test -n "$(EMAIL)" -a -n "$(USD)" || { echo "usage: make budget EMAIL=... USD=..."; exit 1; }
	@echo "UPDATE users SET daily_limit_usd = :'usd'::numeric WHERE email = :'email' RETURNING email, daily_limit_usd;" \
	  | docker compose exec -T db psql -U smartdoc_owner -d smartdoc -v ON_ERROR_STOP=1 \
	      -v email='$(EMAIL)' -v usd='$(USD)'

login-url: ## Print a managed-login URL to test dev sign-in (until the SPA handles it in Block 1.4)
	@scripts/login-url.sh
