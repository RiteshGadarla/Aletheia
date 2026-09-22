"""The reconstruction gate (spec §8.9). SAFETY-CRITICAL — never weaken these checks.

Shells out to the Go engine CLI (CONTRACTS §8) for the authoritative byte-exact reconstruction
check; nothing here fakes a pass when the engine binary is unavailable — a gate that cannot run
raises GateError, it never returns ok=True. Local checks (adjacent-slot ambiguity and per-value
type validation) reuse the Python mirror in derive/compile.py as an independent, defense-in-depth
cross-check against the same CONTRACTS §1 pattern table the Go engine implements.

NOTE (flagged per instructions): CONTRACTS §8 fixes the `test-pack` JSON *output* shape exactly,
but not the on-disk layout of the `--samples <dir>` argument. This module writes one `.log` file
per sample, mirroring the `tests/<id>/*.log` glob convention CONTRACTS §2 already uses for pack
golden tests. This is an inference, not a contract violation — revisit once the engine CLI (built
in parallel) lands, in case its samples-dir layout differs.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
import os
from pathlib import Path
from typing import Any

from ..core.models import GateCheck, GateReport, Token
from ..derive.compile import compile_tokens, match_values, type_ok, validate_tokens

log = logging.getLogger("studio.gate")

DEFAULT_TIMEOUT_S = 60


class GateError(RuntimeError):
    """The gate could not run at all (missing/broken engine binary, bad JSON). Never a silent pass."""


def _engine_available(engine_bin: str) -> bool:
    return shutil.which(engine_bin) is not None or Path(engine_bin).is_file()


def _write_samples_dir(samples: list[str], root: Path) -> Path:
    d = root / "samples"
    d.mkdir(parents=True, exist_ok=True)
    for i, s in enumerate(samples):
        (d / f"sample_{i:05d}.log").write_text(s if s.endswith("\n") else s + "\n",
                                                encoding="utf-8")
    return d


# The engine loads envelope templates from _envelopes.yaml beside the pack. Without it the
# proposed pack cannot be spliced and every sample "fails" for the wrong reason.
# ALETHEIA_PACKS_DIR is where the image actually installs the packs; parents[3] resolves to
# "/" there, so the gate silently fell back to a bare envelope and failed valid proposals.
_PACKS_DIR = Path(os.environ.get("ALETHEIA_PACKS_DIR",
                                 str(Path(__file__).resolve().parents[3] / "backend" / "packs")))
_REPO_ENVELOPES = _PACKS_DIR / "_envelopes.yaml"


def _write_envelopes(root: Path) -> None:
    if _REPO_ENVELOPES.is_file():
        shutil.copyfile(_REPO_ENVELOPES, root / "_envelopes.yaml")
        return
    # Minimal fallback: a bare envelope is just the body, which is what proposals use.
    (root / "_envelopes.yaml").write_text(
        "envelopes:\n  bare:\n    - {slot: body, type: text}\n", encoding="utf-8")


def run_test_pack(pack_yaml_text: str, samples: list[str], *, engine_bin: str = "aletheia",
                  timeout_s: int = DEFAULT_TIMEOUT_S) -> dict[str, Any]:
    """`aletheia test-pack --pack <file.yaml> --samples <dir> --json` (CONTRACTS §8).

    Raises GateError if the binary is missing, times out, or prints no parseable JSON. Never
    fabricates a result: a gate that cannot run is a hard error, not a pass.
    """
    if not _engine_available(engine_bin):
        raise GateError(
            f"engine binary {engine_bin!r} not found. The reconstruction gate requires the Go "
            "engine CLI (CONTRACTS §8: `aletheia test-pack --pack ... --samples ... --json`). "
            "Build backend/engine and set the engine.bin setting, or put it on PATH. "
            "Refusing to fake a pass."
        )
    if not samples:
        raise GateError("no samples given: the reconstruction gate cannot run on zero samples")
    with tempfile.TemporaryDirectory(prefix="aletheia-gate-") as tmp:
        root = Path(tmp)
        pack_path = root / "pack.yaml"
        pack_path.write_text(pack_yaml_text, encoding="utf-8")
        _write_envelopes(root)
        samples_dir = _write_samples_dir(samples, root)
        cmd = [engine_bin, "test-pack", "--pack", str(pack_path),
               "--samples", str(samples_dir), "--json"]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        except FileNotFoundError as exc:
            raise GateError(f"engine binary {engine_bin!r} could not be executed: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise GateError(f"engine test-pack timed out after {timeout_s}s") from exc
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise GateError(
                f"engine test-pack produced no parseable JSON (exit {proc.returncode}): "
                f"stdout={proc.stdout[:400]!r} stderr={proc.stderr[:400]!r}"
            ) from exc


def _local_checks(tokens: list[Token], samples: list[str]) -> tuple[GateCheck, GateCheck]:
    """Independent Python cross-check: adjacency (CONTRACTS §1) and per-value type validation."""
    problems = validate_tokens(tokens)
    adjacency = GateCheck(name="no_adjacent_ambiguous_slots", ok=not problems,
                          detail="; ".join(problems) if problems else "ok")

    try:
        compile_tokens(tokens)
    except Exception as exc:
        return adjacency, GateCheck(name="type_validation", ok=False,
                                    detail=f"template does not compile locally: {exc}")

    bad: list[str] = []
    slot_tokens = [t for t in tokens if not t.is_lit()]
    for i, s in enumerate(samples):
        values = match_values(tokens, s)
        if values is None:
            bad.append(f"sample {i}: does not match the compiled template")
            continue
        for tok, val in zip(slot_tokens, values):
            if not type_ok(tok.type or "word", val, tok):
                bad.append(f"sample {i}: slot {tok.slot!r} value {val!r} fails type {tok.type!r}")
    type_check = GateCheck(name="type_validation", ok=not bad,
                           detail="; ".join(bad[:10]) + (" ..." if len(bad) > 10 else "")
                           if bad else "ok")
    return adjacency, type_check


def run_gate(pack_yaml_text: str, tokens: list[Token], samples: list[str], *,
            engine_bin: str = "aletheia",
            golden_samples: list[str] | None = None,
            total_quarantined: int | None = None,
            timeout_s: int = DEFAULT_TIMEOUT_S) -> GateReport:
    """The five checks of spec §8.9, in order. Reject unless every one of them holds.

    Raises GateError (does not return a report) if the engine cannot be invoked at all — a
    proposal is never approved on the strength of a gate that didn't actually run.
    """
    checks: list[GateCheck] = []

    result = run_test_pack(pack_yaml_text, samples, engine_bin=engine_bin, timeout_s=timeout_s)
    reconstructed = int(result.get("reconstructed", 0) or 0)
    reported_samples = int(result.get("samples", len(samples)) or len(samples))
    recon_ok = bool(result.get("ok")) and reconstructed == len(samples) \
        and reported_samples == len(samples)
    checks.append(GateCheck(
        name="byte_exact_reconstruction", ok=recon_ok,
        detail=f"{reconstructed}/{reported_samples} samples reconstructed byte-exactly; "
               f"failures={result.get('failures', [])}",
    ))

    adjacency, type_check = _local_checks(tokens, samples)
    checks.append(adjacency)
    checks.append(type_check)

    if golden_samples:
        try:
            golden_result = run_test_pack(pack_yaml_text, golden_samples, engine_bin=engine_bin,
                                          timeout_s=timeout_s)
            g_reconstructed = int(golden_result.get("reconstructed", 0) or 0)
            golden_ok = bool(golden_result.get("ok")) and g_reconstructed == len(golden_samples)
            checks.append(GateCheck(
                name="golden_tests_no_regression", ok=golden_ok,
                detail=f"{g_reconstructed}/{len(golden_samples)} existing golden samples still "
                       f"reconstruct; failures={golden_result.get('failures', [])}",
            ))
        except GateError as exc:
            checks.append(GateCheck(name="golden_tests_no_regression", ok=False, detail=str(exc)))
    else:
        checks.append(GateCheck(name="golden_tests_no_regression", ok=True,
                                detail="no existing golden tests for this pack version"))

    matched = reconstructed if recon_ok else 0
    coverage: dict[str, Any] = {"matched_samples": matched, "cluster_size": len(samples)}
    coverage_detail = f"matched {matched}/{len(samples)} cluster samples"
    if total_quarantined:
        share = round(matched / total_quarantined, 4)
        coverage["total_quarantined"] = total_quarantined
        coverage["share"] = share
        coverage_detail += f"; {share:.2%} of this source's {total_quarantined} quarantined lines"
    else:
        coverage["note"] = ("total_quarantined not supplied; pass it from the events store for "
                            "a full source-level coverage share")
        coverage_detail += "; total_quarantined not supplied"
    checks.append(GateCheck(name="coverage_report", ok=True, detail=coverage_detail))

    ok = all(c.ok for c in checks if c.name != "coverage_report")
    return GateReport(ok=ok, checks=checks, samples=len(samples), reconstructed=reconstructed,
                      failures=list(result.get("failures", []) or []), coverage=coverage)
