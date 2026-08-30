# Adaptive Junction — SPEC

## Agent

- Name: `junction_advisor`
- Role: operator assistant for an adaptive 4-way LHT junction.
- Must call tools before quoting green times.
- SDG 11: reduce congestion by allocating green from measured queues.

## Tools

- `record_queue_counts` — session memory
- `compute_junction_plan` — `pipeline.compute_timing_plan` + queue on `junction_runtime`
- `get_current_plan` — session
- `get_junction_status` — `SignalEngine.snapshot`
- `get_plan_history` — SQLite via persistence

## Memory

Session keys: `junction.counts`, `junction.last_plan`, `junction.junction_name`.

## Local run

- CLI: `demo.py`
- Full stack: `server.py` port 8000 + Vite 5173
- Slack: `AgentSlackRequestHandler`

## Deployment

Local demo is sufficient for the mini-competition. No cloud deploy required.
