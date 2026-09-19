"""Minimal role gate for the Studio API (spec §14: viewer / onboarder / approver).

This package has no session/SSO layer of its own; the caller states its role and identity via
`X-Aletheia-Role` / `X-Aletheia-Actor` headers. A real deployment puts real authentication
(SSO / JWT / mTLS) in front of this and sets these headers from a verified identity — this is a
placeholder for that boundary, not a claim that header-based trust is sufficient on its own.

The one rule this module exists to enforce structurally: approval is a distinct, human-invoked
action gated on role=="approver". No AI code path ever calls it (spec §8.12.4/§14: AI can never
approve).
"""

from __future__ import annotations

from fastapi import Header, HTTPException

ROLES = ("viewer", "onboarder", "approver")


def current_actor(x_aletheia_actor: str = Header(default="unknown", alias="X-Aletheia-Actor")
                  ) -> str:
    return (x_aletheia_actor or "unknown").strip() or "unknown"


def require_role(*allowed: str):
    """FastAPI dependency factory: 403 unless the caller's role is one of `allowed`."""

    def _dep(x_aletheia_role: str = Header(default="viewer", alias="X-Aletheia-Role")) -> str:
        role = (x_aletheia_role or "viewer").strip().lower()
        if role not in ROLES:
            raise HTTPException(422, f"unknown role {role!r}; must be one of {ROLES}")
        if role not in allowed:
            raise HTTPException(403, f"role {role!r} may not perform this action "
                                     f"(requires one of {allowed})")
        return role

    return _dep
