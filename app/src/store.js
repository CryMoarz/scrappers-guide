// Local persistence. IndexedDB holds the most (the full dataset, comments, field notes);
// localStorage is the fallback; memory is the last resort (private windows, locked-down devices).
const Store = (() => {
  const DB = 'sdg', OS = 'kv', PREFIX = 'sdg3:';
  let idb = null, mode = 'memory';
  const mem = new Map();

  function openIdb() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(OS);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  const lsOk = () => { try { localStorage.setItem(PREFIX + 't', '1'); localStorage.removeItem(PREFIX + 't'); return true; } catch (e) { return false; } };

  async function init() {
    idb = await openIdb();
    mode = idb ? 'indexeddb' : lsOk() ? 'localstorage' : 'memory';
    return mode;
  }
  function tx(kind, fn) {
    return new Promise((resolve, reject) => {
      const t = idb.transaction(OS, kind);
      const r = fn(t.objectStore(OS));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  async function get(k, fallback) {
    try {
      if (mode === 'indexeddb') { const v = await tx('readonly', s => s.get(k)); return v === undefined ? fallback : v; }
      if (mode === 'localstorage') { const s = localStorage.getItem(PREFIX + k); return s == null ? fallback : JSON.parse(s); }
    } catch (e) { /* fall through to memory */ }
    return mem.has(k) ? mem.get(k) : fallback;
  }
  async function set(k, v) {
    mem.set(k, v);
    try {
      if (mode === 'indexeddb') return await tx('readwrite', s => s.put(v, k));
      if (mode === 'localstorage') localStorage.setItem(PREFIX + k, JSON.stringify(v));
    } catch (e) { toast('Storage is full: turn comments off or export a backup'); }
  }
  async function del(k) {
    mem.delete(k);
    try {
      if (mode === 'indexeddb') return await tx('readwrite', s => s.delete(k));
      if (mode === 'localstorage') localStorage.removeItem(PREFIX + k);
    } catch (e) { /* ignore */ }
  }
  async function usage() {
    try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) { /* not available */ }
    return null;
  }
  async function persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } }
  // The v2 app kept everything in one localStorage key.
  function legacy() { try { const s = localStorage.getItem('sdg-db-v2') || localStorage.getItem('sdg-db-v1'); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  return { init, get, set, del, usage, persist, legacy, mode: () => mode };
})();
