import base64
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


@unittest.skipUnless(os.name == "posix" and importlib.util.find_spec("cryptography"), "POSIX and cryptography required")
class InstallationTests(unittest.TestCase):
    def test_install_is_private_and_never_overwrites_existing(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from install_owner_credentials import install
        with tempfile.TemporaryDirectory() as directory:
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            payload = {"private_key_b64": base64.b64encode(pem).decode(), "project_token": "synthetic-test-token"}
            install(directory, os.geteuid(), os.getegid(), payload)
            for name in ("app.pem", "project-token"):
                self.assertEqual(os.stat(Path(directory) / name).st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                install(directory, os.geteuid(), os.getegid(), payload)
            self.assertEqual((Path(directory) / "project-token").read_bytes(), b"synthetic-test-token")
