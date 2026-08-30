# Adaptive Junction Advisor

Agent Kernel use case: an operator reports queue lengths over Slack or CLI; a deterministic allocator splits an 8-minute green loop across a 4-way left-hand-traffic junction. A live dashboard visualizes lamps and demand. This addresses **UN SDG 11** (Sustainable Cities and Communities) by giving busier approaches more green, cutting idle time and congestion. Secondary: **SDG 13** (less idling / emissions).

## 1. Problem statement

Fixed-time traffic signals waste green on empty approaches and starve busy ones. At a Sri Lankan-style LHT 4-way junction, right turns need a protected overlap, and operators need a channel to report CCTV/queue counts and receive a **safe** next-cycle plan (min/max greens, fixed N→E→W→S order). Spreadsheet timing or guessing from an LLM is not acceptable for a live junction.

## 2. Solution overview

- **Agent Kernel** agent `junction_advisor` with tools: `record_queue_counts`, `compute_junction_plan`, `get_current_plan`, `get_junction_status`, `get_plan_history`.
- **Session memory** stores last counts and last plan (`ToolContext`).
- **Green seconds always come from** `pipeline.compute_timing_plan` (clamped proportional split). The LLM orchestrates and explains; it does not invent timings.
- **Slack** is the operator UI (`AgentSlackRequestHandler`). **CLI** (`demo.py`) is the judge fallback.
- **Dashboard** (React) + phone capture pages show the signal engine, queues, and SQLite audit trail. Plans queue until a side/loop boundary unless APPLY is used.

## 3. Setup instructions

Requirements: Python 3.12+, [uv](https://github.com/astral-sh/uv), Node.js 18+ (dashboard only).

From this folder (`use-cases/adaptive-junction/` after merge):

```bash
chmod +x build.sh
./build.sh
```

Windows: `uv venv` then `uv sync --all-extras --dev`.

Environment:

```bash
export OPENAI_API_KEY="sk-..."
# Slack (optional for local CLI-only judging)
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_SIGNING_SECRET="..."
```

Create a Slack app with `message.im`, `message.channels`, `app_mention`, and scopes `chat:write`, `im:write`, `app_mentions:read`. Request URL: `https://<tunnel>/slack/events` (use pinggy or ngrok to localhost:8000).

Frontend:

```bash
cd frontend
npm install
```

## 4. How to run the solution

**CLI (no Slack):**

```bash
uv run python demo.py
```

Example prompts:

- `North 15, East 2, South 4, West 1, North right 6. Compute the next 8-minute plan.`
- `What was the last plan?`
- `Why did North get more green?`

**Full demo (dashboard + API + Slack handler):**

```bash
uv run python server.py
```

In another terminal: `cd frontend && npm run dev -- --host 0.0.0.0`

Or on Windows double-click `start-demo.bat`.

- Dashboard: http://localhost:5173
- API docs: http://localhost:8000/docs
- Phone capture (same Wi-Fi, use PC LAN IP): `http://<LAN-IP>:5173/capture/north` (and east/south/west)

Turn **AGENT ON** so the engine requests a plan ~60s before the 8-minute loop wraps. **APPLY** installs a queued plan immediately. **SIM** generates fake demand when you have no phones.
