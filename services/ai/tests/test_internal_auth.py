from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_internal_token

app = FastAPI()


@app.get("/internal/protected")
def protected(_: Annotated[None, Depends(require_internal_token)]) -> dict[str, bool]:
    return {"ok": True}


client = TestClient(app)


def test_missing_token_is_rejected() -> None:
    assert client.get("/internal/protected").status_code == 401


def test_wrong_token_is_rejected() -> None:
    res = client.get("/internal/protected", headers={"X-Internal-Token": "wrong-token-0123456789"})
    assert res.status_code == 401


def test_valid_token_is_accepted() -> None:
    headers = {"X-Internal-Token": "test-internal-token-0123456789"}
    assert client.get("/internal/protected", headers=headers).json() == {"ok": True}
