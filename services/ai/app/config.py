from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_SECRETS_DIR = Path("/run/secrets")


class Settings(BaseSettings):
    """Service configuration, read from the environment (and /run/secrets in prod).

    Validated once at startup so misconfiguration fails fast.
    """

    model_config = SettingsConfigDict(
        secrets_dir=_SECRETS_DIR if _SECRETS_DIR.is_dir() else None,
        extra="ignore",
    )

    database_url: str
    internal_token: SecretStr = Field(min_length=16)
    openai_api_key: SecretStr | None = None
    app_version: str = "dev"
    # The NestJS API, which presigns S3 downloads for the worker.
    api_url: str = "http://api:3000"
    # A running job whose lease is older than this is considered crashed and is reclaimed.
    job_lease_seconds: int = 900


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from the environment
