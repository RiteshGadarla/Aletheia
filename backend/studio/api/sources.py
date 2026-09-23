"""Sources API: register systems, receive pushed logs, browse raw, human-approved onboarding."""
from __future__ import annotations

import asyncio
import gzip
import json
import re
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..ingest import onboarding
from ..ingest.forward import backfill
from ..ingest.sources import Source, TYPES, validate
from ..llm.assistant import ask_ai
from .state import get_state

router = APIRouter()
MIN_LINES_FOR_REVIEW = 100


def _worker_up() -> bool:
    """The engine worker exposes metrics on :9108; if nothing answers, approved logs go nowhere."""
    import os
    import socket
    host, _, port = os.environ.get("ALETHEIA_WORKER_METRICS", "127.0.0.1:9108").rpartition(":")
    try:
        with socket.create_connection((host or "127.0.0.1", int(port)), timeout=0.25):
            return True
    except OSError:
        return False


def _view(s: Source) -> dict[str, Any]:
    st = get_state()
    ps = st.pipeline.stats.get(s.id)
    now = int(time.time())
    recent = sum(n for sec, n in (ps.series if ps else []) if sec >= now - 10)
    return {
        "id": s.id, "name": s.name or s.id, "type": s.type, "config": s.config, "enabled": s.enabled,
        "state": s.state, "attempts": s.attempts, "created_at": s.created_at, "history": s.history[-10:],
        **st.connectors.status(s.id),
        "lines": ps.lines if ps else 0, "bytes": ps.bytes if ps else 0, "errors": ps.errors if ps else 0,
        "eps": round(recent / 10, 2), "last_seen": ps.last_seen if ps else None,
        "by_severity": dict(ps.by_severity) if ps else {},
        "has_proposal": s.id in onboarding.PROPOSALS,
        "ready_for_review": s.state == "collecting" and bool(ps and ps.lines >= MIN_LINES_FOR_REVIEW),
    }


class SourceIn(BaseModel):
    id: str
    type: str
    name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class SourcePatch(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    enabled: bool | None = None


@router.get("/sources")
def list_sources() -> dict[str, Any]:
    st = get_state()
    return {"store": st.raw.kind, "bus": st.forwarder.enabled, "worker": _worker_up(), "types": list(TYPES),
            "sources": [_view(s) for s in st.registry.list()]}


@router.post("/sources", status_code=201)
def create_source(body: SourceIn) -> dict[str, Any]:
    st = get_state()
    try:
        src = st.registry.add(Source(id=body.id, type=body.type, name=body.name,
                                     config=body.config, enabled=body.enabled))
    except KeyError as e:
        raise HTTPException(409, str(e)) from e
    except (ValueError, TypeError) as e:
        raise HTTPException(422, str(e)) from e
    st.registry.event(src.id, "created", "api")
    st.connectors.sync(src)
    return _view(src)


def _get(sid: str) -> Source:
    s = get_state().registry.get(sid)
    if s is None:
        raise HTTPException(404, f"no source {sid}")
    return s


@router.patch("/sources/{sid}")
def patch_source(sid: str, body: SourcePatch) -> dict[str, Any]:
    st, s = get_state(), _get(sid)
    kw = {k: v for k, v in body.model_dump().items() if v is not None}
    trial = Source(**{**s.__dict__, **kw})
    try:
        validate(trial)
    except (ValueError, TypeError) as e:
        raise HTTPException(422, str(e)) from e
    s = st.registry.update(sid, **kw)
    st.connectors.sync(s)
    return _view(s)


@router.delete("/sources/{sid}")
def delete_source(sid: str) -> dict[str, Any]:
    _get(sid)
    st = get_state()
    st.connectors.remove(sid)
    st.registry.delete(sid)
    onboarding.delete_proposal(sid, st.repo)
    return {"deleted": sid}


@router.get("/sources/{sid}/raw")
def raw_lines(sid: str, limit: int = 100, q: str | None = None, severity: str | None = None) -> dict[str, Any]:
    _get(sid)
    try:
        rows = get_state().raw.query(sid, limit=min(limit, 1000), text=q or None, severity=severity or None)
    except Exception as e:                                                      # noqa: BLE001
        raise HTTPException(503, f"raw store unavailable: {type(e).__name__}") from e
    return {"source_id": sid, "count": len(rows), "lines": rows}


# ------------------------------------------------------------------ push receivers
_SAFE = re.compile(r"[^A-Za-z0-9_.:-]")


def _sid(name: str) -> str:
    return _SAFE.sub("_", name)[:63] or "unknown"


async def _body(req: Request) -> bytes:
    b = await req.body()
    if req.headers.get("content-encoding") == "gzip":
        b = gzip.decompress(b)
    return b


@router.post("/ingest/loki/push", status_code=204, response_class=Response)
async def loki_push(req: Request) -> Response:
    """Loki-compatible JSON push, so Vector, Fluent Bit, Logstash etc. can point at Aletheia."""
    st = get_state()
    try:
        data = json.loads(await _body(req))
        streams = data["streams"]
    except (ValueError, KeyError, OSError) as e:
        raise HTTPException(400, "expected Loki JSON push body {streams:[...]}") from e
    for s in streams:
        lb = s.get("stream", {})
        sid = _sid(lb.get("source") or lb.get("job") or lb.get("service_name") or "loki-unknown")
        st.registry.ensure(sid, "push")
        vals = s.get("values", [])
        base = int(vals[0][0]) if vals and str(vals[0][0]).isdigit() else None
        await st.pipeline.submit(sid, [v[1] for v in vals], "loki_push", ts_ns=base)
    return Response(status_code=204)


@router.post("/ingest/{sid}", status_code=202)
async def push_lines(sid: str, req: Request) -> dict[str, Any]:
    """Raw newline-delimited lines; an unknown id registers itself as a pending source."""
    st = get_state()
    sid = _sid(sid)
    st.registry.ensure(sid, "push")
    text = (await _body(req)).decode("utf-8", "replace")
    n = await st.pipeline.submit(sid, text.split("\n"), "push")
    return {"source_id": sid, "accepted": n}


# ------------------------------------------------------------------ onboarding
class ProposeIn(BaseModel):
    class_hint: int | None = None
    feedback: str = ""


class DecisionIn(BaseModel):
    action: str                                   # approve | reject | retry
    approver: str = ""
    reason: str = ""
    cluster_ids: list[str] | None = None
    class_hint: int | None = None
    feedback: str = ""


def _ai_mapper() -> onboarding.AIMapper:
    """The configured LLM maps each unique format; ask_ai never raises and reports why it declined."""
    st = get_state()
    cfg = st.settings.llm_config()
    return lambda tpl, hint, feedback: ask_ai(tpl, cfg, counter=st.usage, class_hint=hint, feedback=feedback)


def _run_proposal(s: Source, class_hint: int | None, feedback: str) -> dict[str, Any]:
    st = get_state()
    if not any(True for _ in st.raw.query(s.id, limit=1)):
        raise HTTPException(409, "no raw lines collected yet")
    prop = onboarding.propose(st.raw, s.id, s.attempts, class_hint=class_hint, feedback=feedback,
                              repo=st.repo, ai=_ai_mapper())
    st.registry.update(s.id, state="review")
    return prop


@router.post("/sources/{sid}/propose")
def make_proposal(sid: str, body: ProposeIn | None = None) -> dict[str, Any]:
    s, body = _get(sid), body or ProposeIn()
    if s.state == "approved":
        raise HTTPException(409, "source already approved")
    prop = _run_proposal(s, body.class_hint, body.feedback)
    return onboarding.public(prop)


@router.get("/sources/{sid}/review")
def review(sid: str) -> dict[str, Any]:
    s = _get(sid)
    st = get_state()
    prop = onboarding.get_proposal(sid, st.repo, st.raw)
    if prop and s.state == "collecting":
        s = st.registry.update(sid, state="review")
    return {"source": _view(s), "proposal": onboarding.public(prop) if prop else None}


@router.post("/sources/{sid}/decision")
async def decide(sid: str, body: DecisionIn) -> dict[str, Any]:
    # Clustering, LLM calls, Postgres and bus writes are blocking: run them in threads so one
    # decision never freezes every other request (the UI polls all of them).
    _get(sid)
    actor = body.approver.strip()
    if not actor:
        raise HTTPException(422, "a named human approver is required")
    if body.action == "reject":
        return await asyncio.to_thread(_reject, sid, actor, body)
    if body.action == "retry":
        return await asyncio.to_thread(_retry, sid, actor, body)
    if body.action != "approve":
        raise HTTPException(422, "action must be approve, reject or retry")
    st = get_state()
    rows, version, prop = await asyncio.to_thread(_approve_packs, sid, actor, body)
    if st.forwarder.enabled:
        await asyncio.sleep(2.0)                     # let the worker swap in the new parser first
    approved_ns = await asyncio.to_thread(_approve_finish, sid, actor, rows, version, prop)
    fwd = await asyncio.to_thread(backfill, st.raw, st.forwarder, sid, 200_000, approved_ns)
    return {"source": _view(_get(sid)), "packs": [r["pack"] for r in rows], "backfilled": fwd,
            "bus": st.forwarder.enabled}


def _reject(sid: str, actor: str, body: DecisionIn) -> dict[str, Any]:
    st = get_state()
    _get(sid)
    st.registry.update(sid, state="rejected")
    st.registry.event(sid, "rejected", actor, {"reason": body.reason})
    st.repo.audit(actor, "source.reject", sid, {"reason": body.reason})
    return {"source": _view(_get(sid))}


def _retry(sid: str, actor: str, body: DecisionIn) -> dict[str, Any]:
    st, s = get_state(), _get(sid)
    st.registry.update(sid, attempts=s.attempts + 1)
    st.registry.event(sid, "retry", actor, {"feedback": body.feedback, "class_hint": body.class_hint})
    prop = _run_proposal(_get(sid), body.class_hint, body.feedback)
    return {"source": _view(_get(sid)), "proposal": onboarding.public(prop)}


def _approve_packs(sid: str, actor: str, body: DecisionIn) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
    st, s = get_state(), _get(sid)
    prop = onboarding.get_proposal(sid, st.repo, st.raw)
    if not prop:
        raise HTTPException(409, "nothing to approve: generate a proposal first")
    if s.state == "collecting":
        st.registry.update(sid, state="review")
    chosen = [c for c in prop["clusters"] if not body.cluster_ids or c["cluster_id"] in body.cluster_ids]
    if not chosen:
        raise HTTPException(422, "no matching clusters")
    bad = [c["cluster_id"] for c in chosen if c["gate"] is not None and not c["gate"].get("ok")]
    if bad:
        raise HTTPException(409, f"reconstruction gate failed for {', '.join(bad)}; retry or reject")
    rows = onboarding.build_packs(sid, [c["cluster_id"] for c in chosen], actor, st.repo)
    version, everything = onboarding.snapshot(st.repo, rows)
    for r in everything:
        st.repo.pack_upsert(r)
    st.bus.publish_pack_approved(rows[-1]["pack"], version, rows[-1]["checksum"], sid)
    return rows, version, prop


def _approve_finish(sid: str, actor: str, rows: list[dict[str, Any]], version: int,
                    prop: dict[str, Any]) -> int:
    st = get_state()
    approved_ns = time.time_ns()
    st.registry.update(sid, state="approved", approved_ns=approved_ns)
    st.registry.event(sid, "approved", actor, {"packs": [r["pack"] for r in rows], "version": version})
    st.repo.audit(actor, "source.approve", sid, {"packs": [r["pack"] for r in rows], "version": version})
    onboarding.save_proposal(sid, prop, st.repo)
    return approved_ns


async def auto_propose_loop() -> None:
    """Move sources with enough raw data to `review` so a human finds a proposal waiting."""
    while True:
        await asyncio.sleep(10)
        st = get_state()
        for s in st.registry.list():
            if s.state == "collecting":
                # Postgres and pack reconstruction block; keep them off the event loop.
                prop = await asyncio.to_thread(onboarding.get_proposal, s.id, st.repo, st.raw)
                if prop:
                    st.registry.update(s.id, state="review")
                else:
                    ps = st.pipeline.stats.get(s.id)
                    if ps and ps.lines >= MIN_LINES_FOR_REVIEW:
                        try:
                            await asyncio.to_thread(_run_proposal, s, None, "")
                        except Exception:                                                # noqa: BLE001
                            pass

