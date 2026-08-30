# AGENTS.md — Adaptive Junction

## File map after merge

| File | Owner folder | Role |
|------|----------------|------|
| `models.py`, `pipeline.py` | 1 | Types + deterministic allocator |
| `signal_engine.py`, `traffic_sim.py`, `track_store.py` | 2 | Lamps, SIM, camera tracks |
| `database.py`, `persistence.py` | 3 | SQLite audit trail |
| `agent.py`, `tool.py`, `demo.py` | 4 | Agent Kernel CLI + tools |
| `server.py`, `api_router.py`, `junction_runtime.py`, `frontend/` | 5 | Slack, REST, WS, UI |

Do not invent green times in the LLM. Call `compute_junction_plan`.

## Env

- `OPENAI_API_KEY`
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`

## Config

`config.yaml` must keep `api.custom_router_prefix: ""` so the dashboard hits `/api` not `/custom/api`.
