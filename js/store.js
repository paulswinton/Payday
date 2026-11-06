// Autosave: every change is written to the iPhone's own storage (IndexedDB)
// and confirmed BEFORE the screen updates. Nothing is held only in memory.
const DB_NAME = 'payday';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function done(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Save cancelled')); });
}

export async function openStore() {
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'seq' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  };
  const db = await req(open);
  return {
    async events() {
      const tx = db.transaction('events', 'readonly');
      return req(tx.objectStore('events').getAll());
    },
    async append(ev) {
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').add(ev);   // add, never put: an entry can't be overwritten
      await done(tx);
    },
    async replaceAll(events) {
      const tx = db.transaction('events', 'readwrite');
      const st = tx.objectStore('events');
      st.clear();
      for (const ev of events) st.add(ev);
      await done(tx);
    },
    async get(key) { return req(db.transaction('meta', 'readonly').objectStore('meta').get(key)); },
    async set(key, value) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(value, key); await done(tx); },
    async del(key) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').delete(key); await done(tx); },
  };
}

// Ask iOS to keep this app's storage (granted for Home Screen apps).
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return { supported: false, persisted: false };
    const already = await navigator.storage.persisted();
    const persisted = already || await navigator.storage.persist();
    return { supported: true, persisted };
  } catch { return { supported: false, persisted: false }; }
}

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
