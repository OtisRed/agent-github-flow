import base64
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from mvp_credentials import AppToken, read_private_file


@unittest.skipUnless(importlib.util.find_spec("cryptography"), "cryptography is unavailable")
class AppTokenTests(unittest.TestCase):
    def test_pr_handoff_token_is_limited_to_repository_and_needed_permissions(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        expected = {"issues": "write", "pull_requests": "read"}
        now = 1_800_000_000
        def transport(path, jwt, *, body=None):
            self.assertEqual(body, {"repository_ids": [20], "permissions": expected})
            return {"token": "synthetic-token", "expires_at": datetime.fromtimestamp(now + 3600, timezone.utc).isoformat(),
                    "permissions": dict(expected, metadata="read"), "repositories": [{"id": 20}]}, None
        self.assertEqual(AppToken(9, 10, 20, pem, transport=transport, clock=lambda: now, purpose="pr_handoff")(),
                         "synthetic-token")

    def test_admission_token_is_limited_to_one_repository_and_declared_permissions(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        expected = {'issues': 'read', 'contents': 'write', 'pull_requests': 'write', 'checks': 'write',
                    'actions': 'write', 'administration': 'read'}
        now = 1_800_000_000
        def transport(_path, _jwt, *, body=None):
            self.assertEqual(body, {'repository_ids': [20], 'permissions': expected})
            expiry = datetime.fromtimestamp(now + 3600, timezone.utc).isoformat()
            return {'token': 'synthetic-token', 'expires_at': expiry,
                    'permissions': dict(expected, metadata='read'), 'repositories': [{'id': 20}]}, None
        provider = AppToken(9, 10, 20, pem, transport=transport, clock=lambda: now, purpose='admission')
        self.assertEqual(provider(), 'synthetic-token')

    def test_promotion_token_is_repo_scoped_and_rejects_extra_permissions(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        permissions = {'issues': 'read', 'contents': 'write', 'pull_requests': 'write', 'administration': 'read'}
        now = 1_800_000_000
        def transport(path, jwt, *, body=None):
            self.assertEqual(body, {'repository_ids': [20], 'permissions': permissions})
            expiry = datetime.fromtimestamp(now + 3600, timezone.utc).isoformat()
            return {'token': 'synthetic-token', 'expires_at': expiry,
                    'permissions': dict(permissions, metadata='read', secrets='read')}, None
        provider = AppToken(9, 10, 20, pem, transport=transport, clock=lambda: now, purpose='promotion')
        with self.assertRaises(ValueError):
            provider()

    def test_token_request_is_scoped_and_reused_until_near_expiry(self):
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        now = [1_800_000_000]
        calls = []
        def transport(path, jwt, *, body=None):
            calls.append((path, body))
            header, payload, signature = jwt.split(".")
            unpad = lambda value: base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
            key.public_key().verify(unpad(signature), (header + "." + payload).encode(), padding.PKCS1v15(), hashes.SHA256())
            claims = json.loads(unpad(payload))
            self.assertEqual(claims["iss"], "9")
            expiry = datetime.fromtimestamp(now[0] + 3600, timezone.utc).isoformat()
            return {"token": "synthetic-token", "expires_at": expiry, "permissions": {"issues": "read"}}, None
        provider = AppToken(9, 10, 20, pem, transport=transport, clock=lambda: now[0])
        self.assertEqual(provider(), "synthetic-token")
        self.assertEqual(provider(), "synthetic-token")
        self.assertEqual(calls, [("/app/installations/10/access_tokens", {"repository_ids": [20], "permissions": {"issues": "read"}})])
        now[0] += 3500
        self.assertEqual(provider(), "synthetic-token")
        self.assertEqual(len(calls), 2)


@unittest.skipUnless(os.name == "posix", "Credential permissions require POSIX")
class PrivateFileTests(unittest.TestCase):
    def test_private_file_refuses_world_access_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secret"
            path.write_bytes(b"synthetic-only")
            path.chmod(0o600)
            self.assertEqual(read_private_file(path), b"synthetic-only")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                read_private_file(path)
            alias = Path(directory) / "alias"
            alias.symlink_to(path)
            with self.assertRaises(OSError):
                read_private_file(alias)
