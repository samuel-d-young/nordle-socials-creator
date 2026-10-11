// Claude's stock-library tools: see which libraries the owner has connected, search them, and bring a file into a project. There is deliberately
// NO tool to add a library, save a key or buy anything: those are the owner's. A file brought in is catalogued as "not looked at yet": look at
// it (render or open it) and rewrite its catalog entry before using it in a post.

export default (client, { READ, EDIT, NordleError }) => {
  void NordleError;
  return [
    {
      name: 'nordle_stock_libraries',
      description: 'The stock libraries (photos, video, music, sound effects) Nordle can search: which the owner has connected (ready), which still need a key, and the folders of their own stock. Use nordle_stock_search to look for something.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ,
      async handler() {
        const r = await client.get('/stock/libraries');
        const lines = r.libraries.map((l) => `${l.id} (${l.name}) [${l.kinds.join(', ')}]: ${l.added ? (l.configured ? 'ready' : `needs ${l.needs.join(' and ')}`) : 'not added by the owner yet'}${l.verified === false ? ' (definition not yet tried with a live key)' : ''}`);
        return { text: lines.join('\n') || 'No stock libraries.', json: r };
      },
    },
    {
      name: 'nordle_stock_search',
      description: 'Search one stock library for photos, video, music or sound effects. Returns each result with an id, title, author, a page to look at it, a preview address, size or length, and its licence. It spends a little of the owner\'s allowance with that library, so search with specific words and look at a page or two, not everything. Then nordle_stock_get brings a chosen one into a project.',
      inputSchema: {
        type: 'object',
        properties: { library: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 200 }, kind: { type: 'string', enum: ['photo', 'video', 'music', 'sfx'] }, page: { type: 'integer', minimum: 1, maximum: 100 } },
        required: ['library', 'query'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const q = new URLSearchParams({ library: a.library, q: a.query, ...(a.kind ? { kind: a.kind } : {}), ...(a.page ? { page: String(a.page) } : {}) });
        const r = await client.get(`/stock/search?${q}`);
        const lines = r.items.map((it) => `${it.id}: ${it.title}${it.author ? ` (by ${it.author})` : ''}${it.duration ? ` ${Math.round(it.duration)}s` : ''}${it.width ? ` ${it.width}x${it.height}` : ''}${it.page ? ` ${it.page}` : ''}${it.license && it.license !== r.license ? ` [${it.license}]` : ''}`);
        return { text: `${r.name} ${r.kind} "${r.query}", page ${r.page}${r.total !== null ? `, about ${r.total} results` : ''}. Licence: ${r.license ?? 'see each item'}\n${lines.join('\n') || 'Nothing found.'}`, json: r };
      },
    },
    {
      name: 'nordle_stock_get',
      description: 'Bring one stock item into a project: it is saved under assets/stock/ (an item already there is not fetched again), its licence is written to assets/stock/licences.json, and it gets a catalog entry that says it has NOT been looked at yet. Look at the file and rewrite the catalog entry ("shows", people, signs or logos in frame) before using it in a post. Never use anything with a visible brand, patient or sign that breaks the brand\'s rules.',
      inputSchema: {
        type: 'object',
        properties: { library: { type: 'string' }, id: { type: 'string' }, project: { type: 'string' }, kind: { type: 'string', enum: ['photo', 'video', 'music', 'sfx'] } },
        required: ['library', 'id', 'project'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post('/stock/get', { library: a.library, id: a.id, project: a.project, kind: a.kind });
        return { text: `${r.already ? 'Already in the project' : 'Saved'}: ${r.path}\nLicence: ${r.license ?? 'not stated: check the library page'}${r.already ? '' : '\nIts catalog entry says it has not been looked at: view it and describe it before use.'}`, json: r };
      },
    },
  ];
};
