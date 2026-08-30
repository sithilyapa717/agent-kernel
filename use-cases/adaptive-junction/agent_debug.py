"""In-memory log of allocator exchanges for the dashboard debug panel."""
from __future__ import annotations

from collections import deque
from datetime import datetime
from itertools import count
from typing import Deque, List, Optional

from models import AgentExchange, AgentReceived, AgentSent

MAX_ENTRIES = 25

_log: Deque[AgentExchange] = deque(maxlen=MAX_ENTRIES)
_ids = count(1)


def record(
    trigger: str,
    cycle_index: int,
    duration_ms: float,
    sent: AgentSent,
    received: Optional[AgentReceived] = None,
    error: Optional[str] = None,
) -> AgentExchange:
    entry = AgentExchange(
        id=next(_ids),
        at=datetime.now(),
        trigger=trigger,
        cycle_index=cycle_index,
        duration_ms=round(duration_ms, 1),
        ok=error is None,
        sent=sent,
        received=received,
        error=error,
    )
    _log.append(entry)
    return entry


def recent(limit: int = MAX_ENTRIES) -> List[AgentExchange]:
    return list(_log)[-limit:][::-1]


def clear() -> None:
    _log.clear()
