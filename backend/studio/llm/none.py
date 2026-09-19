"""The default: no AI at all. Heuristics carry onboarding on their own (spec §8.12.1)."""

from __future__ import annotations

from ..core.models import ConnTest
from .base import LLMUnavailable


class NoneProvider:
    name = "none"
    model = ""

    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        raise LLMUnavailable("no AI provider configured")

    def test_connection(self) -> ConnTest:
        return ConnTest(ok=True, json_mode=None, provider="none", model="",
                        error="no provider configured (heuristics only)")

    def list_models(self) -> list[str]:
        return []
