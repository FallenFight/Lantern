// Thin wrapper over the local Slate server.

async function request(path, { method = 'GET', body, signal } = {}) {
  const init = { method, signal, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 400) }; }
  }
  if (!response.ok) {
    const err = new Error((data && (data.error || data.hint)) || `HTTP ${response.status}`);
    err.status = response.status;
    err.hint = data && data.hint;
    throw err;
  }
  return data;
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  models: () => request('/api/models'),
  refreshModels: () => request('/api/models/refresh', { method: 'POST' }),
  deleteModel: (model) => request('/api/models/delete', { method: 'POST', body: { model } }),
  unloadModel: (model) => request('/api/models/unload', { method: 'POST', body: { model } }),
  loadModel: (model, keep_alive) =>
    request('/api/models/load', { method: 'POST', body: { model, keep_alive } }),

  getSettings: () => request('/api/settings'),
  saveSettings: (patch) => request('/api/settings', { method: 'PUT', body: patch }),

  personas: () => request('/api/personas'),
  createPersona: (body) => request('/api/personas', { method: 'POST', body }),
  updatePersona: (id, body) => request(`/api/personas/${id}`, { method: 'PUT', body }),
  deletePersona: (id) => request(`/api/personas/${id}`, { method: 'DELETE' }),

  prompts: () => request('/api/prompts'),
  createPrompt: (body) => request('/api/prompts', { method: 'POST', body }),
  updatePrompt: (id, body) => request(`/api/prompts/${id}`, { method: 'PUT', body }),
  deletePrompt: (id) => request(`/api/prompts/${id}`, { method: 'DELETE' }),

  chats: () => request('/api/chats'),
  createChat: (body) => request('/api/chats', { method: 'POST', body }),
  getChat: (id) => request(`/api/chats/${id}`),
  updateChat: (id, body) => request(`/api/chats/${id}`, { method: 'PUT', body }),
  deleteChat: (id) => request(`/api/chats/${id}`, { method: 'DELETE' }),
  searchChats: (q) => request(`/api/chats/search?q=${encodeURIComponent(q)}`),

  tools: () => request('/api/tools'),
  // The server owns the registry; we only name the tool we want run.
  callTool: (name, args, signal) =>
    request('/api/tools/call', { method: 'POST', body: { name, arguments: args }, signal }),

  // Refuses unless `update_check` is on — the server owns that gate.
  checkUpdate: (force) => request(`/api/update${force ? '?force=1' : ''}`),

  backup: () => request('/api/backup'),
  restore: (payload) => request('/api/restore', { method: 'POST', body: payload }),

  title: (model, transcript) => request('/api/title', { method: 'POST', body: { model, transcript } }),
};

/**
 * POST a body and yield each newline-delimited JSON object as it arrives.
 * Aborting `signal` closes the socket, which tells Ollama to stop generating.
 */
export async function* streamNDJSON(path, body, signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let payload = {};
    try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 400) }; }
    const err = new Error(payload.error || `HTTP ${response.status}`);
    err.hint = payload.hint;
    err.status = response.status;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* partial or noise; skip */ }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try { yield JSON.parse(tail); } catch { /* ignore */ }
  }
}

export const chatStream = (body, signal) => streamNDJSON('/api/chat', body, signal);
export const pullStream = (model, signal) => streamNDJSON('/api/models/pull', { model }, signal);
