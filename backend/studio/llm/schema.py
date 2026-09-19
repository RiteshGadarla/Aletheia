"""Schema-constrained AI output (spec §8.12.4).

OCSF target paths are an enumerated allow-list read from backend/ocsf/. That list is the
anti-prompt-injection control: a path the model invents cannot pass validation.
"""

from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

log = logging.getLogger("studio.llm.schema")

# Used only until backend/ocsf/ ships a path list. Deliberately small (spec §8.12.4).
BUILTIN_PATHS: dict[int, list[str]] = {
    4001: [
        "src_endpoint.ip", "src_endpoint.port", "src_endpoint.hostname",
        "src_endpoint.interface_name", "src_endpoint.mac", "src_endpoint.svc_name",
        "dst_endpoint.ip", "dst_endpoint.port", "dst_endpoint.hostname",
        "dst_endpoint.interface_name", "dst_endpoint.mac", "dst_endpoint.svc_name",
        "proxy_endpoint.ip", "proxy_endpoint.port",
        "connection_info.uid", "connection_info.protocol_name",
        "connection_info.protocol_num", "connection_info.direction_id",
        "connection_info.tcp_flags", "connection_info.boundary_id",
        "traffic.bytes", "traffic.packets", "traffic.bytes_in", "traffic.bytes_out",
        "action_id", "activity_id", "disposition_id", "severity_id", "status_id",
        "message", "duration", "policy.name", "policy.uid",
        "device.name", "device.hostname", "device.ip", "user.name",
    ],
    4002: [
        "http_request.url.text", "http_request.url.path", "http_request.url.hostname",
        "http_request.http_method", "http_request.user_agent", "http_request.referrer",
        "http_response.code", "http_response.content_type", "http_response.length",
        "src_endpoint.ip", "src_endpoint.port", "dst_endpoint.ip", "dst_endpoint.port",
        "dst_endpoint.hostname", "action_id", "activity_id", "severity_id", "status_id",
        "message", "duration", "traffic.bytes", "user.name",
    ],
    4003: [
        "query.hostname", "query.type", "query.class", "rcode_id",
        "answers.rdata", "answers.type",
        "src_endpoint.ip", "src_endpoint.port", "dst_endpoint.ip", "dst_endpoint.port",
        "action_id", "activity_id", "severity_id", "status_id", "message",
    ],
    3002: [
        "user.name", "user.uid", "user.domain", "user.type_id",
        "src_endpoint.ip", "src_endpoint.port", "src_endpoint.hostname",
        "dst_endpoint.ip", "dst_endpoint.hostname",
        "auth_protocol", "auth_protocol_id", "logon_type", "logon_type_id",
        "session.uid", "is_mfa", "activity_id", "status_id", "status_detail",
        "severity_id", "message",
    ],
    2004: [
        "finding_info.title", "finding_info.uid", "finding_info.desc",
        "risk_level_id", "confidence_id", "severity_id", "activity_id", "status_id",
        "src_endpoint.ip", "dst_endpoint.ip", "message",
    ],
}

CLASS_NAMES = {
    4001: "Network Activity", 4002: "HTTP Activity", 4003: "DNS Activity",
    3002: "Authentication", 2004: "Detection Finding",
}


def ocsf_dir() -> Path:
    env = os.environ.get("ALETHEIA_OCSF_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "ocsf"


@lru_cache(maxsize=4)
def _load_from_disk(dirpath: str) -> tuple[dict[int, list[str]], str]:
    """Best-effort read of backend/ocsf/. Another agent generates it; code defensively."""
    base = Path(dirpath)
    if not base.is_dir():
        log.warning("OCSF dir %s missing; using built-in OCSF path allow-list", base)
        return dict(BUILTIN_PATHS), "builtin"
    candidates = [p for p in sorted(base.iterdir())
                  if p.suffix in (".yaml", ".yml", ".json") and p.name != "enums.yaml"]
    for path in candidates:
        try:
            raw = (json.loads(path.read_text(encoding="utf-8")) if path.suffix == ".json"
                   else yaml.safe_load(path.read_text(encoding="utf-8")))
        except Exception as exc:
            log.warning("cannot parse %s (%s); skipping", path.name, type(exc).__name__)
            continue
        parsed = _coerce(raw)
        if parsed:
            log.info("OCSF allow-list loaded from %s (%d classes)", path.name, len(parsed))
            return parsed, path.name
    log.warning("no usable OCSF path list in %s; using built-in allow-list", base)
    return dict(BUILTIN_PATHS), "builtin"


def _coerce(raw: Any) -> dict[int, list[str]]:
    """Accept several plausible shapes so we work with whatever backend/ocsf/ lands as."""
    if not isinstance(raw, dict):
        return {}
    for key in ("paths", "allowed_paths", "classes", "ocsf_paths"):
        if key in raw and isinstance(raw[key], dict):
            raw = raw[key]
            break
    out: dict[int, list[str]] = {}
    for k, v in raw.items():
        try:
            cls = int(str(k).strip())
        except ValueError:
            continue
        paths: list[str] = []
        if isinstance(v, list):
            paths = [str(x) for x in v if isinstance(x, (str, int))]
        elif isinstance(v, dict):
            for sub in ("paths", "attributes", "fields", "allowed_paths"):
                if isinstance(v.get(sub), list):
                    paths = [str(x) for x in v[sub]]
                    break
                if isinstance(v.get(sub), dict):
                    paths = [str(x) for x in v[sub]]
                    break
        if paths:
            out[cls] = sorted(set(paths))
    return out


def allow_list(class_uid: int | None = None) -> dict[int, list[str]] | list[str]:
    table, _ = _load_from_disk(str(ocsf_dir()))
    if class_uid is None:
        return table
    return table.get(int(class_uid), [])


def allow_list_source() -> str:
    return _load_from_disk(str(ocsf_dir()))[1]


def supported_classes() -> list[int]:
    return sorted(allow_list().keys())


# ---- response schema -------------------------------------------------

def build_schema(slot_names: list[str], class_uids: list[int] | None = None) -> dict[str, Any]:
    """Strict JSON Schema for the AI mapping proposal. Paths are an enumerated allow-list."""
    table = allow_list()
    classes = class_uids or supported_classes()
    paths: list[str] = sorted({p for c in classes for p in table.get(c, [])})
    slots = slot_names or ["_none_"]
    return {
        "type": "object",
        "properties": {
            # string enums keep the schema portable: Gemini allows `enum` on STRING only.
            "class_uid": {"type": "string", "enum": [str(c) for c in classes],
                          "description": "OCSF class_uid"},
            "activity_id": {"type": "integer", "minimum": 0, "maximum": 99},
            "mappings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "slot": {"type": "string", "enum": slots},
                        "ocsf_path": {"type": "string", "enum": paths},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "rationale": {"type": "string"},
                    },
                    "required": ["slot", "ocsf_path", "confidence"],
                    "additionalProperties": False,
                },
            },
            "enum_mappings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "slot": {"type": "string", "enum": slots},
                        "value": {"type": "string"},
                        "ocsf_enum_id": {"type": "integer"},
                    },
                    "required": ["slot", "value", "ocsf_enum_id"],
                    "additionalProperties": False,
                },
            },
            "slot_splits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "slot": {"type": "string", "enum": slots},
                        "reason": {"type": "string"},
                    },
                    "required": ["slot", "reason"],
                    "additionalProperties": False,
                },
            },
            "notes": {"type": "string"},
        },
        "required": ["class_uid", "activity_id", "mappings"],
        "additionalProperties": False,
    }


def validate(obj: Any, schema: dict[str, Any]) -> list[str]:
    """Schema errors plus the allow-list cross-check for the class actually chosen."""
    if not isinstance(obj, dict):
        return ["response is not a JSON object"]
    validator = Draft202012Validator(schema)
    errors = [f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}"
              for e in sorted(validator.iter_errors(obj), key=lambda e: list(e.path))]
    if errors:
        return errors[:10]
    try:
        cls = int(obj["class_uid"])
    except (KeyError, TypeError, ValueError):
        return ["class_uid is not an integer"]
    allowed = set(allow_list(cls))
    for m in obj.get("mappings", []):
        if m.get("ocsf_path") not in allowed:
            errors.append(
                f"ocsf_path {m.get('ocsf_path')!r} is not in the allow-list for class {cls}"
            )
    return errors[:10]


# ---- provider-specific schema dialects -------------------------------

_GEMINI_KEYS = {"type", "format", "description", "nullable", "enum", "items",
                "properties", "required", "propertyOrdering", "minimum", "maximum"}


def to_gemini_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Gemini responseSchema is an OpenAPI subset: upper-case types, no additionalProperties."""
    out: dict[str, Any] = {}
    for k, v in schema.items():
        if k not in _GEMINI_KEYS:
            continue
        if k == "type":
            out["type"] = str(v).upper()
        elif k == "properties":
            out["properties"] = {pk: to_gemini_schema(pv) for pk, pv in v.items()}
            out.setdefault("propertyOrdering", list(v.keys()))
        elif k == "items":
            out["items"] = to_gemini_schema(v)
        else:
            out[k] = v
    if out.get("type") == "INTEGER":
        # Gemini rejects numeric bounds on some paths; keep the type only.
        out.pop("minimum", None)
        out.pop("maximum", None)
    if out.get("type") == "NUMBER":
        out.pop("minimum", None)
        out.pop("maximum", None)
    return out


def coerce_result(obj: dict[str, Any]) -> dict[str, Any]:
    """class_uid travels as a string (portable enum); normalise it back to int."""
    out = dict(obj)
    if isinstance(out.get("class_uid"), str) and out["class_uid"].isdigit():
        out["class_uid"] = int(out["class_uid"])
    return out
