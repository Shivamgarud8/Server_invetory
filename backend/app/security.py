"""Password hashing, session tokens, TOTP and credential-secret storage."""

import base64
import hashlib
import os
import secrets
import string

import httpx
import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import get_settings

_ph = PasswordHasher()  # argon2id with library defaults

# Hash used to keep login timing constant when the username does not exist
_DUMMY_HASH = _ph.hash(secrets.token_urlsafe(16))


# ---------------------------------------------------------------- user passwords


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _ph.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_policy_errors(password: str) -> list[str]:
    errors = []
    if len(password) < 12:
        errors.append("at least 12 characters")
    if not any(c.islower() for c in password):
        errors.append("a lowercase letter")
    if not any(c.isupper() for c in password):
        errors.append("an uppercase letter")
    if not any(c.isdigit() for c in password):
        errors.append("a number")
    if not any(c in string.punctuation for c in password):
        errors.append("a symbol")
    return errors


# ---------------------------------------------------------------- sessions


def new_session_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- symmetric encryption helpers


def _aesgcm_encrypt(key: bytes, plaintext: str, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return b"v1" + nonce + AESGCM(key).encrypt(nonce, plaintext.encode(), aad)


def _aesgcm_decrypt(key: bytes, blob: bytes, aad: bytes) -> str:
    if blob[:2] != b"v1":
        raise ValueError("Unknown ciphertext version")
    return AESGCM(key).decrypt(blob[2:14], blob[14:], aad).decode()


def _derived_key(purpose: bytes) -> bytes:
    """Key derived from APP_SECRET_KEY — used for non-credential secrets such as TOTP seeds."""
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=purpose).derive(
        get_settings().app_secret_key.encode()
    )


# ---------------------------------------------------------------- TOTP (2FA)


def new_totp_secret() -> str:
    return pyotp.random_base32()


def encrypt_totp_secret(user_id: int, secret: str) -> bytes:
    return _aesgcm_encrypt(_derived_key(b"totp"), secret, f"totp:{user_id}".encode())


def decrypt_totp_secret(user_id: int, blob: bytes) -> str:
    return _aesgcm_decrypt(_derived_key(b"totp"), blob, f"totp:{user_id}".encode())


def verify_totp(secret: str, code: str) -> bool:
    code = (code or "").strip().replace(" ", "")
    return code.isdigit() and pyotp.TOTP(secret).verify(code, valid_window=1)


def totp_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=get_settings().app_name)


# ---------------------------------------------------------------- credential vault


class VaultError(RuntimeError):
    pass


class LocalVault:
    """AES-256-GCM; key comes from CREDENTIAL_ENCRYPTION_KEY and never touches the database."""

    name = "local"

    def __init__(self, key_b64: str | None):
        if not key_b64 or key_b64.startswith("REPLACE_"):
            raise VaultError("CREDENTIAL_ENCRYPTION_KEY is required when VAULT_PROVIDER=local")
        key = base64.b64decode(key_b64)
        if len(key) != 32:
            raise VaultError("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes, base64-encoded")
        self._key = key

    def store(self, credential_id: int, secret: str) -> bytes | None:
        return _aesgcm_encrypt(self._key, secret, f"credential:{credential_id}".encode())

    def read(self, credential_id: int, blob: bytes | None) -> str:
        if blob is None:
            raise VaultError("No secret stored")
        return _aesgcm_decrypt(self._key, blob, f"credential:{credential_id}".encode())

    def delete(self, credential_id: int) -> None:
        pass

    def health(self) -> bool:
        return True


class HashiCorpVault:
    """HashiCorp Vault KV v2. The database stores nothing secret; Vault keeps version history."""

    name = "hashicorp"

    def __init__(self, s):
        if not s.vault_addr or not s.vault_token or s.vault_token.startswith("REPLACE_"):
            raise VaultError("VAULT_ADDR and VAULT_TOKEN are required when VAULT_PROVIDER=hashicorp")
        headers = {"X-Vault-Token": s.vault_token}
        if s.vault_namespace:
            headers["X-Vault-Namespace"] = s.vault_namespace
        self._client = httpx.Client(
            base_url=s.vault_addr.rstrip("/"), headers=headers, timeout=10, verify=s.vault_ca_cert or True
        )
        self._mount = s.vault_mount.strip("/")
        self._prefix = s.vault_path_prefix.strip("/")

    def _path(self, kind: str, credential_id: int) -> str:
        return f"/v1/{self._mount}/{kind}/{self._prefix}/credentials/{credential_id}"

    def store(self, credential_id: int, secret: str) -> bytes | None:
        r = self._client.post(self._path("data", credential_id), json={"data": {"password": secret}})
        if r.status_code >= 300:
            raise VaultError(f"Vault write failed ({r.status_code})")
        return None

    def read(self, credential_id: int, blob: bytes | None) -> str:
        r = self._client.get(self._path("data", credential_id))
        if r.status_code != 200:
            raise VaultError(f"Vault read failed ({r.status_code})")
        return r.json()["data"]["data"]["password"]

    def delete(self, credential_id: int) -> None:
        r = self._client.delete(self._path("metadata", credential_id))
        if r.status_code >= 300 and r.status_code != 404:
            raise VaultError(f"Vault delete failed ({r.status_code})")

    def health(self) -> bool:
        try:
            return self._client.get("/v1/sys/health").status_code in (200, 429, 472, 473)
        except httpx.HTTPError:
            return False


_vault = None


def get_vault():
    global _vault
    if _vault is None:
        s = get_settings()
        _vault = LocalVault(s.credential_encryption_key) if s.vault_provider == "local" else HashiCorpVault(s)
    return _vault
