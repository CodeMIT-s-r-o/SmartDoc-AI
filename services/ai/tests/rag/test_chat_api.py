from collections.abc import AsyncIterator
from typing import Any

from fastapi.testclient import TestClient

from app.main import app
from app.rag import events as ev

TOKEN = {"X-Internal-Token": "test-internal-token-0123456789"}
BODY = {
    "requestId": "00000000-0000-4000-8000-000000000001",
    "tenantId": "00000000-0000-4000-8000-000000000002",
    "question": "How many days?",
    "documentIds": ["00000000-0000-4000-8000-000000000003"],
}


class StubPipeline:
    config: Any = None
    client: Any = None

    def __init__(self) -> None:
        self.requests: list[Any] = []

    async def run(self, req: Any) -> AsyncIterator[ev.ChatEvent]:
        self.requests.append(req)
        yield ev.ChatEvent("token", ev.Token(d="Hi"))


def client() -> tuple[TestClient, StubPipeline]:
    stub = StubPipeline()
    app.state.chat_pipeline = stub
    return TestClient(app), stub


def test_requires_the_internal_token() -> None:
    c, _ = client()
    assert c.post("/internal/chat", json=BODY).status_code == 401


def test_streams_sse_frames() -> None:
    c, stub = client()
    with c.stream("POST", "/internal/chat", json=BODY, headers=TOKEN) as res:
        body = "".join(res.iter_text())
        assert res.headers["content-type"].startswith("text/event-stream")
    assert 'event: token\ndata: {"d":"Hi"}\n\n' in body
    assert stub.requests[0].question == "How many days?"


def test_validates_the_body() -> None:
    c, _ = client()
    assert (
        c.post("/internal/chat", json={**BODY, "documentIds": []}, headers=TOKEN).status_code == 422
    )
    assert c.post("/internal/chat", json={**BODY, "question": ""}, headers=TOKEN).status_code == 422
