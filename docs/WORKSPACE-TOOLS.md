# Workspace files, previews, and tool packs

All three features open from the Workspace menu. The Linux runtime and filesystem stay in the browser. The build remains a standalone HTML file.

## Files

- Start at `/workspace`. Show each entry's name, type, and size when applicable. Provide parent navigation, refresh, and the existing upload-to-inbox action.
- Download a selected regular file with its original name or create a ZIP of the current directory. ZIPs preserve subdirectories, including empty ones. ZIP creation skips symbolic links and special files.
- Read files and directories relative to an open `/workspace` directory. Reject attempts to leave the workspace and avoid following symlinks at any level. Display broken links and special entries without opening them.
- Limit individual downloads and uncompressed ZIP contents to 128 MiB. Limit a listing to 1,000 entries and a ZIP to 5,000 entries. Report files that exceed a limit or disappear while being read. Files and ZIPs are built within the browser session.

## Local web preview

- Accept an HTTP port and an absolute path. Start or restart a dev server from the terminal, then use **Open** or **Refresh** in the preview. Common entry points include `python3 -m http.server 8000 --bind 127.0.0.1` and a server-rendered project.
- Fetch from the guest's `127.0.0.1` only, on the selected port. Limit the preview to HTTP GET. Block internal port 18791 and redirects that leave the selected guest origin. The feature works with external networking disabled.
- Render HTML, CSS, and local images using an isolated frame. Follow links and stylesheets from the same guest origin. Render text and JSON as text. Display the HTTP status and any connection, format, or size error. Provide back and refresh controls.
- The initial preview supports static and server-rendered pages. Guest JavaScript, forms, WebSockets, third-party assets, and hot reload are outside its scope. Projects that render entirely with client-side JavaScript need a static or server-rendered entry point for this preview.
- Limit each document or resource to 8 MiB and each page to 24 MiB, 48 resources, and four redirects. Closing or replacing a preview cancels pending work. Browser credentials, login sessions, and external requests are outside the preview.

## Tool packs

| Pack | Alpine packages | Use |
| --- | --- | --- |
| Shell tools | `fzf`, `shellcheck` | Interactive search and shell script linting |
| Native build | `build-base`, `pkgconf`, `linux-headers` | GCC, C++, headers, and build tooling |

- Show the installed state for each pack and install only on request through Alpine's signed 3.24 repositories. Use the existing network authorization. Report errors and allow retries. The normal workspace save and reload workflow retains installed packs.
- Check free space before installation and use the existing storage growth prompt when the estimated space is unavailable. Hold workspace saves while an installation is active so checkpoints contain a completed package transaction.

## Acceptance checks

- Download a regular file and a ZIP and independently verify their contents. Exercise nested navigation, hidden files, symlinks, and names containing spaces or punctuation.
- Serve a page in Alpine and preview it with external networking disabled. Verify stylesheet and image loading, local navigation, refresh, text and JSON responses, error messages, and rejection of cross-origin redirects and active content.
- Install both packs through the UI from approved mirrors, exercise their tools in Alpine, and confirm that they remain installed after a save and reload.
- Verify the final standalone HTML and browser behavior on a Cloudflare preview before routing production traffic. Record the production version, tests, and rollback version in the release results.
