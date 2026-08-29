# Person 1 — Allocator pipeline

**Folder:** `real plan/1/`  
**Merges into:** `use-cases/adaptive-junction/pipeline.py` + `models.py`  
**Source:** `the app for color light shiiiiiit/backend/app/services/agent.py` and `.../models/schemas.py`  
**Read first:** `../CONTRACT.md`

## What you own

The **deterministic brain**. Queue lengths in → green seconds out. No FastAPI, no Slack, no React, no Agent Kernel.

| File you create here | After merge |
|----------------------|-------------|
| `models.py` | same name |
| `pipeline.py` | same name |
| `test_pipeline.py` | `tests/test_pipeline.py` |

## Do

1. Copy Pydantic models from `schemas.py` into `models.py`. Change `from app.models...` to local `from models import ...`.
2. Copy allocator classes (`PairAggregationAgent` … `PedestrianAgent`, `PriorityAgentPipeline`) into `pipeline.py`.
3. Keep `compute_timing_plan(counts) -> TimingPlanPayload` as the **only** function Person 4 and Person 5 will call.
4. Keep 8-minute loop math: `CYCLE_TOTAL = 480`, `GREEN_POOL`, `MIN_GREEN = 30`, `MAX_GREEN = 210`, order **N → E → W → S**.
5. Drop Gemini / `llm.py`. `reason` stays the rule-based string from the pipeline.
6. Port the pipeline assertions from `backend/smoke_test.py` into `test_pipeline.py`.

## Tests you must pass (alone)

- Empty counts → greens sum ≈ `GREEN_POOL`, each side in `[MIN_GREEN, MAX_GREEN]`
- Busy north (e.g. 30 vs 2/2/2) → north `straight_s` larger than east/west/south
- `reason` mentions the N→E→W→S loop

Run: `python -m pytest test_pipeline.py` (after you have pytest + pydantic).

## Do not

- Do not import `agentkernel`, FastAPI, SQLAlchemy, or frontend.
- Do not invent green times with an LLM.
- Do not change function names in `CONTRACT.md`.

## Done when

Person 4 can `from pipeline import compute_timing_plan` and Person 2 can `from models import TimingPlanPayload`.
