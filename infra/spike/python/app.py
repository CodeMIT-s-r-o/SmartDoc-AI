"""Stand-in for the AI service: an SSE stream of one event per second."""

import asyncio
import json
import time

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

STARTED = time.time()
app = FastAPI()
served = 0


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/stream")
async def stream(seconds: int = 90) -> StreamingResponse:
    global served
    cold = served == 0
    served += 1

    async def events():  # type: ignore[no-untyped-def]
        yield f"event: hello\ndata: {json.dumps({'from': 'python', 'cold': cold, 'up_s': round(time.time() - STARTED, 2)})}\n\n"
        for i in range(seconds):
            yield f"event: tick\ndata: {json.dumps({'i': i, 'sent': time.time()})}\n\n"
            await asyncio.sleep(1)
        yield 'event: done\ndata: {"from": "python"}\n\n'

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )
