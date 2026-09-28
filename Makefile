.DEFAULT_GOAL := help
COMPOSE := docker compose
CDK := yarn workspace @smartdoc/cdk cdk
AWS_ADMIN_PROFILE ?= codemit
DEV_APP_PROFILE ?= smartdoc-dev-app
DEV_STACKS := SmartDoc-Dev-Storage SmartDoc-Dev-Auth

.PHONY: help install up down reset-db logs ps lint typecheck test test-db check format spike \
	cdk-bootstrap cdk-diff-dev cdk-dev dev-config creds invite login-url

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

.env:
	cp .env.example .env
	@echo "Created .env from .env.example. Add your OPENAI_API_KEY."

install: ## Install JS and Python dependencies on the host (editor support, tests)
	yarn install
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

lint: ## Lint TypeScript and Python
	yarn lint && yarn format:check
	cd services/ai && uv run ruff check . && uv run ruff format --check .

typecheck: ## Type-check TypeScript and Python
	yarn typecheck
	cd services/ai && uv run mypy

test: ## Run unit and e2e tests (no network, no API calls)
	yarn test
	cd services/ai && uv run pytest

APP_DB_URL = postgresql://smartdoc_app:$${DB_APP_PASSWORD:-smartdoc_app_dev}@127.0.0.1:$${DB_PORT:-5432}/smartdoc

test-db: ## Database tests against the running local stack (as the app role): contract + repositories
	cd services/ai && CONTRACT_DATABASE_URL=$(APP_DB_URL) uv run pytest tests/test_schema_contract.py -q
	TEST_DATABASE_URL=$(APP_DB_URL) yarn workspace @smartdoc/api test:db

check: lint typecheck test ## Everything CI will run (without a database)

format: ## Auto-format TypeScript and Python
	yarn format
	cd services/ai && uv run ruff format .

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

creds: ## Export 1-hour SmartDocDevApp credentials for the api container into .env.aws
	(umask 077 && aws configure export-credentials --profile $(DEV_APP_PROFILE) --format env-no-export > .env.aws)
	@echo "Wrote .env.aws (valid for 1 hour). Apply with: docker compose up -d api"

invite: ## Invite a user to the dev pool: make invite EMAIL=you@example.com [ADMIN=1]
	AWS_PROFILE=$(AWS_ADMIN_PROFILE) scripts/invite-user.sh $(EMAIL) $(if $(ADMIN),--admin)

login-url: ## Print a managed-login URL to test dev sign-in (until the SPA handles it in Block 1.4)
	@scripts/login-url.sh
