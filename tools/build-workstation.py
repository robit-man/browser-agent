"""Update the standalone HTML from the readable workstation sources."""
import argparse
import base64
import gzip
import html as html_tools
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
KERNEL = "/assets/unkernel-B_9V5QvS.wasm"
KERNEL_URL = "https://cdn.jsdelivr.net/npm/unkernel@0.2.0-261121-e69adda/dist/unkernel.wasm"
KERNEL_SHA256 = "ea45c857c59259d3cb53d5e3801021adc68449d1190e80ca3e1a632764d8177b"
UI_START = "<!-- workstation UI start -->"
UI_END = "<!-- workstation UI end -->"
CODE_START = "// workstation source start"
CODE_END = "// workstation source end"
ORIGINAL_UI = '  <div class="frame"><div id="terminal"></div><div id="boot">booting...</div><output id="transfer" role="status"></output></div>'
ORIGINAL_ENTRY = "try { await import(await makeModule(entry)); }"
DATA = re.compile(r'(<script id="browser-agent-data" type="application/json">)(.*?)(</script>)')
LOADER = """async function kernelModule(module) {
  const integrity = 'sha256-' + Uint8Array.fromHex('%s').toBase64();
  if (module.key) {
    const stream = new Blob([bytes(module.key)]).stream().pipeThrough(new DecompressionStream('gzip'));
    const data = await new Response(stream).arrayBuffer();
    if (await digest(new Blob([data])) !== '%s') throw Error('Embedded Linux runtime failed verification');
    return URL.createObjectURL(new Blob([data], { type: 'application/wasm' }));
  }
  let cache;
  try { cache = await globalThis.caches?.open('pointblank-linux-runtime-v1'); } catch {}
  let response = await cache?.match(module.url).catch(() => undefined);
  if (!response) {
    response = await fetch(module.url, { integrity });
    if (!response.ok) throw Error('Linux runtime download failed (HTTP ' + response.status + ')');
    if (cache) await cache.put(module.url, response.clone()).catch(() => {});
  }
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/wasm' }));
}
""" % (KERNEL_SHA256, KERNEL_SHA256)


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise SystemExit("Expected exactly one build marker: " + old[:80])
    return source.replace(old, new, 1)


def replace_section(source, start, end, contents, original):
    if start not in source:
        return replace_once(source, original, start + "\n" + contents + "\n" + end)
    first = source.index(start) + len(start)
    last = source.index(end, first)
    return source[:first] + "\n" + contents + "\n" + source[last:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "index.html")
    parser.add_argument("--offline", action="store_true", help="Embed the pinned Linux kernel for disconnected use")
    parser.add_argument("--kernel", type=Path, help="Use a local copy of the pinned kernel instead of downloading it")
    parser.add_argument("--gateway", help="Set the HTTPS egress URL for a staging artifact")
    parser.add_argument("--split-assets", type=Path, help="Write the two Worker asset fragments")
    args = parser.parse_args()
    if args.gateway and (not args.gateway.startswith("https://") or args.output.resolve() == ROOT / "index.html"):
        parser.error("set --gateway only on a separate staging HTML with an HTTPS gateway")
    html = (ROOT / "index.html").read_text()
    ui = (ROOT / "workstation-ui.html").read_text().rstrip()
    code = "\n\n".join((ROOT / name).read_text().rstrip() for name in (
        "workstation-storage.mjs", "workstation-egress.mjs", "workstation.mjs"
    ))
    if "</script" in code.lower():
        raise SystemExit("Inline JavaScript contains a closing script tag")
    html = replace_section(html, UI_START, UI_END, ui, ORIGINAL_UI)
    html = replace_section(html, CODE_START, CODE_END, code + "\n\n" + LOADER.rstrip(), ORIGINAL_ENTRY)
    if "if (bootWorkstation) await import" not in html:
        html = replace_once(html, CODE_END + "\ncatch", CODE_END + "\ntry { if (bootWorkstation) await import(await makeModule(entry)); }\ncatch")
        html = replace_once(html, "  if (module.url) return module.url;",
                            f"  if (name === '{KERNEL}') return module.loading ??= kernelModule(module);\n  if (module.url) return module.url;")
        html = replace_once(html, "new Blob([source], { type: 'text/javascript' })",
                            "new Blob([name === entry ? workstation.adaptEntry(source) : source], { type: 'text/javascript' })")
        html = replace_once(html, "<title>Browser Agent</title>", "<title>Pointblank Linux</title>")
        html = replace_once(html, "Browser Agent could not start.", "Pointblank Linux could not start.")
    if args.offline or args.kernel:
        if args.kernel:
            kernel = args.kernel.read_bytes()
        else:
            with urllib.request.urlopen(KERNEL_URL, timeout=60) as response:
                kernel = response.read()
        if hashlib.sha256(kernel).hexdigest() != KERNEL_SHA256:
            raise SystemExit("The kernel must match the pinned SHA-256")
        match = DATA.search(html)
        data = json.loads(match[2])
        key = "workstation-offline-kernel"
        data["modules"][KERNEL]["key"] = key
        data["payloads"][key] = base64.b64encode(gzip.compress(kernel, mtime=0)).decode()
        html = html[:match.start(2)] + json.dumps(data, separators=(",", ":")) + html[match.end(2):]
    if args.gateway:
        tag = '<meta name="workstation-gateway" content="' + html_tools.escape(args.gateway.rstrip('/'), quote=True) + '">'
        html = replace_once(html, "  <title>Pointblank Linux</title>", "  " + tag + "\n  <title>Pointblank Linux</title>")
    args.output.write_text(html)
    if args.split_assets:
        assets = args.split_assets
        assets.mkdir(parents=True, exist_ok=True)
        data = html.encode()
        offset = len(data) // 2
        for index, part in enumerate((data[:offset], data[offset:]), 1):
            (assets / f"index-part-{index}.bin").write_bytes(part)


if __name__ == "__main__":
    main()
