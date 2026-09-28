import uuid

import httpx
import pytest

from app.ingest.download import DownloadError, download_document
from app.ingest.errors import DOCUMENT_UNAVAILABLE, IngestError

SECRET_URL = (
    "https://bucket.s3.test/users/t/doc.pdf?X-Amz-Security-Token=SECRET&X-Amz-Signature=SIG"
)


def client(s3_status: int, s3_body: bytes, api_status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/download-url"):
            assert request.headers["X-Internal-Token"] == "token"
            return httpx.Response(api_status, json={"url": SECRET_URL})
        return httpx.Response(s3_status, content=s3_body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_downloads_the_bytes() -> None:
    async with client(200, b"%PDF-1.7 body") as http:
        assert (
            await download_document(http, "http://api", "token", uuid.uuid4()) == b"%PDF-1.7 body"
        )


@pytest.mark.anyio
async def test_s3_errors_never_leak_the_presigned_url() -> None:
    body = b"<Error><Code>ExpiredToken</Code><Message>The token expired</Message></Error>"
    async with client(400, body) as http:
        with pytest.raises(DownloadError) as info:
            await download_document(http, "http://api", "token", uuid.uuid4())

    message = str(info.value)
    assert message == "S3 returned 400 ExpiredToken"
    assert "SECRET" not in message and "SIG" not in message
    assert info.value.__cause__ is None


@pytest.mark.anyio
async def test_a_document_the_api_no_longer_serves_is_a_permanent_failure() -> None:
    async with client(200, b"", api_status=404) as http:
        with pytest.raises(IngestError) as info:
            await download_document(http, "http://api", "token", uuid.uuid4())
    assert info.value.code == DOCUMENT_UNAVAILABLE
    assert info.value.permanent
