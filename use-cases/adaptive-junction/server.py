"""API server on port 8000.

Tries full Agent Kernel (Slack + REST). If that import/setup fails, still
serves the junction dashboard API so the pitch UI can run.
"""
from __future__ import annotations

import logging
import traceback

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from api_router import router
from junction_runtime import shutdown, startup

logging.basicConfig(level=logging.INFO)
_log = logging.getLogger("adaptive-junction")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    await startup()
    yield
    await shutdown()


def _plain_fastapi() -> FastAPI:
    app = FastAPI(title="Adaptive Junction", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    return app


def _agent_kernel_app() -> FastAPI:
    from agentkernel.api import RESTAPI, AgentRESTRequestHandler
    from agentkernel.openai import OpenAIModule
    from agent import AGENTS

    OpenAIModule(AGENTS)
    RESTAPI.add(router)

    handlers = [AgentRESTRequestHandler()]
    try:
        from agentkernel.slack import AgentSlackRequestHandler

        handlers.insert(0, AgentSlackRequestHandler())
    except Exception as exc:
        _log.warning("Slack handler skipped: %s", exc)

    app = RESTAPI.build_app(handlers)

    @app.on_event("startup")
    async def _startup() -> None:
        await startup()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await shutdown()

    return app


try:
    app = _agent_kernel_app()
    _log.info("Running with Agent Kernel (Slack optional)")
except Exception:
    _log.warning("Agent Kernel not available — dashboard API only:\n%s", traceback.format_exc())
    app = _plain_fastapi()


if __name__ == "__main__":
    host, port = "0.0.0.0", 8000
    try:
        from agentkernel.core.config import AKConfig

        cfg = AKConfig.get().api
        host, port = cfg.host, cfg.port
    except Exception:
        pass
    print(f"Junction API: http://127.0.0.1:{port}/api/health", flush=True)
    uvicorn.run(app, host=host, port=port, reload=False)
