# syntax=docker/dockerfile:1
# Build context: services/ai. One image runs both the API (uvicorn) and the ingestion worker.

FROM python:3.13-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /uvx /bin/
ENV PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    TIKTOKEN_CACHE_DIR=/opt/tiktoken \
    PATH="/opt/venv/bin:$PATH"
RUN useradd --create-home --uid 10001 app
WORKDIR /app

FROM base AS dev
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project
# Bake the tokenizer into the image: no download at runtime, one BPE file for chunking and counting.
RUN python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')"
COPY . .
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
