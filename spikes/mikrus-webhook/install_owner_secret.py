#!/usr/bin/env python3
"""Owner-run one-time secret installation. Never writes its input to output."""
import os
import re
import stat
import sys

directory = "/etc/agent-github-flow-spike-71"
path = directory + "/webhook-secret"
try:
    info = os.stat(directory)
    if os.geteuid() != 0 or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError("unsafe directory")
    secret = sys.stdin.buffer.read(1024)
    if re.fullmatch(rb"[A-Za-z0-9_-]{43}", secret) is None:
        raise ValueError("invalid input")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(secret)
            output.flush()
            os.fsync(output.fileno())
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    except BaseException:
        # A partially installed secret requires deliberate operator recovery;
        # never silently replace or retry it.
        raise
    print("Secret installed.")
except (OSError, ValueError):
    sys.exit("Secret installation failed or could not be confirmed; do not retry automatically.")
