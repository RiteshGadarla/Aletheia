"""Alerting API (CONTRACTS §13.3): rules, contact points, policy tree, notification feed."""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, TypeVar

from fastapi import APIRouter, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from ..alerting.models import ContactPointIn, PolicyIn, PreviewIn, RuleIn, ValidationFailed
from ..alerting.service import AlertingService, Conflict, NotFound
from .state import get_state

router = APIRouter(prefix="/alerting")
log = logging.getLogger("studio.api.alerting")
T = TypeVar("T")


def _svc() -> AlertingService:
    return get_state().alerting


def _call(fn: Callable[..., T], *args: Any) -> T:
    """Map service exceptions onto the contract's status codes."""
    try:
        return fn(*args)
    except NotFound as e:
        raise HTTPException(404, str(e.args[0] if e.args else e)) from e
    except Conflict as e:
        raise HTTPException(409, str(e)) from e
    except ValidationFailed as e:
        raise HTTPException(400, str(e)) from e


# --------------------------------------------------------------------------- status
@router.get("/status")
def status() -> dict[str, Any]:
    return _svc().status()


@router.post("/sync")
def sync() -> dict[str, Any]:
    return _svc().force_sync()


# --------------------------------------------------------------------------- rules
@router.get("/rules")
def list_rules() -> dict[str, Any]:
    return {"rules": _svc().list_rules()}


@router.post("/rules", status_code=201)
def create_rule(body: RuleIn) -> dict[str, Any]:
    return _call(_svc().save_rule, body)


# Declared before /rules/{rid} so "preview" is never read as a rule id.
@router.post("/rules/preview")
def preview_rule(body: PreviewIn) -> dict[str, Any]:
    return _svc().preview(body.datasource, body.query, body.reducer, body.condition.model_dump())


@router.get("/rules/{rid}")
def get_rule(rid: str) -> dict[str, Any]:
    return _call(_svc().get_rule, rid)


@router.put("/rules/{rid}")
def update_rule(rid: str, body: RuleIn) -> dict[str, Any]:
    return _call(_svc().save_rule, body, rid)


@router.delete("/rules/{rid}", status_code=204)
def delete_rule(rid: str) -> Response:
    _call(_svc().delete_rule, rid)
    return Response(status_code=204)


# --------------------------------------------------------------------------- contact points
@router.get("/contact-points")
def list_contact_points() -> dict[str, Any]:
    return {"contact_points": _svc().list_contact_points()}


@router.post("/contact-points", status_code=201)
def create_contact_point(body: ContactPointIn) -> dict[str, Any]:
    return _call(_svc().save_contact_point, body)


@router.get("/contact-points/{cid}")
def get_contact_point(cid: str) -> dict[str, Any]:
    return _call(_svc().get_contact_point, cid)


@router.put("/contact-points/{cid}")
def update_contact_point(cid: str, body: ContactPointIn) -> dict[str, Any]:
    return _call(_svc().save_contact_point, body, cid)


@router.delete("/contact-points/{cid}", status_code=204)
def delete_contact_point(cid: str) -> Response:
    _call(_svc().delete_contact_point, cid)
    return Response(status_code=204)


@router.post("/contact-points/{cid}/test")
def test_contact_point(cid: str) -> dict[str, Any]:
    return _call(_svc().test_contact_point, cid)


# --------------------------------------------------------------------------- policy tree
@router.get("/policies")
def get_policy() -> dict[str, Any]:
    return _svc().get_policy()


@router.put("/policies")
def put_policy(body: PolicyIn) -> dict[str, Any]:
    return _call(_svc().put_policy, body)


# --------------------------------------------------------------------------- feed + receiver
@router.get("/notifications")
def notifications(after: int | None = Query(None, ge=0),
                  limit: int = Query(50, ge=1, le=200)) -> dict[str, Any]:
    return _svc().feed.list(after, limit)


@router.post("/receive", status_code=204)
async def receive(request: Request, contact_point: str | None = None) -> Response:
    """Grafana's webhook contact point posts here; malformed bodies are logged, never retried."""
    try:
        payload = json.loads(await request.body() or b"{}")
    except ValueError:
        log.warning("alert webhook with a non-JSON body ignored")
        return Response(status_code=204)
    if isinstance(payload, dict):
        await run_in_threadpool(_svc().receive, contact_point, payload)
    return Response(status_code=204)
