.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help install up down reset-db logs ps lint typecheck test check format spike

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

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

check: lint typecheck test ## Everything CI will run

format: ## Auto-format TypeScript and Python
	yarn format
	cd services/ai && uv run ruff format .

spike: .env ## Block 0 OpenAI spike: streaming, prompt cache, temperature, Flex (< $0.01)
	cd services/ai && uv run --env-file ../../.env python scripts/spike_openai.py
