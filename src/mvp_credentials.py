"""Restricted local secret loading and short-lived GitHub App read tokens."""
import base64
import json
import os
import re
import stat
import time
from datetime import datetime

from mvp_github import request


def read_private_file(path):
    """Read a service-owned mode-0600 regular file without following symlinks."""
    if not hasattr(os, "geteuid") or not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("Private credential files require a POSIX service host")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Unsafe credential file")
        with os.fdopen(fd, "rb", closefd=False) as file:
            data = file.read(65537)
        if not data or len(data) > 65536:
            raise ValueError("Invalid credential file")
        return data
    finally:
        os.close(fd)


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class AppToken:
    """Issue a short-lived, repository-scoped installation token in memory."""

    def __init__(self, app_id, installation_id, repository_id, private_key_pem, *, transport=request, clock=time.time,
                 purpose="status"):
        if any(type(value) is not int or value <= 0 for value in (app_id, installation_id, repository_id)):
            raise ValueError("Invalid App configuration")
        if not isinstance(private_key_pem, bytes) or not callable(transport):
            raise ValueError("Invalid App configuration")
        # cryptography is the only non-stdlib runtime dependency and is already
        # installed on the target host; it never logs key material.
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
        try:
            self._key = load_pem_private_key(private_key_pem, password=None)
        except (ValueError, TypeError) as exc:
            raise ValueError("Invalid App key") from None
        if not isinstance(self._key, RSAPrivateKey):
            raise ValueError("Invalid App key")
        permissions = {"status": {"issues": "read"},
                       "dependabot": {"issues": "write", "pull_requests": "write"},
                       "pr_handoff": {"issues": "write", "pull_requests": "read"},
                       "admission": {"issues": "read", "contents": "write", "pull_requests": "write",
                                     "checks": "write", "actions": "write", "administration": "read"},
                       "promotion": {"issues": "read", "contents": "write",
                                     "pull_requests": "write", "administration": "read"}}
        if purpose not in permissions:
            raise ValueError("Invalid App token purpose")
        self.permissions = permissions[purpose]
        self.app_id, self.installation_id, self.repository_id = app_id, installation_id, repository_id
        self.transport, self.clock = transport, clock
        self._cached, self._expires = None, 0

    def __call__(self):
        now = int(self.clock())
        if self._cached is not None and now < self._expires - 120:
            return self._cached
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        header = _b64(b'{"alg":"RS256","typ":"JWT"}')
        payload = _b64(json.dumps({"iat": now - 60, "exp": now + 540, "iss": str(self.app_id)},
                                  separators=(",", ":")).encode())
        message = (header + "." + payload).encode("ascii")
        jwt = message.decode("ascii") + "." + _b64(self._key.sign(message, padding.PKCS1v15(), hashes.SHA256()))
        response, _ = self.transport(f"/app/installations/{self.installation_id}/access_tokens", jwt,
            body={"repository_ids": [self.repository_id], "permissions": self.permissions})
        if not isinstance(response, dict):
            raise ValueError("Invalid App token response")
        token, expiry, permissions = response.get("token"), response.get("expires_at"), response.get("permissions")
        if not isinstance(token, str) or not token or re.search(r"[\s\x00-\x1f\x7f]", token):
            raise ValueError("Invalid App token response")
        if (not isinstance(permissions, dict)
                or any(permissions.get(name) != access for name, access in self.permissions.items())
                or any((name not in self.permissions and (name != "metadata" or access != "read"))
                       for name, access in permissions.items())):
            raise ValueError("Unexpected App token permissions")
        repositories = response.get("repositories")
        if repositories is not None and (not isinstance(repositories, list) or len(repositories) != 1
                or not isinstance(repositories[0], dict) or repositories[0].get("id") != self.repository_id):
            raise ValueError("Unexpected App token repositories")
        try:
            expires = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
            if expires.tzinfo is None or expires.timestamp() <= now + 120:
                raise ValueError("Invalid expiry")
        except (AttributeError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("Invalid App token expiry") from None
        self._cached, self._expires = token, expires.timestamp()
        return token
