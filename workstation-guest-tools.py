"""Browser workspace file operations and loopback HTTP reads."""
from contextlib import contextmanager
from http.client import HTTPConnection
import json
import os
import stat
import sys
from zipfile import ZIP_DEFLATED, ZipFile


MIB = 1024 * 1024
DOWNLOAD_LIMIT = 128 * MIB
PREVIEW_LIMIT = 8 * MIB
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
INPUT_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def usable_name(name):
    return (isinstance(name, str) and name not in ("", ".", "..")
            and not any(c in "/\\" or ord(c) < 32 or ord(c) == 127 for c in name))


def validate_parts(parts):
    if (not isinstance(parts, list) or len(parts) > 80
            or not all(usable_name(part) for part in parts)
            or sum(len(part) for part in parts) > 4096):
        raise ValueError("Invalid workspace path")


@contextmanager
def workspace_directory(parts):
    directory = os.open("/workspace", DIRECTORY)
    try:
        for name in parts:
            child = os.open(name, DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory
    finally:
        os.close(directory)


@contextmanager
def regular_file(directory, name):
    with os.fdopen(os.open(name, INPUT_FILE, dir_fd=directory), "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Select a regular file")
        yield source, info.st_size


def copy_with_limit(source, target, remaining):
    while data := source.read(64 * 1024):
        remaining -= len(data)
        if remaining < 0:
            raise ValueError("Download exceeds 128 MiB")
        target.write(data)
    return remaining


def list_directory(directory):
    entries = []
    with os.scandir(directory) as listing:
        for entry in listing:
            if len(entries) >= 1000:
                raise ValueError("The folder contains more than 1,000 entries")
            info = entry.stat(follow_symlinks=False)
            kind = ("folder" if stat.S_ISDIR(info.st_mode) else
                    "file" if stat.S_ISREG(info.st_mode) else
                    "link" if stat.S_ISLNK(info.st_mode) else "special")
            if not usable_name(entry.name):
                kind = "special"
            entries.append({"name": entry.name, "kind": kind, "size": info.st_size if kind == "file" else None})
    return entries


def archive_directory(directory, output):
    remaining = DOWNLOAD_LIMIT
    count = 0
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=5) as archive:
        def visit(parent, prefix, depth):
            nonlocal remaining, count
            if depth > 80:
                raise ValueError("The folder exceeds the export depth limit")
            with os.scandir(parent) as listing:
                for entry in listing:
                    count += 1
                    if count > 5000:
                        raise ValueError("The folder contains more than 5,000 entries")
                    if not usable_name(entry.name) or ":" in entry.name:
                        continue
                    # Some Linux filenames cannot be represented in UTF-8 ZIPs.
                    try:
                        entry.name.encode("utf-8")
                    except UnicodeEncodeError:
                        continue
                    path = prefix + entry.name
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(entry.name, DIRECTORY, dir_fd=parent)
                        try:
                            archive.mkdir(path)
                            visit(child, path + "/", depth + 1)
                        finally:
                            os.close(child)
                    elif stat.S_ISREG(info.st_mode):
                        with regular_file(parent, entry.name) as (source, size):
                            if size > remaining:
                                raise ValueError("Folder contents exceed 128 MiB")
                            with archive.open(path, "w") as target:
                                remaining = copy_with_limit(source, target, remaining)

        visit(directory, "", 0)


def preview_response(request, output):
    port, path = request["port"], request["path"]
    if (type(port) is not int or not 1 <= port <= 65535 or port == 18791
            or not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or len(path) > 8192 or not path.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in path)):
        raise ValueError("Invalid preview port or path")
    connection = HTTPConnection("127.0.0.1", port, timeout=6)
    try:
        connection.request("GET", path, headers={"Accept-Encoding": "identity", "Connection": "close"})
        response = connection.getresponse()
        kind = response.getheader("Content-Type", "application/octet-stream").split(";", 1)[0].strip().lower()
        location = response.getheader("Location", "") if 300 <= response.status < 400 else ""
        if len(kind) > 100 or len(location) > 2048:
            raise ValueError("Invalid preview response headers")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise ValueError("The server returned an unsupported content encoding")
        if not 300 <= response.status < 400 and response.length is not None and response.length > PREVIEW_LIMIT:
            raise ValueError("Preview response exceeds 8 MiB")
        header = {"status": response.status, "type": kind, "location": location}
        output.write(json.dumps(header, separators=(",", ":")).encode() + b"\n")
        if 300 <= response.status < 400:
            return
        remaining = PREVIEW_LIMIT
        while data := response.read(64 * 1024):
            remaining -= len(data)
            if remaining < 0:
                raise ValueError("Preview response exceeds 8 MiB")
            output.write(data)
    finally:
        connection.close()


def main():
    action, raw = sys.argv[1:]
    request = json.loads(raw)
    output = sys.stdout.buffer
    if action == "preview":
        preview_response(request, output)
        return
    validate_parts(request)
    if action == "file" and request:
        with workspace_directory(request[:-1]) as directory, regular_file(directory, request[-1]) as (source, size):
            if size > DOWNLOAD_LIMIT:
                raise ValueError("File exceeds 128 MiB")
            copy_with_limit(source, output, DOWNLOAD_LIMIT)
        return
    with workspace_directory(request) as directory:
        if action == "list":
            output.write(json.dumps(list_directory(directory), separators=(",", ":")).encode())
        elif action == "zip":
            archive_directory(directory, output)
        else:
            raise ValueError("Unknown workspace operation")


if __name__ == "__main__":
    try:
        main()
    except ConnectionRefusedError:
        sys.exit("No HTTP server is listening on that guest port")
    except TimeoutError:
        sys.exit("The guest HTTP server did not respond in time")
    except (OSError, ValueError) as error:
        sys.exit(str(error))
