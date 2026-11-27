"""Make the sparse ext4 template used for browser-backed Alpine workspaces."""
import argparse
import errno
import gzip
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile

BLOCK = 4096
SIZE = 1 << 40   # 1 TiB virtual ext4 disk, with browser blocks allocated on demand.
DEFAULT_BYTES = 420 * 1024 * 1024


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout


def free_blocks(image):
    return int(re.search(r"^Free blocks:\s+(\d+)$", run("dumpe2fs", "-h", image), re.M)[1])


def sparse_blocks(image):
    with image.open("rb") as file:
        offset = 0
        while offset < SIZE:
            try:
                start = os.lseek(file.fileno(), offset, os.SEEK_DATA)
            except OSError as error:
                if error.errno == errno.ENXIO:
                    break
                raise
            end = os.lseek(file.fileno(), start, os.SEEK_HOLE)
            offset = start // BLOCK * BLOCK
            file.seek(offset)
            while offset < end:
                data = file.read(BLOCK)
                if data.strip(b"\0"):
                    yield offset // BLOCK, data
                offset += BLOCK
            offset = end


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="pointblank-disk-template-") as directory:
        image = Path(directory) / "workspace.img"
        with image.open("wb") as file:
            file.truncate(SIZE)
        run("mke2fs", "-t", "ext4", "-b", str(BLOCK), "-N", str(1 << 20),
            "-m", "0", "-F", "-L", "pointblank-live", "-O", "^has_journal", "-E", "lazy_itable_init=1", image)
        reserve = free_blocks(image) - DEFAULT_BYTES // BLOCK
        run("debugfs", "-w", "-R", "write /dev/null /.pointblank-reserve", image)
        run("debugfs", "-w", "-R", f"fallocate /.pointblank-reserve 0 {reserve - 1}", image)
        if not 400 * 1024 * 1024 <= free_blocks(image) * BLOCK <= DEFAULT_BYTES:
            raise SystemExit("The workspace reservation did not leave the intended space available")
        blocks = list(sparse_blocks(image))
        with args.output.open("wb") as out, gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0) as packed:
            packed.write(struct.pack("<8sQII", b"KWSPARS1", SIZE, BLOCK, len(blocks)))
            for index, _ in blocks:
                packed.write(struct.pack("<Q", index))
            for _, data in blocks:
                packed.write(data)
        print(f"{len(blocks):,} initialized blocks and {args.output.stat().st_size:,} compressed bytes")


if __name__ == "__main__":
    main()
