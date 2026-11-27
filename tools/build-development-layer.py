"""Build a signed-package Alpine development layer against the embedded Python image."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PYTHON_IMAGE = "/oci/registry-1.docker.io_library_python_3.13-alpine/"
BUILD_IMAGE = "alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf"
PACKAGES = ("git", "git-init-template", "nodejs", "npm")
INSTALL = """
mkdir /target
for layer in /input/base-*.tar.gz; do
    tar -xzf "$layer" -C /target
done
tar -czf /input/before.tar.gz -C /target .
# Run the native apk solver for the guest architecture. Keep package names
# in the world file so normal apk upgrades inside Alpine remain available.
apk --root /target --arch aarch64 --no-scripts --no-cache add "$@"
apk --root /target list --installed git git-init-template nodejs npm
tar -czf /input/after.tar.gz -C /target .
"""


def copy_base_layers(directory):
    html = (ROOT / "index.html").read_text()
    data = json.loads(re.search(r'<script id="browser-agent-data" type="application/json">(.*?)</script>', html)[1])

    def payload(name):
        return base64.b64decode(data["payloads"][data["oci"][PYTHON_IMAGE + name]])

    metadata = json.loads(payload("meta.json"))
    for index, layer in enumerate(metadata["layers"]):
        (directory / f"base-{index:03d}.tar.gz").write_bytes(payload(layer["file"]))


def entries(archive):
    return {PurePosixPath(item.name).as_posix(): item for item in archive.getmembers() if item.name not in (".", "./")}


def signature(archive, item):
    digest = hashlib.file_digest(archive.extractfile(item), "sha256").digest() if item.isfile() else None
    return item.type, item.mode, item.uid, item.gid, item.linkname, digest


def write_layer(before_file, after_file, output):
    with tarfile.open(before_file) as before, tarfile.open(after_file) as after:
        base, installed = entries(before), entries(after)
        changed = {
            path for path, item in installed.items()
            if path not in base or signature(after, item) != signature(before, base[path])
        }
        # An extracted layer must contain its hard-link targets.
        for path in tuple(changed):
            item = installed[path]
            if item.islnk():
                changed.add(PurePosixPath(item.linkname).as_posix())
        deleted = base.keys() - installed.keys()
        with output.open("wb") as out, gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as layer:
                for name in sorted(deleted):
                    path = PurePosixPath(name)
                    if all(str(parent) not in deleted for parent in path.parents):
                        layer.addfile(tarfile.TarInfo(str(path.with_name(".wh." + path.name))))
                for path, item in installed.items():
                    if path in changed:
                        layer.addfile(item, after.extractfile(item) if item.isfile() else None)
        print(f"Development layer contains {len(changed)} new or modified entries ({output.stat().st_size:,} bytes)")
        with output.open("rb") as file:
            print("SHA-256 " + hashlib.file_digest(file, "sha256").hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Write the development layer as a gzip-compressed tar")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pointblank-dev-layer-") as temp:
        directory = Path(temp)
        copy_base_layers(directory)
        subprocess.run([
            "docker", "run", "--rm", "--runtime", "runc",
            "--mount", f"type=bind,src={directory},dst=/input", BUILD_IMAGE,
            "sh", "-ec", INSTALL, "sh", *PACKAGES,
        ], check=True)
        write_layer(directory / "before.tar.gz", directory / "after.tar.gz", args.output)


if __name__ == "__main__":
    main()
