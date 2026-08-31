# Adaptive Junction Advisor

This folder is an **Agent Kernel** use case. It helps a traffic operator run a 4-way left-hand-traffic junction: you report how many vehicles are waiting on each approach, and the agent returns a **safe 8-minute green plan**. A live dashboard shows the lamps. Operators talk to the agent over **Slack**. If you do not have Slack, use the **CLI**.

This supports **UN SDG 11** (Sustainable Cities and Communities): busier roads get more green, so idle time and congestion drop. It also supports **SDG 13** by cutting idling emissions.

You do not need to understand the whole Agent Kernel repository. Work only in this folder: `use-cases/adaptive-junction/`.

---

## 1. Problem statement

Fixed-time traffic lights waste green on empty approaches and starve busy ones. At a Sri Lankan-style 4-way junction (left-hand traffic), right turns need a protected overlap. An operator watching CCTV still needs a channel to send queue counts and get a **repeatable** next-cycle plan: minimum and maximum greens, and a fixed order **North → East → West → South**.

A language model must not invent seconds. Guessing timings is not acceptable on a live junction. The agent is only the operator interface. The numbers always come from a deterministic allocator.

---

## 2. Solution overview

Here is what you get when you run this project:

1. **Agent Kernel agent** named `junction_advisor`. You talk to it in Slack (primary) or in the CLI (fallback).
2. **Tools** the agent must call before it quotes green times:
   - `record_queue_counts` — store north / east / west / south (and optional right-turn splits)
   - `compute_junction_plan` — run the allocator and queue the plan on the live engine
   - `get_current_plan` — last plan in this session
   - `get_junction_status` — which side is green now
   - `get_plan_history` — recent plans from SQLite
3. **Session memory** (Agent Kernel `ToolContext`) remembers the last counts and last plan for that conversation.
4. **Allocator** in `pipeline.py` (`compute_timing_plan`). It splits an 8-minute loop with min/max clamps. Right-turn green overlaps the first part of that side’s straight green; it does not add extra loop time.
5. **Dashboard** (React) on port 5173: lamps, queues, audit trail. **SIM** invents demand if you have no cameras. **AGENT ON** lets the engine retune from those queues. **APPLY** installs a queued plan immediately.
6. **Optional phones** on the same Wi-Fi can open capture pages and send detections. That is extra. Judges can use **SIM** only.

---

## 3. Setup instructions

Do this once on the machine that will run the demo.

### What you need

| Software | Why |
|---|---|
| Python **3.12** or newer | Backend, agent, API |
| [uv](https://github.com/astral-sh/uv) | Official Agent Kernel installer (macOS / Linux; also fine on Windows) |
| Node.js **18+** and npm | Dashboard only |
| An **OpenAI API key** | Required for Slack and CLI. The dashboard lamps still move without it if you use SIM only. |

On **Windows**, if you do not want to install `uv`, you can skip to [Quick start on Windows](#quick-start-on-windows) and use `start-demo.bat`. That script creates a `.venv` with `pip`.

### Open this folder

```bash
cd use-cases/adaptive-junction
```

All commands below assume you are in this directory.

### Install Python packages (uv)

macOS / Linux:

```bash
chmod +x build.sh
./build.sh
```

Windows (PowerShell), with uv installed:

```powershell
uv venv
uv sync --all-extras --dev
```

`build.sh` does the same thing: create a virtualenv and sync dependencies from `pyproject.toml` (Agent Kernel with CLI, OpenAI, API, and Slack extras, plus SQLAlchemy and the dashboard API stack).

### Install the dashboard

```bash
cd frontend
npm install
cd ..
```

### Put your API keys in the environment

Never commit keys. Do not put them in the frontend.

**OpenAI** is required whenever you talk to the agent (Slack or CLI).

macOS / Linux:

```bash
export OPENAI_API_KEY="sk-..."
```

Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="sk-..."
```

Windows Command Prompt:

```bat
set OPENAI_API_KEY=sk-...
```

**Slack** is the intended operator UI. Set these as well when you want Slack:

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_SIGNING_SECRET="..."
```

Create a Slack app at [https://api.slack.com/apps](https://api.slack.com/apps):

1. Enable **Event Subscriptions**. Request URL: `https://<your-public-tunnel>/slack/events` (use ngrok or pinggy pointed at `localhost:8000`).
2. Subscribe to bot events: `message.im`, `message.channels`, `app_mention`.
3. OAuth scopes: `chat:write`, `im:write`, `app_mentions:read`.
4. Install the app to your workspace and copy the Bot Token and Signing Secret.

If Slack tokens are missing, `server.py` still starts the dashboard API. The agent in Slack will not answer until the tokens are set.

**Roboflow / phones** are optional. Copy `.env.example` to `.env` in this folder and fill `ROBOFLOW_API_KEY` only if you will run phone capture with the local Inference Server. Do not commit `.env`.

---

## 4. How to run the solution

Pick one path. For a full demo (lamps + agent), use **A**. For a 30-second agent check with no UI, use **B**. For Slack, use **A** plus the Slack env vars.

### Quick start on Windows

1. Open `use-cases\adaptive-junction` in File Explorer.
2. Double-click `start-demo.bat`.
3. Wait until it says the API is up. Leave the extra windows open.
4. Open **http://localhost:5173** in the browser.

The script installs packages if needed, starts `server.py` on port **8000**, and starts the Vite UI.

If Windows Firewall blocks phones, run `allow-phone.bat` once as Administrator. Phones are not required for a first demo.

### A. Full demo (dashboard + API + Slack handler) — recommended

Terminal 1 — API (this also registers the Slack handler when Slack env vars are present):

```bash
uv run python server.py
```

Leave that process running. You should see logs that Agent Kernel started. If Slack tokens are set, the handler is included. If they are not, you still get the dashboard API.

Terminal 2 — UI:

```bash
cd frontend
npm run dev -- --host 0.0.0.0
```

Open:

| What | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| API docs | http://localhost:8000/docs |

**Walk through the dashboard once:**

1. Click **SIM ON** if it is not already on. Fake vehicles appear and queues change. You do not need phones.
2. Leave **AGENT ON**. About 60 seconds before the 8-minute loop wraps, the engine asks for a new plan from the allocator. Status text under the chips explains what the agent is doing.
3. Click **APPLY** if a plan is queued and you want it on the lamps immediately (otherwise it waits for a side / loop boundary).
4. Use **RUN NOW** if you want a plan computed from current queues right away, even with AGENT off.

You should see greens move N → E → W → S, with yellow and all-red between sides, and a reason string for the last plan.

### B. CLI only (no Slack, no dashboard)

Use this when you only want to verify the Agent Kernel agent.

```bash
export OPENAI_API_KEY="sk-..."   # skip if already set
uv run python demo.py
```

If the CLI asks you to pick an agent:

```text
!list
!select junction_advisor
```

Then type a message as the operator, for example:

```text
North 15, East 2, South 4, West 1, North right 6. Compute the next 8-minute plan.
```

Try follow-ups in the same session:

```text
What was the last plan?
Why did North get more green?
Which side is green now?
```

The agent should call tools first, then explain the fixed order, the min/max clamps, and that right-turn green overlaps straight green.

### C. Slack (primary operator UI)

1. Set `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, and `SLACK_SIGNING_SECRET`.
2. Start a tunnel to port 8000 and put `https://<tunnel>/slack/events` in the Slack app Event Subscriptions.
3. Run `uv run python server.py` (or `start-demo.bat`).
4. Invite the bot to a channel, or open a DM with it.
5. Send the same kind of message as in the CLI, for example:  
   `North 20, East 3, South 5, West 2. Compute the next plan.`

You should get a short operational reply with the split. The acknowledgement text is configured in `config.yaml` as `Computing junction timings...`.

If Slack is not configured, use the CLI. Do not treat Slack as unused: it is the intended operator channel; CLI is the fallback when a judge has no Slack app.

### Optional: phone capture

Only if you want cameras instead of SIM:

1. PC and phones on the same Wi-Fi.
2. Start the dashboard as in section A.
3. On a phone, open `http://<PC-LAN-IP>:5173/capture/north` (and `/east`, `/south`, `/west`). Chrome on phones often needs **HTTPS** for the camera; `start-demo.bat` also starts `npm run dev:lan` on port **5174** for that.
4. Allow the camera. Put `ROBOFLOW_API_KEY` in `.env` and run the Roboflow Windows Inference Server on port **9001** if you use that path.

If phones fail, turn **SIM ON** and continue. The agent and allocator do not depend on Roboflow.

---

## What each important file does

| File | Role |
|---|---|
| `agent.py` | Defines `junction_advisor` and binds tools |
| `tool.py` | Agent Kernel tools + session keys |
| `demo.py` | CLI entry (`OpenAIModule` + `CLI.main`) |
| `server.py` | FastAPI on port 8000: REST + optional Slack |
| `pipeline.py` | Deterministic 8-minute split |
| `signal_engine.py` | Lamp sequence, yellow, all-red, right-turn overlap |
| `junction_runtime.py` | Ties engine, sim, persistence, agent triggers |
| `config.yaml` | Agent Kernel session, API host/port, Slack ack |
| `frontend/` | Dashboard and capture pages |
| `SPEC.md` / `AGENTS.md` | Spec for coding agents |

---

## If something goes wrong

- **Port 8000 already in use** — stop the other process, or close the extra `junction-api` window from a previous `start-demo.bat` run.
- **Dashboard cannot reach the API** — confirm `server.py` is running and `config.yaml` still has `api.custom_router_prefix: ""`.
- **CLI or Slack invents timings** — that is a bug. The instructions in `agent.py` require `compute_junction_plan`. Try again with “call the tools, do not invent seconds.”
- **`agentkernel` import failed** — install extras: `uv sync --all-extras --dev` or `pip install "agentkernel[cli,openai,api,slack]>=0.8.1"`. Dashboard-only mode can still run lamps without the agent.
- **Tests** — from this folder: `uv run pytest` (or `pytest` inside `.venv`). No OpenAI key is required for the unit tests.

---

## How to judge this quickly

1. `cd use-cases/adaptive-junction`
2. Set `OPENAI_API_KEY`.
3. Run the CLI (`uv run python demo.py`) and send one queue message. Confirm a plan with four sides and a reason.
4. Run the dashboard (`server.py` + Vite, or `start-demo.bat`). Turn **SIM ON**, leave **AGENT ON**, watch greens change.
5. If Slack tokens are available, send the same queue message in Slack.

That is the full intended user flow: operator in Slack (or CLI) → Agent Kernel tools → allocator → live junction on the dashboard.
