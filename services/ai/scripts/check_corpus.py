"""Verify the hand-downloaded eval corpus against eval/corpus/manifest.json.

    make corpus-check

Exit code 1 when a file is missing or differs (size or SHA-256): the eval datasets cite pages of
these exact files, so a silently updated PDF would invalidate them.
"""

import hashlib
import json
import sys
from pathlib import Path


def main(corpus: Path) -> int:
    manifest = json.loads((corpus / "manifest.json").read_text())
    problems = 0
    for doc in manifest["documents"]:
        path = corpus / doc["file"]
        if not path.exists():
            print(f"MISSING  {doc['file']}  (get it from {doc['source']}, see README.md)")
            problems += 1
            continue
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if len(data) != doc["bytes"] or digest != doc["sha256"]:
            print(f"CHANGED  {doc['file']}  ({len(data):,} bytes, sha256 {digest[:12]}…)")
            problems += 1
            continue
        print(f"ok       {doc['file']}  ({doc['pages']} pages, {doc['version']})")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("eval/corpus")))
