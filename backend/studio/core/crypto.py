"""AES-GCM sealing for settings values. Key via HKDF-SHA256 from ALETHEIA_SECRET (CONTRACTS §9)."""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_INFO = b"aletheia-studio-settings-v1"
_SALT = b"aletheia-settings"
_NONCE_LEN = 12


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
