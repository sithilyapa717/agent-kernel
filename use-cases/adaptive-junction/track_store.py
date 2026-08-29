"""In-memory live camera tracks for the junction UI (not SQLite)."""
from __future__ import annotations

from models import Side, TrackedVehicle

_tracks: dict[str, list[TrackedVehicle]] = {
    "north": [],
    "east": [],
    "south": [],
    "west": [],
}


def set_tracks(side: Side, tracks: list[TrackedVehicle] | None) -> None:
    _tracks[side] = list(tracks or [])


def clear_tracks(side: Side | None = None) -> None:
    if side is None:
        for s in _tracks:
            _tracks[s] = []
    else:
        _tracks[side] = []


def all_tracks() -> dict[str, list[TrackedVehicle]]:
    return {k: list(v) for k, v in _tracks.items()}
