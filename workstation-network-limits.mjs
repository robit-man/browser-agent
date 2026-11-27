// Git's HTTP fetch sends a single pack stream that can exceed an ordinary web response.
export const gitPackResponseBytes = 256 * 1024 * 1024;
export const gitPackTimeoutMs = 180000;

export function isGitPackDownload(url, method) {
  return method === 'POST' && url.origin === 'https://github.com' &&
    !url.search && /^\/[\w.-]+\/[\w.-]+\/git-upload-pack$/.test(url.pathname);
}
