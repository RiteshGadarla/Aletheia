"""Heuristic OCSF mapping proposals (spec §8.8) plus AI-suggestion merging (spec §8.12.9)."""

from .heuristics import merge_ai_suggestion, propose_mapping

__all__ = ["propose_mapping", "merge_ai_suggestion"]
