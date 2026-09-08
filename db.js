/*
 * db.js — shared storage layer (background page + manager page).
 *
 * Storage design:
 *  - IndexedDB (binary-capable, no JSON-stringify overhead like storage.local).
 *  - The comment HTML (the big part) is gzip-compressed with CompressionStream
 *    and stored as an ArrayBuffer. HN comment HTML compresses ~3-5x.
 *  - A plain-text version of the comment is kept uncompressed: it is small and
 *    is what the fuzzy search indexes, so searching never has to decompress.
 *
 * Record shape (store "comments", keyPath "id"):
 *  {
 *    id:        "44123456",          // HN comment id (string)
 *    author:    "pg",
 *    timeISO:   "2026-07-12T19:23:11" | null,
 *    ageText:   "6 hours ago",
 *    text:      "plain text of the comment",   // uncompressed, for search
 *    htmlGz:    ArrayBuffer | null,            // gzip(innerHTML)
 *    html:      string | null,                 // fallback if gzip unavailable
 *    threadId:  "44120000" | null,
 *    threadTitle: "Show HN: ...",
 *    threadUrl: "https://news.ycombinator.com/item?id=44120000",
 *    commentUrl:"https://news.ycombinator.com/item?id=44123456",
 *    parentId:  "44123000" | null,
 *    tags:      ["focus", "digital-minimalism"],
 *    savedAt:   1783900000000
 *  }
 *
 * A second store, "searchIndex", holds one row: the serialized MiniSearch
 * index (gzip JSON) plus the metadata needed to decide whether it is still
 * usable. It is a cache: the comments store is the source of truth and the
 * manager reconciles the loaded index against it (see search.js restore()).
 */

"use strict";

const HNCS_DB_NAME = "hn-comment-saver";
const HNCS_DB_VERSION = 2;
const HNCS_STORE = "comments";
const HNCS_INDEX_STORE = "searchIndex";
const HNCS_INDEX_KEY = "main";

const hncsDB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(HNCS_DB_NAME, HNCS_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HNCS_STORE)) {
          const store = db.createObjectStore(HNCS_STORE, { keyPath: "id" });
          store.createIndex("savedAt", "savedAt");
          store.createIndex("threadId", "threadId");
          store.createIndex("tags", "tags", { multiEntry: true });
          store.createIndex("author", "author");
        }
        if (!db.objectStoreNames.contains(HNCS_INDEX_STORE)) {
          db.createObjectStore(HNCS_INDEX_STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another context (background vs manager) is upgrading: get out of
        // its way and reopen lazily on next use.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn, storeName = HNCS_STORE) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          const out = fn(store);
          t.oncomplete = () =>
            resolve(out && out.result !== undefined ? out.result : out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        }),
    );
  }

  // ---- compression helpers -------------------------------------------------

  const canCompress =
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined";

  async function gzip(str) {
    if (!canCompress) return null;
    const stream = new Blob([str])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  }

  async function gunzip(buf) {
    const stream = new Blob([buf])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  // ---- revision counter (for backup change-detection) ------------------------

  async function bumpRevision() {
    try {
      const api = globalThis.browser ?? globalThis.chrome;
      if (!api?.storage?.local) return;
      const got = await api.storage.local.get("hncsRev");
      await api.storage.local.set({ hncsRev: (got.hncsRev || 0) + 1 });
    } catch {
      /* non-fatal */
    }
  }

  // ---- public API ----------------------------------------------------------

  /** Compresses `html` into the record and stores it. Overwrites same id,
   *  but preserves existing tags/notes/savedAt (re-saving must not wipe them). */
  async function saveComment(raw) {
    const record = { ...raw };
    record.tags = Array.isArray(record.tags) ? record.tags : [];
    record.notes = Array.isArray(record.notes) ? record.notes : [];
    record.savedAt = record.savedAt || Date.now();

    const prev = await tx("readonly", (s) => s.get(record.id));
    if (prev) {
      if (!record.tags.length) record.tags = prev.tags || [];
      if (!record.notes.length) record.notes = prev.notes || [];
      record.savedAt = prev.savedAt || record.savedAt;
    }

    const html = record.html || "";
    const gz = await gzip(html);
    if (gz) {
      record.htmlGz = gz;
      record.html = null;
    } else {
      record.htmlGz = null; // environment without CompressionStream
    }
    await tx("readwrite", (s) => s.put(record));
    bumpRevision();
    return record.id;
  }

  /** Returns the record with `html` restored (decompressed). */
  async function getComment(id) {
    const rec = await tx("readonly", (s) => {
      const r = s.get(id);
      return r;
    });
    if (!rec) return null;
    return inflate(rec);
  }

  async function inflate(rec) {
    if (rec.htmlGz) {
      try {
        rec.html = await gunzip(rec.htmlGz);
      } catch {
        rec.html = rec.text || "";
      }
    }
    return rec;
  }

  /** All records, HTML left compressed (cheap; use for search/listing). */
  async function getAllMeta() {
    return tx("readonly", (s) => s.getAll());
  }

  async function getAllIds() {
    return tx("readonly", (s) => s.getAllKeys());
  }

  async function deleteComment(id) {
    await tx("readwrite", (s) => s.delete(id));
    bumpRevision();
  }

  async function setTags(id, tags) {
    const rec = await tx("readonly", (s) => s.get(id));
    if (!rec) return;
    rec.tags = normalizeTags(tags);
    await tx("readwrite", (s) => s.put(rec));
    bumpRevision();
    return rec.tags;
  }

  /** notes: [{id, quote, prefix, start, note, createdAt}] */
  async function setNotes(id, notes) {
    const rec = await tx("readonly", (s) => s.get(id));
    if (!rec) return;
    rec.notes = Array.isArray(notes) ? notes : [];
    await tx("readwrite", (s) => s.put(rec));
    bumpRevision();
    return rec.notes;
  }

  function normalizeTags(tags) {
    const seen = new Set();
    const out = [];
    for (let t of tags || []) {
      t = String(t).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }

  /** Export everything as a plain-JSON-able array (HTML decompressed). */
  async function exportAll() {
    const metas = await getAllMeta();
    const out = [];
    for (const rec of metas) {
      const full = await inflate({ ...rec });
      delete full.htmlGz;
      out.push(full);
    }
    return out;
  }

  /**
   * Import an array of exported records.
   * Existing ids: tags are merged (union), the stored comment is kept.
   * Returns { added, merged, skipped }.
   */
  async function importAll(records) {
    const existingIds = new Set(await getAllIds());
    let added = 0,
      merged = 0,
      skipped = 0;
    for (const raw of records) {
      if (!raw || !raw.id || typeof raw.id !== "string") {
        skipped++;
        continue;
      }
      if (existingIds.has(raw.id)) {
        const cur = await tx("readonly", (s) => s.get(raw.id));
        const union = normalizeTags([...(cur.tags || []), ...(raw.tags || [])]);
        // Union notes by note id.
        const curNotes = Array.isArray(cur.notes) ? cur.notes : [];
        const seen = new Set(curNotes.map((n) => n && n.id));
        const newNotes = (Array.isArray(raw.notes) ? raw.notes : []).filter(
          (n) => n && n.id && n.quote !== undefined && n.quote !== null && !seen.has(n.id),
        );
        const tagsChanged = union.length !== (cur.tags || []).length;
        if (tagsChanged || newNotes.length) {
          cur.tags = union;
          cur.notes = [...curNotes, ...newNotes];
          await tx("readwrite", (s) => s.put(cur));
          merged++;
        } else {
          skipped++;
        }
        continue;
      }
      await saveComment({
        id: raw.id,
        author: raw.author || "",
        timeISO: raw.timeISO || null,
        ageText: raw.ageText || "",
        text: raw.text || "",
        html: raw.html || raw.text || "",
        threadId: raw.threadId || null,
        threadTitle: raw.threadTitle || "",
        threadUrl: raw.threadUrl || "",
        commentUrl:
          raw.commentUrl ||
          (raw.id ? "https://news.ycombinator.com/item?id=" + raw.id : ""),
        parentId: raw.parentId || null,
        tags: normalizeTags(raw.tags),
        notes: Array.isArray(raw.notes)
          ? raw.notes.filter(
              (n) => n && n.id && n.quote !== undefined && n.quote !== null,
            )
          : [],
        savedAt: raw.savedAt || Date.now(),
      });
      existingIds.add(raw.id);
      added++;
    }
    if (added || merged) bumpRevision();
    return { added, merged, skipped };
  }

  // ---- search index cache ------------------------------------------------------

  /** Persist a serialized search index: { meta: {...}, json: string }. */
  async function putSearchIndex({ meta, json }) {
    const gz = await gzip(json);
    const row = {
      meta,
      jsonGz: gz,
      json: gz ? null : json,
      savedAt: Date.now(),
    };
    await tx("readwrite", (s) => s.put(row, HNCS_INDEX_KEY), HNCS_INDEX_STORE);
  }

  /** The stored index as { meta, json, savedAt }, or null if none/unreadable. */
  async function getSearchIndex() {
    const row = await tx(
      "readonly",
      (s) => s.get(HNCS_INDEX_KEY),
      HNCS_INDEX_STORE,
    );
    if (!row) return null;
    try {
      const json = row.jsonGz ? await gunzip(row.jsonGz) : row.json;
      if (typeof json !== "string") return null;
      return { meta: row.meta, json, savedAt: row.savedAt };
    } catch {
      return null;
    }
  }

  async function clearSearchIndex() {
    await tx("readwrite", (s) => s.delete(HNCS_INDEX_KEY), HNCS_INDEX_STORE);
  }

  return {
    putSearchIndex,
    getSearchIndex,
    clearSearchIndex,
    saveComment,
    getComment,
    getAllMeta,
    getAllIds,
    deleteComment,
    setTags,
    setNotes,
    normalizeTags,
    exportAll,
    importAll,
    inflate,
  };
})();
