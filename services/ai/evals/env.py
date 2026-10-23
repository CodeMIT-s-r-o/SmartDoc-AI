"""Paths, eval tenants and settings shared by the eval scripts."""

import os
from pathlib import Path
from uuid import UUID, uuid5

from app.config import Settings

REPO = Path(__file__).resolve().parents[3]
EVAL_DIR = REPO / "eval"
CORPUS_DIR = EVAL_DIR / "corpus"
DATASETS_DIR = EVAL_DIR / "datasets"
FIXTURES_DIR = EVAL_DIR / "fixtures"
RESULTS_DIR = EVAL_DIR / "results"
# PDFs the harness writes itself (cross-tenant and canary documents); never committed.
GENERATED_DIR = EVAL_DIR / "generated"

_NAMESPACE = UUID("6d1e1b0e-5a3c-4f43-9b0a-3a7d2c1e8f10")


def tenant(name: str) -> UUID:
    """Deterministic tenant ids, so datasets and fixtures can refer to them across runs."""
    return uuid5(_NAMESPACE, name)


MAIN = tenant("eval-main")  # the five Slovak acts
OTHER = tenant("eval-other")  # a document only another tenant owns: cross-tenant probes
CANARY = tenant("eval-canary")  # documents carrying prompt injections

TENANTS = {"eval-main": MAIN, "eval-other": OTHER, "eval-canary": CANARY}


def eval_settings() -> Settings:
    """The OpenAI key and internal token come from the repository's .env (local development);
    the database is smartdoc_eval on the host port the stack publishes."""
    url = os.environ.get("EVAL_DATABASE_URL") or (
        "postgresql://smartdoc_app:"
        f"{os.environ.get('DB_APP_PASSWORD', 'smartdoc_app_dev')}@127.0.0.1:"
        f"{os.environ.get('DB_PORT', '5432')}/smartdoc_eval"
    )
    return Settings(_env_file=REPO / ".env", database_url=url)  # type: ignore[call-arg]
