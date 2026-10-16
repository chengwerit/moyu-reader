/* ==========================================================================
   墨语 · 本地优先网页阅读器
   db.js — 数据层（双后端）
   ------------------------------------------------------------------------
   提供两套后端，导出函数签名完全一致，上层代码无需区分：

     文件后端（默认，桌面版）
       由 server.ps1 提供 API，数据写入本文件夹的 data/ 目录。
       好处：整个文件夹复制到另一台电脑即可继续使用；不受浏览器清理影响。

     IndexedDB 后端（兜底，网页直开时）
       直接双击 index.html 或用其它静态服务打开时，浏览器访问不到本地 API，
       此时退回 IndexedDB，行为与旧版一致。

   上层调用方（app.js / engine.js / ai.js）只管用导出的函数，
   切换后端对它们透明。
   ========================================================================== */

const DB_NAME = 'moyu-reader';
const DB_VERSION = 1;

/** 存储模式：'file' | 'idb'，在首次调用时探测确定 */
let MODE = null;

/* ==========================================================================
   模式探测
   ========================================================================== */

/**
 * 探测本地存储 API 是否可用。
 * 只探测一次，结果缓存。
 */
async function detectMode() {
  if (MODE) return MODE;

  // file:// 下必然没有 API，直接用 IndexedDB（Chrome 的 file:// 仍支持 IDB）
  if (location.protocol === 'file:') {
    MODE = 'idb';
    return MODE;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('./api/ping', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      if (j && j.ok && j.app === 'moyu-reader') {
        MODE = 'file';
        return MODE;
      }
    }
  } catch {
    // API 不可达，走 IndexedDB
  }

  MODE = 'idb';
  return MODE;
}

/** 当前是否在用文件存储（供界面提示用） */
export async function isFileMode() {
  return (await detectMode()) === 'file';
}

/* ==========================================================================
   文件后端实现
   ========================================================================== */

const FB = {
  lib: null,          // { version, books, notes, bookmarks, kv }
  loading: null,

  /**
   * 读取整库。
   * 加一个短 TTL 缓存，避免连续操作时反复请求；
   * 超过 TTL 就重新从磁盘读，这样用户手动改过 data 目录里的 JSON 也能被感知到。
   */
  async load(force) {
    const now = Date.now();
    if (!force && FB.lib && FB.loadedAt && (now - FB.loadedAt) < 1500) {
      return FB.lib;
    }
    if (FB.loading && !force) return FB.loading;

    const doLoad = async () => {
      try {
        const res = await fetch('./api/library', { cache: 'no-store' });
        const j = await res.json();
        FB.lib = {
          version: j.version || 1,
          books: Array.isArray(j.books) ? j.books : [],
          notes: Array.isArray(j.notes) ? j.notes : [],
          bookmarks: Array.isArray(j.bookmarks) ? j.bookmarks : [],
          kv: (j.kv && typeof j.kv === 'object') ? j.kv : {}
        };
      } catch {
        FB.lib = { version: 1, books: [], notes: [], bookmarks: [], kv: {} };
      }
      FB.loadedAt = Date.now();
      return FB.lib;
    };

    if (force) return doLoad();
    FB.loading = doLoad();
    const r = await FB.loading;
    FB.loading = null;
    return r;
  },

  /**
   * 写回服务端。
   * 流程：强制重读最新 → 套用本次改动 → 写盘。
   * 关键在于改动基于「最新磁盘状态」而不是内存快照，
   * 否则多标签页或外部改动会被覆盖。
   */
  _saving: null,
  _pending: null,
  async save(mutator) {
    // 合并同一批的多次改动，等价于读-改-写的事务语义
    FB._pending = mutator;
    if (FB._saving) return FB._saving;

    FB._saving = (async () => {
      while (FB._pending) {
        const mutate = FB._pending;
        FB._pending = null;
        const lib = await FB.load(true);
        mutate(lib);
        await fetch('./api/library', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: lib.version,
            books: lib.books,
            notes: lib.notes,
            bookmarks: lib.bookmarks,
            kv: lib.kv
          })
        });
      }
      FB._saving = null;
    })();
    return FB._saving;
  },

  async bookChapters(id) {
    try {
      const res = await fetch(`./api/book/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const j = await res.json();
      return Array.isArray(j.chapters) ? j.chapters : [];
    } catch {
      return [];
    }
  },

  async putChaptersToServer(id, chapters) {
    await fetch(`./api/book/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: id, chapters })
    });
  },

  async deleteBookOnServer(id) {
    try {
      await fetch(`./api/book/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {}
  }
};

/* ==========================================================================
   IndexedDB 后端实现
   ========================================================================== */

/** 对象仓库定义 */
const STORES = {
  books: { keyPath: 'id', indexes: [['addedAt', 'addedAt'], ['lastRead', 'lastRead']] },
  content: { keyPath: ['bookId', 'index'], indexes: [['bookId', 'bookId']] },
  notes: { keyPath: 'id', indexes: [['bookId', 'bookId'], ['bookId_chapter', ['bookId', 'chapterIndex']]] },
  bookmarks: { keyPath: 'id', indexes: [['bookId', 'bookId']] },
  kv: { keyPath: 'k' }
};

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idxName, keyPath] of def.indexes || []) os.createIndex(idxName, keyPath);
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode) {
  return open().then(db => db.transaction(stores, mode));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ==========================================================================
   统一导出接口（根据 MODE 分发）
   ========================================================================== */

const IDB = {
  async putBook(book) {
    const t = await tx('books', 'readwrite');
    await wrap(t.objectStore('books').put(book));
    return book;
  },
  async getBook(id) {
    const t = await tx('books', 'readonly');
    return wrap(t.objectStore('books').get(id));
  },
  async allBooks() {
    const t = await tx('books', 'readonly');
    const list = await wrap(t.objectStore('books').getAll());
    return sortBooks(list);
  },
  async deleteBook(id) {
    const db = await open();
    const t = db.transaction(['books', 'content', 'notes', 'bookmarks'], 'readwrite');
    t.objectStore('books').delete(id);
    const idx = t.objectStore('content').index('bookId');
    const req = idx.openKeyCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { t.objectStore('content').delete(cur.primaryKey); cur.continue(); }
    };
    for (const s of ['notes', 'bookmarks']) {
      const r2 = t.objectStore(s).index('bookId').openCursor(IDBKeyRange.only(id));
      r2.onsuccess = () => { const c = r2.result; if (c) { c.delete(); c.continue(); } };
    }
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async updateProgress(id, patch) {
    const book = await this.getBook(id);
    if (!book) return null;
    Object.assign(book, patch, { lastRead: Date.now() });
    await this.putBook(book);
    return book;
  },
  async getChapter(bookId, index) {
    const t = await tx('content', 'readonly');
    return wrap(t.objectStore('content').get([bookId, index]));
  },
  async putChapters(bookId, chapters, onProgress) {
    // IndexedDB 事务在 await 让出后会自动失活，必须在单个同步循环内写完
    const t = await tx('content', 'readwrite');
    const os = t.objectStore('content');
    for (let i = 0; i < chapters.length; i++) {
      os.put({ bookId, index: i, html: chapters[i].html, text: chapters[i].text });
    }
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    if (onProgress) onProgress(1);
    return chapters.length;
  },
  async addNote(note) {
    const rec = { id: `${note.bookId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now(), ...note };
    const t = await tx('notes', 'readwrite');
    await wrap(t.objectStore('notes').add(rec));
    return rec;
  },
  async updateNote(id, patch) {
    const t = await tx('notes', 'readwrite');
    const os = t.objectStore('notes');
    const rec = await wrap(os.get(id));
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    await wrap(os.put(rec));
    return rec;
  },
  async removeNote(id) {
    const t = await tx('notes', 'readwrite');
    return wrap(t.objectStore('notes').delete(id));
  },
  async notesOf(bookId) {
    const t = await tx('notes', 'readonly');
    const list = await wrap(t.objectStore('notes').index('bookId').getAll(IDBKeyRange.only(bookId)));
    return sortNotes(list);
  },
  async allNotes() {
    const t = await tx('notes', 'readonly');
    return wrap(t.objectStore('notes').getAll());
  },
  async addBookmark(bm) {
    const t = await tx('bookmarks', 'readwrite');
    const dup = await wrap(t.objectStore('bookmarks').index('bookId').getAll(IDBKeyRange.only(bm.bookId)));
    const exist = dup.find(b => b.chapterIndex === bm.chapterIndex && b.paraIdx === bm.paraIdx);
    if (exist) return exist;
    const rec = { id: `${bm.bookId}:${bm.chapterIndex}:${bm.paraIdx}`, createdAt: Date.now(), ...bm };
    await wrap(t.objectStore('bookmarks').add(rec));
    return rec;
  },
  async removeBookmark(id) {
    const t = await tx('bookmarks', 'readwrite');
    return wrap(t.objectStore('bookmarks').delete(id));
  },
  async bookmarksOf(bookId) {
    const t = await tx('bookmarks', 'readonly');
    const list = await wrap(t.objectStore('bookmarks').index('bookId').getAll(IDBKeyRange.only(bookId)));
    return list.sort((a, b) => a.chapterIndex - b.chapterIndex || a.paraIdx - b.paraIdx);
  },
  async allBookmarks() {
    const t = await tx('bookmarks', 'readonly');
    return wrap(t.objectStore('bookmarks').getAll());
  },
  async getKV(k, fallback = null) {
    const t = await tx('kv', 'readonly');
    const rec = await wrap(t.objectStore('kv').get(k));
    return rec ? rec.v : fallback;
  },
  async setKV(k, v) {
    const t = await tx('kv', 'readwrite');
    return wrap(t.objectStore('kv').put({ k, v }));
  },
  async exportAll(onProgress) {
    const books = await this.allBooks();
    const notes = await this.allNotes();
    const bookmarks = await this.allBookmarks();
    const settings = {};
    for (const key of ['theme', 'fontFamily', 'fontSize', 'lineHeight', 'pageMode', 'aiConfig', 'dailyQuote']) {
      settings[key] = await this.getKV(key);
    }
    const payload = { app: 'moyu-reader', version: DB_VERSION, exportedAt: Date.now(), settings, books, notes, bookmarks, content: [] };
    const total = books.length;
    for (let i = 0; i < total; i++) {
      const id = books[i].id;
      const rows = await (async () => {
        const t = await tx('content', 'readonly');
        return wrap(t.objectStore('content').index('bookId').getAll(IDBKeyRange.only(id)));
      })();
      payload.content.push({ bookId: id, chapters: rows });
      if (onProgress) onProgress((i + 1) / total);
    }
    return payload;
  },
  async importAll(payload, onProgress) {
    if (!payload || payload.app !== 'moyu-reader') throw new Error('不是有效的墨语备份文件');
    const db = await open();
    let step = 0;
    const totalSteps = (payload.books?.length || 0) + (payload.content?.length || 0) + 1;
    const bump = () => { step++; onProgress && onProgress(step / totalSteps); };

    const t1 = db.transaction('books', 'readwrite');
    for (const b of payload.books || []) { t1.objectStore('books').put(b); bump(); }
    await new Promise((res, rej) => { t1.oncomplete = res; t1.onerror = () => rej(t1.error); });

    for (const c of payload.content || []) {
      const t2 = db.transaction('content', 'readwrite');
      for (const ch of c.chapters) t2.objectStore('content').put(ch);
      await new Promise((res, rej) => { t2.oncomplete = res; t2.onerror = () => rej(t2.error); });
      bump();
    }

    const t3 = db.transaction(['notes', 'bookmarks', 'kv'], 'readwrite');
    for (const n of payload.notes || []) { try { t3.objectStore('notes').put(n); } catch {} }
    for (const b of payload.bookmarks || []) { try { t3.objectStore('bookmarks').put(b); } catch {} }
    for (const [k, v] of Object.entries(payload.settings || {})) {
      if (v !== null && v !== undefined) t3.objectStore('kv').put({ k, v });
    }
    await new Promise((res, rej) => { t3.oncomplete = res; t3.onerror = () => rej(t3.error); });
    bump();
    return payload.books?.length || 0;
  },
  async stats() {
    const books = await this.allBooks();
    const t = await tx('content', 'readonly');
    const count = await wrap(t.objectStore('content').count());
    return { books: books.length, chapters: count, notes: (await this.allNotes()).length };
  },
  async usage() {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  }
};

/* --------------------------------------------------------------- 文件后端 */

const FILE = {
  async putBook(book) {
    let result = null;
    await FB.save(lib => {
      const i = lib.books.findIndex(b => b.id === book.id);
      if (i >= 0) lib.books[i] = book; else lib.books.push(book);
      result = book;
    });
    return result;
  },
  async getBook(id) {
    const lib = await FB.load();
    return lib.books.find(b => b.id === id) || null;
  },
  async allBooks() {
    const lib = await FB.load();
    return sortBooks(lib.books.slice());
  },
  async deleteBook(id) {
    await FB.save(lib => {
      lib.books = lib.books.filter(b => b.id !== id);
      lib.notes = lib.notes.filter(n => n.bookId !== id);
      lib.bookmarks = lib.bookmarks.filter(b => b.bookId !== id);
    });
    await FB.deleteBookOnServer(id);
  },
  async updateProgress(id, patch) {
    let result = null;
    await FB.save(lib => {
      const book = lib.books.find(b => b.id === id);
      if (!book) return;
      Object.assign(book, patch, { lastRead: Date.now() });
      result = book;
    });
    return result;
  },
  async getChapter(bookId, index) {
    const chapters = await FB.bookChapters(bookId);
    return chapters.find(c => c.index === index) || null;
  },
  async putChapters(bookId, chapters, onProgress) {
    await FB.putChaptersToServer(bookId, chapters.map((c, i) => ({
      index: i, html: c.html, text: c.text
    })));
    if (onProgress) onProgress(1);
    return chapters.length;
  },
  async addNote(note) {
    const rec = { id: `${note.bookId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now(), ...note };
    await FB.save(lib => { lib.notes.push(rec); });
    return rec;
  },
  async updateNote(id, patch) {
    let result = null;
    await FB.save(lib => {
      const rec = lib.notes.find(n => n.id === id);
      if (!rec) return;
      Object.assign(rec, patch, { updatedAt: Date.now() });
      result = rec;
    });
    return result;
  },
  async removeNote(id) {
    await FB.save(lib => { lib.notes = lib.notes.filter(n => n.id !== id); });
  },
  async notesOf(bookId) {
    const lib = await FB.load();
    return sortNotes(lib.notes.filter(n => n.bookId === bookId));
  },
  async allNotes() {
    const lib = await FB.load();
    return lib.notes.slice();
  },
  async addBookmark(bm) {
    const lib = await FB.load();
    const dup = lib.bookmarks.filter(b => b.bookId === bm.bookId);
    const exist = dup.find(b => b.chapterIndex === bm.chapterIndex && b.paraIdx === bm.paraIdx);
    if (exist) return exist;
    const rec = { id: `${bm.bookId}:${bm.chapterIndex}:${bm.paraIdx}`, createdAt: Date.now(), ...bm };
    await FB.save(l => { l.bookmarks.push(rec); });
    return rec;
  },
  async removeBookmark(id) {
    await FB.save(lib => { lib.bookmarks = lib.bookmarks.filter(b => b.id !== id); });
  },
  async bookmarksOf(bookId) {
    const lib = await FB.load();
    return lib.bookmarks
      .filter(b => b.bookId === bookId)
      .sort((a, b) => a.chapterIndex - b.chapterIndex || a.paraIdx - b.paraIdx);
  },
  async allBookmarks() {
    const lib = await FB.load();
    return lib.bookmarks.slice();
  },
  async getKV(k, fallback = null) {
    const lib = await FB.load();
    return (k in lib.kv) ? lib.kv[k] : fallback;
  },
  async setKV(k, v) {
    await FB.save(lib => { lib.kv[k] = v; });
  },
  async exportAll(onProgress) {
    const books = await this.allBooks();
    const notes = await this.allNotes();
    const bookmarks = await this.allBookmarks();
    const settings = {};
    for (const key of ['theme', 'fontFamily', 'fontSize', 'lineHeight', 'pageMode', 'aiConfig', 'dailyQuote']) {
      settings[key] = await this.getKV(key);
    }
    const payload = { app: 'moyu-reader', version: DB_VERSION, exportedAt: Date.now(), settings, books, notes, bookmarks, content: [] };
    const total = books.length;
    for (let i = 0; i < total; i++) {
      const id = books[i].id;
      const chapters = await FB.bookChapters(id);
      payload.content.push({ bookId: id, chapters });
      if (onProgress) onProgress((i + 1) / total);
    }
    return payload;
  },
  async importAll(payload, onProgress) {
    if (!payload || payload.app !== 'moyu-reader') throw new Error('不是有效的墨语备份文件');
    let step = 0;
    const totalSteps = (payload.books?.length || 0) + (payload.content?.length || 0) + 1;
    const bump = () => { step++; onProgress && onProgress(step / totalSteps); };

    // 一次性套用全部改动，避免逐条触发写盘
    await FB.save(lib => {
      for (const b of payload.books || []) {
        const i = lib.books.findIndex(x => x.id === b.id);
        if (i >= 0) lib.books[i] = b; else lib.books.push(b);
        bump();
      }
      for (const n of payload.notes || []) {
        const i = lib.notes.findIndex(x => x.id === n.id);
        if (i >= 0) lib.notes[i] = n; else lib.notes.push(n);
      }
      for (const b of payload.bookmarks || []) {
        const i = lib.bookmarks.findIndex(x => x.id === b.id);
        if (i >= 0) lib.bookmarks[i] = b; else lib.bookmarks.push(b);
      }
      for (const [k, v] of Object.entries(payload.settings || {})) {
        if (v !== null && v !== undefined) lib.kv[k] = v;
      }
    });

    for (const c of payload.content || []) {
      await FB.putChaptersToServer(c.bookId, c.chapters);
      bump();
    }
    bump();
    return payload.books?.length || 0;
  },
  async stats() {
    const lib = await FB.load();
    // 章节总数按已入库书籍逐本读取，量不大且避免维护冗余计数字段
    let chapters = 0;
    for (const b of lib.books) {
      chapters += (await FB.bookChapters(b.id)).length;
    }
    return { books: lib.books.length, chapters, notes: lib.notes.length };
  },
  async usage() {
    // 文件模式下占用由服务器统计，这里退化为统计已知的书籍元数据规模
    const lib = await FB.load();
    let used = JSON.stringify(lib).length;
    for (const b of lib.books) {
      used += (await FB.bookChapters(b.id)).reduce((n, c) => n + (c.text?.length || 0), 0);
    }
    // 给个宽松的配额值，避免界面显示 0
    return { used, quota: Math.max(used * 20, 5 * 1024 * 1024 * 1024) };
  }
};

/* ------------------------------------------------------------- 排序辅助 */

function sortBooks(list) {
  return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastRead || b.addedAt) - (a.lastRead || a.addedAt));
}

function sortNotes(list) {
  return list.sort((a, b) => a.chapterIndex - b.chapterIndex || a.paraIdx - b.paraIdx || a.start - b.start);
}

/* ------------------------------------------------------------- 分发封装 */

/** 取得当前生效的后端实现 */
async function backend() {
  return (await detectMode()) === 'file' ? FILE : IDB;
}

export const putBook       = (...a) => backend().then(b => b.putBook(...a));
export const getBook       = (...a) => backend().then(b => b.getBook(...a));
export const allBooks      = (...a) => backend().then(b => b.allBooks(...a));
export const deleteBook    = (...a) => backend().then(b => b.deleteBook(...a));
export const updateProgress= (...a) => backend().then(b => b.updateProgress(...a));
export const getChapter    = (...a) => backend().then(b => b.getChapter(...a));
export const putChapters   = (...a) => backend().then(b => b.putChapters(...a));
export const addNote       = (...a) => backend().then(b => b.addNote(...a));
export const updateNote    = (...a) => backend().then(b => b.updateNote(...a));
export const removeNote    = (...a) => backend().then(b => b.removeNote(...a));
export const notesOf       = (...a) => backend().then(b => b.notesOf(...a));
export const allNotes      = (...a) => backend().then(b => b.allNotes(...a));
export const addBookmark   = (...a) => backend().then(b => b.addBookmark(...a));
export const removeBookmark= (...a) => backend().then(b => b.removeBookmark(...a));
export const bookmarksOf   = (...a) => backend().then(b => b.bookmarksOf(...a));
export const allBookmarks  = (...a) => backend().then(b => b.allBookmarks(...a));
export const getKV         = (...a) => backend().then(b => b.getKV(...a));
export const setKV         = (...a) => backend().then(b => b.setKV(...a));
export const exportAll     = (...a) => backend().then(b => b.exportAll(...a));
export const importAll     = (...a) => backend().then(b => b.importAll(...a));
export const stats         = (...a) => backend().then(b => b.stats(...a));
export const usage         = (...a) => backend().then(b => b.usage(...a));

/* ==========================================================================
   迁移：从旧的 IndexedDB 数据搬到 data/ 目录
   ========================================================================== */

/**
 * 检查 IndexedDB 里是否有旧数据，若有且文件库为空则导入过来。
 * 供界面在首次运行时提示用户调用。
 */
export async function detectLegacyData() {
  if ((await detectMode()) !== 'file') return null;
  try {
    const lib = await FB.load();
    if (lib.books.length) return null;         // 已有数据，不迁移
    const t = await tx('books', 'readonly');
    const books = await wrap(t.objectStore('books').getAll());
    if (!books.length) return null;
    let chapterCount = 0;
    const content = [];
    for (const b of books) {
      const tc = await tx('content', 'readonly');
      const rows = await wrap(tc.objectStore('content').index('bookId').getAll(IDBKeyRange.only(b.id)));
      content.push({ bookId: b.id, chapters: rows });
      chapterCount += rows.length;
    }
    const tn = await tx('notes', 'readonly');
    const notes = await wrap(tn.objectStore('notes').getAll());
    const tb = await tx('bookmarks', 'readonly');
    const bookmarks = await wrap(tb.objectStore('bookmarks').getAll());
    const settings = {};
    for (const key of ['theme', 'fontFamily', 'fontSize', 'lineHeight', 'pageMode', 'aiConfig']) {
      const tk = await tx('kv', 'readonly');
      const rec = await wrap(tk.objectStore('kv').get(key));
      if (rec) settings[key] = rec.v;
    }
    return { books, notes, bookmarks, settings, content, chapterCount };
  } catch {
    return null;
  }
}

/** 执行迁移：把检测到的旧数据写入文件库 */
export async function migrateLegacy(legacy) {
  if (!legacy) return 0;
  await FB.save(lib => {
    lib.books = legacy.books;
    lib.notes = legacy.notes || [];
    lib.bookmarks = legacy.bookmarks || [];
    for (const [k, v] of Object.entries(legacy.settings || {})) {
      if (v !== null && v !== undefined) lib.kv[k] = v;
    }
  });
  for (const c of legacy.content || []) {
    await FB.putChaptersToServer(c.bookId, c.chapters);
  }
  return legacy.books.length;
}

/** 数据所在位置的人类可读描述，供界面展示 */
export async function storageLocation() {
  if ((await detectMode()) === 'file') {
    try {
      const res = await fetch('./api/ping', { cache: 'no-store' });
      const j = await res.json();
      return j.dataDir || '本文件夹的 data 目录';
    } catch {
      return '本文件夹的 data 目录';
    }
  }
  return '本机浏览器 IndexedDB';
}