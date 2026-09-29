"""Conversation history for the prompt: the most recent turns within a token budget."""

from collections.abc import Sequence

from app.rag.citations import strip_markers
from app.rag.prompt import HistoryTurn
from app.rag.text import strip_invisible
from app.rag.tokens import count_tokens


def trim_history(
    turns: Sequence[HistoryTurn], max_turns: int, token_budget: int
) -> list[HistoryTurn]:
    """Newest first until the budget is used; a turn is a user message plus its answer."""
    kept: list[HistoryTurn] = []
    tokens = 0
    for turn in reversed(turns[-max_turns * 2 :]):
        content = (
            strip_invisible(strip_markers(turn.content))
            if turn.role == "assistant"
            else turn.content
        )
        cost = count_tokens(content)
        if tokens + cost > token_budget:
            break
        tokens += cost
        kept.append(HistoryTurn(turn.role, content))
    kept.reverse()
    # Never start with a dangling answer.
    while kept and kept[0].role == "assistant":
        kept.pop(0)
    return kept
