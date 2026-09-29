"""Token counting for budgets and estimates. One encoding everywhere (cl100k), baked into the image.

The chat model's own tokenizer may differ slightly; these counts drive budgets, and billing always
uses the usage OpenAI reports.
"""

from functools import lru_cache

import tiktoken


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_encoding().encode(text))
