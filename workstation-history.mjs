const shellHistoryKey = 'shell-history-v1';
const shellHistoryMaxEntries = 2000;
const shellHistoryMaxBytes = 256 * 1024;
const shellHistoryBridge = '/usr/local/libexec/browser-agent/_history';
const shellHistoryRC = '/usr/local/libexec/browser-agent/bashrc';
let shellHistoryQueue = Promise.resolve();
let shellHistoryDisabled = false;

function historyRecords(text) {
  const records = [];
  for (const raw of text.split(/(?=^#[0-9]+\n)/m)) {
    const newline = raw.indexOf('\n');
    if (newline < 0 || !/^#[0-9]+$/.test(raw.slice(0, newline))) continue;
    const command = raw.slice(newline + 1).replace(/\n$/, '');
    if (!command.trim() || credentialText.test(command) || gitSecret.test(command) ||
        /https?:\/\/[^\s/@]+@|authorization:\s*(?:basic|bearer)\b/i.test(command) ||
        egress.secrets.some(secret => command.includes(secret))) continue;
    records.push({ raw, command });
  }
  return records;
}

function queueShellHistory(operation) {
  const queued = shellHistoryQueue.then(operation);
  shellHistoryQueue = queued.catch(() => {});
  return queued;
}

async function readShellHistory() {
  const blob = await workspaceStorage.get(shellHistoryKey);
  return blob && blob.size <= shellHistoryMaxBytes ? historyRecords(await blob.text()) : [];
}

async function clearShellHistory() {
  await workspaceStorage.remove(shellHistoryKey).catch(error => {
    if (error.name !== 'NotFoundError') throw error;
  });
}

async function readHistoryDelta(stdin) {
  const reader = stdin.getReader();
  const utf8 = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + utf8.decode();
      size += value.byteLength;
      if (size > shellHistoryMaxBytes) {
        await reader.cancel();
        return '';
      }
      text += utf8.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

async function shellHistoryCommand(context) {
  const writer = context.stdout.getWriter();
  try {
    if (!workspaceStorage || shellHistoryDisabled) return 1;
    const [action] = context.args ?? [];
    if (action === 'append') {
      const additions = historyRecords(await readHistoryDelta(context.stdin));
      if (!additions.length) return 0;
      return await queueShellHistory(async () => {
        if (shellHistoryDisabled) return 1;
        const records = await readShellHistory();
        for (const entry of additions) {
          if (entry.command !== records.at(-1)?.command) records.push(entry);
        }
        const bounded = [];
        let bytes = 0;
        for (let i = records.length - 1; i >= 0 && bounded.length < shellHistoryMaxEntries; i--) {
          bytes += encoder.encode(records[i].raw).byteLength;
          if (bytes > shellHistoryMaxBytes) break;
          bounded.push(records[i].raw);
        }
        await workspaceStorage.put(shellHistoryKey, new Blob(bounded.reverse()));
        return 0;
      });
    }
    if (action === 'read') {
      const records = await queueShellHistory(readShellHistory);
      if (records.length) await writer.write(records.map(({ raw }) => raw).join(''));
    } else if (action === 'clear') {
      await queueShellHistory(clearShellHistory);
    } else return 1;
    return 0;
  } catch { return 1; }
  finally { await writer.close(); }
}

const shellHistoryStartup = String.raw`
export PATH="/usr/local/libexec/browser-agent/bin:$PATH"
HISTFILE=/dev/null
HISTTIMEFORMAT=
HISTSIZE=2000
HISTCONTROL=ignoreboth
HISTIGNORE=history-clear
shopt -s histappend cmdhist lithist
__pointblank_history_file=$(mktemp /tmp/pointblank-history.XXXXXXXX)
if [[ -n $__pointblank_history_file ]]; then
  if /usr/local/libexec/browser-agent/_history read > "$__pointblank_history_file"; then
    builtin history -r "$__pointblank_history_file"
    : > "$__pointblank_history_file"
    trap 'rm -f -- "$__pointblank_history_file"' EXIT
  else
    rm -f -- "$__pointblank_history_file"
    __pointblank_history_file=
  fi
fi

history-clear() {
  if [[ -n $__pointblank_history_file ]]; then
    /usr/local/libexec/browser-agent/_history clear || {
      printf '%s\n' 'Could not clear saved Bash history' >&2
      return 1
    }
    : > "$__pointblank_history_file"
  fi
  builtin history -c
}

__pointblank_prompt() {
  if [[ -n $__pointblank_history_file ]]; then
    builtin history -a "$__pointblank_history_file"
    if [[ -s $__pointblank_history_file ]] &&
        /usr/local/libexec/browser-agent/_history append < "$__pointblank_history_file"; then
      : > "$__pointblank_history_file"
    fi
  fi
  printf '\033]5378;%s\007' "$PWD"
}

PROMPT_COMMAND=__pointblank_prompt
`;
