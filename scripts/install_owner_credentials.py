#!/usr/bin/env python3
"""Owner-run, one-time credential installation; never echo input or details."""
import base64
import json
import os
import pwd
import re
import stat
import sys


def install(directory, uid, gid, payload):
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
    info = os.stat(directory, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077:
        raise ValueError("Unsafe credential directory")
    if not isinstance(payload, dict) or set(payload) != {"private_key_b64", "project_token"}:
        raise ValueError("Invalid input")
    pem = base64.b64decode(payload["private_key_b64"], validate=True)
    token = payload["project_token"]
    if (not isinstance(token, str) or not 10 <= len(token) <= 4096 or re.search(r"[\s\x00-\x1f\x7f]", token)
            or not isinstance(load_pem_private_key(pem, password=None), RSAPrivateKey)):
        raise ValueError("Invalid input")
    paths = [(os.path.join(directory, "app.pem"), pem), (os.path.join(directory, "project-token"), token.encode("utf-8"))]
    if any(os.path.lexists(path) for path, _ in paths):
        raise FileExistsError("Credential slot occupied")
    for path, value in paths:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.fchown(fd, uid, gid)
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(value)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(fd)
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def main():
    try:
        if os.geteuid() != 0:
            raise ValueError("Root required for installation")
        account = pwd.getpwnam("agent-flow")
        raw = sys.stdin.buffer.read(131073)
        if len(raw) > 131072:
            raise ValueError("Input too large")
        install("/etc/agent-github-flow-mvp", account.pw_uid, account.pw_gid, json.loads(raw))
        print("Credentials installed.")
    except Exception:
        raise SystemExit("Installation failed or is uncertain; do not retry automatically.") from None


if __name__ == "__main__":
    main()
