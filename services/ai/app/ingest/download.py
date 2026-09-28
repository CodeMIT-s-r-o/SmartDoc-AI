"""Fetches the validated PDF version through the API (the worker holds no AWS credentials)."""

import re
from uuid import UUID

import httpx

from app.ingest.errors import DOCUMENT_UNAVAILABLE, PARSE_LIMIT_EXCEEDED, permanent

MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
_S3_CODE = re.compile(rb"<Code>([A-Za-z]+)</Code>")


class DownloadError(Exception):
    """A transient download failure. The message never contains the presigned URL, which is a
    bearer credential (signature and session token) and must not reach logs or the database."""


async def download_document(
    http: httpx.AsyncClient, api_url: str, internal_token: str, document_id: UUID
) -> bytes:
    res = await http.post(
        f"{api_url}/internal/documents/{document_id}/download-url",
        headers={"X-Internal-Token": internal_token},
        timeout=10,
    )
    if res.status_code == httpx.codes.NOT_FOUND:
        raise permanent(DOCUMENT_UNAVAILABLE, "The document is no longer available for ingestion")
    if res.is_error:
        raise DownloadError(f"API download-url returned {res.status_code}: {res.text[:200]}")
    url: str = res.json()["url"]

    data = bytearray()
    async with http.stream("GET", url, timeout=60) as response:
        if response.is_error:
            body = await response.aread()
            code = _S3_CODE.search(body)
            reason = code.group(1).decode() if code else "unknown error"
            raise DownloadError(f"S3 returned {response.status_code} {reason}")
        async for part in response.aiter_bytes():
            data.extend(part)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise permanent(PARSE_LIMIT_EXCEEDED, "The file is larger than 20 MB")
    return bytes(data)
