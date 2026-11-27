function workspaceAgentPath(path = '/workspace') {
  if (path === '/workspace' || path === '/workspace/') return [];
  if (typeof path !== 'string' || !path.startsWith('/workspace/')) {
    throw Error('Choose an absolute path under /workspace');
  }
  const parts = path.slice('/workspace/'.length).replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw Error('Choose a direct path under /workspace');
  }
  return parts;
}

function registerWorkspaceAgentTools(agent, views) {
  const path = { type: 'string', description: 'Absolute path under /workspace. Defaults to /workspace.' };
  const tools = new Map();
  function register(name, description, properties, required, run) {
    if (agent.toolSpecs.some(spec => spec.function.name === name)) return;
    agent.toolSpecs.push({ type: 'function', function: {
      name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
    } });
    tools.set(name, run);
  }

  register('workspace_files',
    'List files under /workspace, or open a folder in the workspace Files dialog so the user can download files or a ZIP.',
    { action: { type: 'string', enum: ['list', 'open'] }, path }, ['action'], async ({ action, path }, signal) => {
      const folder = workspaceAgentPath(path);
      const absolute = ['/workspace', ...folder].join('/');
      if (action !== 'list' && action !== 'open') throw Error('Use list or open');
      const entries = await workspaceFolderEntries(folder, signal);
      signal?.throwIfAborted();
      if (action === 'open') {
        views.files(folder, entries);
        return { opened: absolute };
      }
      const listing = [];
      let chars = 0;
      for (const entry of entries) {
        chars += JSON.stringify(entry).length;
        if (listing.length >= 30 || chars > 1400) break;
        listing.push(entry);
      }
      return { path: absolute, entries: listing, remaining: entries.length - listing.length };
    });
  register('workspace_preview',
    'Open a static preview of an HTTP server already running on loopback inside the Linux guest.',
    { port: { type: 'integer', minimum: 1, maximum: 65535 }, path: { type: 'string', description: 'Path beginning with /. Defaults to /.' } },
    ['port'], async ({ port, path = '/' }, signal) => {
      // The Qwen XML tool syntax represents numeric arguments as strings.
      const number = typeof port === 'string' && /^\d{1,5}$/.test(port) ? Number(port) : port;
      const reply = await views.preview(number, path, signal);
      if (reply.error) throw Error(reply.error);
      return reply;
    });
  register('workspace_tool_packs',
    'List optional Alpine tool packs and their installation status, or open the Tool Packs dialog for the user to install one.',
    { action: { type: 'string', enum: ['list', 'open'] } }, ['action'], async ({ action }, signal) => {
      if (action !== 'list' && action !== 'open') throw Error('Use list or open');
      const packs = await workspacePacksStatus(signal);
      if (action === 'open') {
        signal?.throwIfAborted();
        views.packs();
      }
      return { packs, opened: action === 'open' };
    });

  if (tools.size) {
    const inherited = agent.perform.bind(agent);
    agent.perform = async (name, args, context) => {
      const run = tools.get(name);
      if (!run) return inherited(name, args, context);
      context?.signal?.throwIfAborted();
      return JSON.stringify(await run(args, context?.signal));
    };
  }
  return agent;
}
