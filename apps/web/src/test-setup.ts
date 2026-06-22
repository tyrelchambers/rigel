import "@testing-library/jest-dom";

// jsdom only exposes a working `localStorage` when the document has a non-opaque
// origin, which the default `about:blank` url does not. Node 22 also ships a
// native `localStorage` global that throws/warns unless `--localstorage-file` is
// set. So we probe it and install a minimal in-memory Storage when it's missing
// or non-functional, without clobbering a real working implementation (jsdom's,
// or one a test installs itself).
function localStorageWorks(): boolean {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return false;
    ls.setItem("__probe__", "1");
    ls.removeItem("__probe__");
    return true;
  } catch {
    return false;
  }
}

if (!localStorageWorks()) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}
