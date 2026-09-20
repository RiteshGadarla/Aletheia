"""AES-GCM sealing for settings values. Key via HKDF-SHA256 from ALETHEIA_SECRET (CONTRACTS §9)."""

from __future__ import annotations

import base64
import logging
import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_INFO = b"aletheia-studio-settings-v1"
_SALT = b"aletheia-settings"
_NONCE_LEN = 12

log = logging.getLogger("studio.crypto")


class SecretUnavailable(RuntimeError):
    """ALETHEIA_SECRET is not configured, so encrypted settings cannot be used."""


def _secret() -> str:
    s = os.environ.get("ALETHEIA_SECRET", "")
    if not s:
        raise SecretUnavailable("ALETHEIA_SECRET is not set; cannot seal/open encrypted settings")
    return s


def derive_key(secret: str | None = None) -> bytes:
    """HKDF-SHA256(ALETHEIA_SECRET) -> 32-byte AES-GCM key."""
    raw = (secret if secret is not None else _secret()).encode("utf-8")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=_SALT, info=_INFO).derive(raw)


def seal(plaintext: str, secret: str | None = None) -> str:
    """Return base64(nonce || ciphertext). Never log the result or its input."""
    key = derive_key(secret)
    nonce = os.urandom(_NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None)
    return base64.b64encode(nonce + ct).decode("ascii")


def open_sealed(blob: str, secret: str | None = None) -> str:
    key = derive_key(secret)
    raw = base64.b64decode(blob.encode("ascii"))
    if len(raw) <= _NONCE_LEN:
        raise ValueError("sealed value too short")
    return AESGCM(key).decrypt(raw[:_NONCE_LEN], raw[_NONCE_LEN:], None).decode("utf-8")


def last4(value: str) -> str:
    """The only form of a key the API may ever return."""
    return value[-4:] if len(value) >= 4 else "*" * len(value)


# Where a generated development secret is kept. Under deploy/secrets/, which
# .gitignore excludes wholesale, so it can never be committed by accident.
_LOCAL_SECRET = Path(__file__).resolve().parents[3] / "deploy" / "secrets" / ".studio_secret"


def resolve_secret(env_value: str | None = None) -> str | None:
    """The sealing secret: ALETHEIA_SECRET if set, else a persisted local one.

    The container always passes ALETHEIA_SECRET, so this changes nothing there. It exists for
    `make dev`, where the variable is commented out of the secrets example and saving an API key
    from the Settings page therefore died with SecretUnavailable — a 500 on the one flow the
    product promises works without the user configuring anything.

    The secret is generated once and written to disk rather than held in memory, because an
    ephemeral key would seal the stored API key with a value that vanishes at restart: the key
    would survive in the database but could never be opened again. Failing loudly beats that.
    """
    env_value = env_value if env_value is not None else os.environ.get("ALETHEIA_SECRET", "")
    if env_value:
        return env_value
    try:
        if _LOCAL_SECRET.is_file():
            existing = _LOCAL_SECRET.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        _LOCAL_SECRET.parent.mkdir(parents=True, exist_ok=True)
        generated = secrets.token_urlsafe(32)
        # Create 0600 before writing, so the secret is never briefly world-readable.
        fd = os.open(_LOCAL_SECRET, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(generated + "\n")
        log.info("generated a local settings secret at %s (set ALETHEIA_SECRET to override)",
                 _LOCAL_SECRET)
        return generated
    except OSError as exc:
        # Read-only filesystem and no ALETHEIA_SECRET: let the caller raise
        # SecretUnavailable rather than invent a key that cannot be recovered.
        log.warning("cannot persist a local settings secret (%s); "
                    "set ALETHEIA_SECRET to store an API key", type(exc).__name__)
        return None
