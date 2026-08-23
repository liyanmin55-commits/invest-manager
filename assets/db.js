/* 本地数据层：IndexedDB 封装（transactions / plans / meta）
   全局命名空间 DB，纯前端、无后端、数据只在你本机。 */
const DB = (() => {
  const NAME = "invest_db";
  const VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("transactions"))
          db.createObjectStore("transactions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("plans"))
          db.createObjectStore("plans", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta"))
          db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function store(name, mode) {
    return open().then((db) => db.transaction(name, mode).objectStore(name));
  }
  function promised(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    all: (name) => store(name, "readonly").then((s) => promised(s.getAll())),
    get: (name, id) => store(name, "readonly").then((s) => promised(s.get(id))),
    put: (name, val) => store(name, "readwrite").then((s) => promised(s.put(val))),
    del: (name, id) => store(name, "readwrite").then((s) => promised(s.delete(id))),
    clear: (name) => store(name, "readwrite").then((s) => promised(s.clear())),
    // meta 是 key-value
    meta: (key, value) =>
      value === undefined
        ? DB.get("meta", key).then((r) => (r ? r.value : undefined))
        : DB.put("meta", { key, value }),
  };
})();
