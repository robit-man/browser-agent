# TTY client assets

From `index.html` at [robit-man/tty d11a699](https://github.com/robit-man/tty/blob/d11a699f2bf573725387ecb5fb08496cf37f1f8d/index.html). The build embeds these files directly in the standalone HTML.

| File | Source | SHA-256 |
| --- | --- | --- |
| `qr.js` | Script `roomQrEncoder` | `337f9ca12d46a1f06bbd950b4caa5a2a1fe2c92e333a16e952621a9a50353ee8` |
| `vendor.js` | Script `tty-share-vendor` | `5a5688b9772ca31bb7ca862a7ad7292e2e40cccca74ae35480a9d9fa3091fec8` |
| `transport.js` | Script `tty-share-transport` | `7b0a589b8b3ba7fb26ab230482fc963c90a7404b78f63a90aae7a74d19fbb708` |

Extract script contents with one trailing newline and leading and trailing whitespace trimmed. `xterm-notice.js` carries the xterm license notice from the same source. It precedes the vendor bundle in the HTML.
