export function formatLoadBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(2) : kb.toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function responseContentLength(response) {
  const raw = response?.headers?.get?.('Content-Length');
  if (!/^\d+$/.test(String(raw || '').trim())) return null;
  const total = Number(raw);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

export function createLoadProgress(initial = {}) {
  let state = {
    phase: String(initial.phase || 'Preparing'),
    bytesLoaded: Math.max(0, Number(initial.bytesLoaded) || 0),
    bytesTotal: Number.isFinite(initial.bytesTotal) ? Math.max(0, Number(initial.bytesTotal)) : null,
    shardsLoaded: Math.max(0, Number(initial.shardsLoaded) || 0),
    shardsTotal: Number.isFinite(initial.shardsTotal) ? Math.max(0, Number(initial.shardsTotal)) : null,
    recordsLoaded: Math.max(0, Number(initial.recordsLoaded) || 0),
    recordsTotal: Number.isFinite(initial.recordsTotal) ? Math.max(0, Number(initial.recordsTotal)) : null,
  };
  const listeners = new Set();
  const snapshot = () => ({ ...state });
  return {
    snapshot,
    update(patch = {}) {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener(snapshot()));
      return snapshot();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}

export async function fetchTextWithProgress(input, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {};
  const response = await fetchImpl(input, init);
  if (!response.ok) throw new Error(`${String(input)} HTTP ${response.status}`);

  const total = responseContentLength(response);
  let loaded = 0;
  onProgress({ loaded, total });

  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      text += decoder.decode(value, { stream: true });
      onProgress({ loaded, total });
    }
    text += decoder.decode();
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    loaded = bytes.byteLength;
    text = new TextDecoder().decode(bytes);
    onProgress({ loaded, total });
  }

  onPhase('parsing');
  return { text, bytesLoaded: loaded, bytesTotal: total };
}

export async function fetchJsonWithProgress(input, init = {}, options = {}) {
  const result = await fetchTextWithProgress(input, init, options);
  return { ...result, data: JSON.parse(result.text) };
}
