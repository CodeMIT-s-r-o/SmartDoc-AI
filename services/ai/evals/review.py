"""Local review tool for the golden set (and a 20-item spot check of the synthetic set).

    make golden-review      # then open http://127.0.0.1:8766

Shows each item next to the cited PDF page and writes every decision straight back into the
dataset file (eval/datasets/*.jsonl), so the review is committed with the data. Binds to
127.0.0.1 only and serves only the PDFs listed in the corpus manifest.
"""

import json
import os
import random
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from evals.env import CORPUS_DIR, DATASETS_DIR

PORT = int(os.environ.get("REVIEW_PORT", "8766"))
PAGE = Path(__file__).with_name("review.html")
DATASETS = {"golden": "golden_v1.jsonl", "synth": "retrieval_synth_v1.jsonl"}
SPOT_CHECK = 20
STATUSES = {"pending", "accepted", "edited", "rejected", "spot_ok", "spot_bad"}
EDITABLE = {"question", "answer"}


def _load(dataset: str) -> list[dict[str, Any]]:
    path = DATASETS_DIR / DATASETS[dataset]
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _save(dataset: str, rows: list[dict[str, Any]]) -> None:
    path = DATASETS_DIR / DATASETS[dataset]
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    tmp.replace(path)


def _pdfs() -> set[str]:
    manifest = json.loads((CORPUS_DIR / "manifest.json").read_text())
    return {d["file"] for d in manifest["documents"]}


def _spot_ids() -> list[str]:
    rows = _load("synth")
    return [r["id"] for r in random.Random(26).sample(rows, SPOT_CHECK)]


def apply(dataset: str, item_id: str, decision: dict[str, Any]) -> dict[str, Any]:
    """Record one decision; edited fields keep the generated original next to them."""
    status = decision.get("status")
    if dataset not in DATASETS or status not in STATUSES:
        raise ValueError("unknown dataset or status")
    rows = _load(dataset)
    row = next((r for r in rows if r["id"] == item_id), None)
    if row is None:
        raise KeyError(item_id)
    edits = {k: v for k, v in (decision.get("edits") or {}).items() if k in EDITABLE}
    changed = {
        k: v for k, v in edits.items() if isinstance(v, str) and v.strip() and v != row.get(k)
    }
    if changed:
        row.setdefault("original", {k: row[k] for k in changed})
        row.update(changed)
    pages = decision.get("pages")
    if isinstance(pages, list) and len(pages) == 2 and row.get("evidence"):
        evidence = row["evidence"][int(decision.get("evidence_index", 0))]
        if [int(p) for p in pages] != evidence["pages"]:
            row.setdefault("original", {})["pages"] = evidence["pages"]
            evidence["pages"] = [int(p) for p in pages]
    row["review"] = {
        "status": status,
        "notes": str(decision.get("notes", ""))[:2000],
        "reviewed_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    _save(dataset, rows)
    return row


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: Any) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode(), "application/json")

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._send(HTTPStatus.OK, PAGE.read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/api/items":
            spot = set(_spot_ids())
            self._json(
                HTTPStatus.OK,
                {
                    "golden": _load("golden"),
                    "synth": [r for r in _load("synth") if r["id"] in spot],
                },
            )
        elif self.path.startswith("/pdf/") and self.path[5:] in _pdfs():
            self._send(HTTPStatus.OK, (CORPUS_DIR / self.path[5:]).read_bytes(), "application/pdf")
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/api/review":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            row = apply(body["dataset"], body["id"], body)
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        self._json(HTTPStatus.OK, row)

    def log_message(self, format: str, *args: Any) -> None:
        pass


if __name__ == "__main__":
    print(f"Golden set review: http://127.0.0.1:{PORT}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
