"""Unified Agent Kernel server: Slack + REST + junction WebSocket on port 8000."""
from __future__ import annotations

import uvicorn
from agentkernel.api import RESTAPI, AgentRESTRequestHandler
from agentkernel.core.config import AKConfig
from agentkernel.openai import OpenAIModule
from agentkernel.slack import AgentSlackRequestHandler

from agent import AGENTS
from api_router import router
from junction_runtime import shutdown, startup

OpenAIModule(AGENTS)
RESTAPI.add(router)

app = RESTAPI.build_app(
    [
        AgentSlackRequestHandler(),
        AgentRESTRequestHandler(),
    ]
)


@app.on_event("startup")
async def _startup() -> None:
    await startup()


@app.on_event("shutdown")
async def _shutdown() -> None:
    await shutdown()


if __name__ == "__main__":
    cfg = AKConfig.get().api
    uvicorn.run(app, host=cfg.host, port=cfg.port, reload=False)
