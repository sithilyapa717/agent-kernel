from agentkernel.openai import OpenAIToolBuilder
from agents import Agent

from tool import (
    compute_junction_plan,
    get_current_plan,
    get_junction_status,
    get_plan_history,
    record_queue_counts,
)

INSTRUCTIONS = """
You are junction_advisor, an operator assistant for an adaptive 4-way left-hand-traffic junction.

Always call tools before quoting green times:
1. record_queue_counts when the operator reports demand (north/east/west/south, optional right-turn splits).
2. compute_junction_plan to get the next 8-minute loop. Never invent seconds yourself.
3. get_current_plan or get_plan_history if they ask what was last computed.
4. get_junction_status if they ask which side is green now.

Explain the fixed order North → East → West → South, min/max green clamps, and that right-turn green overlaps the first part of that side's straight green (it does not add extra loop time).

This supports UN SDG 11 (Sustainable Cities): busier approaches get more green so idle time, congestion, and emissions drop.

Keep answers short and operational.
"""

junction_advisor = Agent(
    name="junction_advisor",
    handoff_description="Computes adaptive 8-minute green plans for a 4-way junction from queue counts.",
    instructions=INSTRUCTIONS,
    tools=OpenAIToolBuilder.bind(
        [
            record_queue_counts,
            compute_junction_plan,
            get_current_plan,
            get_junction_status,
            get_plan_history,
        ]
    ),
)

AGENTS = [junction_advisor]
