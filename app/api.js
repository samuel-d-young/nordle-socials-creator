// Talking to the server. Every call carries the page's token and this tab's id.

const token = document.querySelector('meta[name="nordle-token"]')?.content ?? '';
export const clientId = `tab-${Math.random().toString(36).slice(2, 10)}`;

async function request(method, path, body, headers = {}) {
  const isBinary = body instanceof Blob || body instanceof ArrayBuffer;
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-nordle-token': token, 'x-nordle-client': clientId, ...(body !== undefined && !isBinary ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(json?.errors?.map((e) => (e.path && e.path !== '/' ? `${e.path}: ${e.message}` : e.message)).join('\n') || res.statusText || 'Request failed');
    err.status = res.status;
    err.errors = json?.errors ?? [];
    err.body = json;
    throw err;
  }
  return json;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  del: (path) => request('DELETE', path),
  async upload(project, file) {
    return request('POST', `/projects/${project}/assets`, file, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) });
  },
  /** Live events for one document. Returns a function that stops listening. */
  events(project, doc, onEvent, onState) {
    const es = new EventSource(`/api/events?project=${encodeURIComponent(project)}&doc=${encodeURIComponent(doc)}&t=${encodeURIComponent(token)}`);
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore a bad frame */ } };
    es.onopen = () => onState?.(true);
    es.onerror = () => onState?.(false);
    return () => es.close();
  },
};
