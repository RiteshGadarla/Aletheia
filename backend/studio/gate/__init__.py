"""The reconstruction gate (spec §8.9). SAFETY-CRITICAL: see reconstruction.run_gate."""

from .reconstruction import GateError, run_gate, run_test_pack

__all__ = ["run_gate", "run_test_pack", "GateError"]
