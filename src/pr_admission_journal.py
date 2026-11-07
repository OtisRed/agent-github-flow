"""Durable one-attempt marker for a PR merge with an uncertain response."""

import json
import os
import stat
from pathlib import Path

from pr_admission import SHA


class MergeJournal:
    def __init__(self, directory, repository_id):
        if type(repository_id) is not int or repository_id <= 0:
            raise ValueError("Invalid repository identity")
        self.directory = Path(directory)
        self.repository_id = repository_id

    def _path(self, number):
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid PR number")
        return self.directory / f"admission-merge-{self.repository_id}-{number}.json"

    def begin(self, number, sha):
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError("Invalid merge head")
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "geteuid"):
            raise RuntimeError("Private POSIX state directory required")
        info = os.stat(self.directory, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Unsafe state directory")
        path = self._path(number)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(json.dumps({"pr": number, "head": sha}, separators=(",", ":")).encode("ascii"))
                output.flush()
                os.fsync(output.fileno())
            parent = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            os.close(fd)

    def confirm_merged(self, number):
        """Caller must have freshly confirmed the PR was merged on GitHub."""
        path = self._path(number)
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Unsafe merge marker")
        os.unlink(path)
        parent = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
