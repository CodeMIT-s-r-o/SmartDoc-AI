from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.db import Pool

router = APIRouter()

DB_TIMEOUT_S = 2.0


class HealthReport(BaseModel):
    status: Literal["ok"]
    db: Literal["up"]
    version: str


@router.get("/internal/health")
async def health(pool: Pool, settings: Annotated[Settings, Depends(get_settings)]) -> HealthReport:
    """Unauthenticated liveness probe: pings the database, exposes no data."""
    try:
        async with pool.connection(timeout=DB_TIMEOUT_S) as conn:
            await conn.execute("select 1")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"status": "error", "db": "down"},
        ) from exc
    return HealthReport(status="ok", db="up", version=settings.app_version)
