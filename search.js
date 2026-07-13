/*
 * search.js — MiniSearch-backed search.
 *
 * Query syntax (modes accept aliases):
 *   plain words          token search across all fields (prefix + typo tolerant,
 *                        AND-combined, BM25-ish ranking with field boosts)
 *   "exact phrase"       verbatim substring filter (case-insensitive)
 *   #tag  tag: tags:     must have a tag starting with the value
 *   by:  author:  user:  author must start with the value
 *   thread:  title:      token search restricted to the thread title
 *   note:  notes:        token search restricted to your notes (text + quote)
 *   text:  body:         token search restricted to the comment body
 *
 * search() returns [{record, score, highlight}] where highlight is
 *   { byField: {text, threadTitle, author, notes, tags}, phrases: [] }
 * and each byField entry lists the *expanded* index terms MiniSearch matched
 * in that specific field — so the UI only marks text where the match
 * actually happened (a thread:-restricted hit never lights up the body).
 */
"use strict";

const hncsSearch = (() => {
  let mini = null;

  const FIELDS = ["text", "threadTitle", "author", "tags", "notes"];

  const MS_OPTIONS = {
    fields: FIELDS,
    storeFields: [],
    searchOptions: {
      prefix: true, // every term matches as a prefix ("lobot" -> "lobotomized")
      fuzzy: 0.2, // word-level edit distance, scaled by term length (>=1)
      combineWith: "AND",
      boost: { author: 3, tags: 2.5, notes: 2.5, threadTitle: 2, text: 1 },
    },
  };

  function docOf(rec) {
    return {
      id: rec.id,
      text: rec.text || "",
      threadTitle: rec.threadTitle || "",
      author: rec.author || "",
      tags: (rec.tags || []).join(" "),
      notes: (rec.notes || []).map((n) => (n.note || "") + " " + (n.quote || "")).join(" "),
    };
  }

  function build(records) {
    mini = new MiniSearch(MS_OPTIONS);
    mini.addAll(records.map(docOf));
  }

  function upsert(rec) {
    if (!mini) return;
    if (mini.has(rec.id)) mini.replace(docOf(rec));
    else mini.add(docOf(rec));
  }

  function remove(id) {
    if (mini && mini.has(id)) mini.discard(id);
  }

  // ---- query parsing ---------------------------------------------------------

  const MODE_ALIASES = {
    tag: "tags", tags: "tags",
    by: "authors", author: "authors", user: "authors",
    thread: "titleTerms", title: "titleTerms",
    note: "noteTerms", notes: "noteTerms",
    text: "textTerms", body: "textTerms", comment: "textTerms",
  };
  const MODE_RE = /^([a-z]+):(.+)$/;

  function parseQuery(q) {
    q = q || "";
    const phrases = [];
    q = q.replace(/"([^"]*)"/g, (_, p) => {
      const t = p.trim().toLowerCase();
      if (t) phrases.push(t);
      return " ";
    });

    const out = { phrases, tags: [], authors: [], titleTerms: [], noteTerms: [], textTerms: [], terms: [] };
    for (const t of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
      if (t.startsWith("#") && t.length > 1) {
        out.tags.push(t.slice(1));
        continue;
      }
      const m = t.match(MODE_RE);
      const bucket = m && MODE_ALIASES[m[1]];
      if (bucket) out[bucket].push(m[2]);
      else out.terms.push(t); // unknown mode (e.g. part of a URL) stays a term
    }
    return out;
  }

  // ---- searching --------------------------------------------------------------

  /** hit bookkeeping: id -> { score, byField: Map(field -> Set(term)) } */
  function collect(map, r) {
    let h = map.get(r.id);
    if (!h) {
      h = { score: 0, byField: new Map() };
      map.set(r.id, h);
    }
    h.score += r.score;
    // r.match: { matchedTerm: [field, ...] }
    for (const [term, fields] of Object.entries(r.match || {})) {
      for (const f of fields) {
        if (!h.byField.has(f)) h.byField.set(f, new Set());
        h.byField.get(f).add(term);
      }
    }
  }

  function intersectInto(hits, sub) {
    for (const id of [...hits.keys()]) {
      const s = sub.get(id);
      if (!s) {
        hits.delete(id);
        continue;
      }
      const h = hits.get(id);
      h.score += s.score;
      for (const [f, terms] of s.byField) {
        if (!h.byField.has(f)) h.byField.set(f, new Set());
        terms.forEach((t) => h.byField.get(f).add(t));
      }
    }
  }

  function search(query, records) {
    const { phrases, tags, authors, titleTerms, noteTerms, textTerms, terms } = parseQuery(query);
    const byId = new Map(records.map((r) => [r.id, r]));

    let hits = null; // null = no token search ran yet

    const tokenQueries = [
      [terms, null], // all fields
      [titleTerms, ["threadTitle"]],
      [noteTerms, ["notes"]],
      [textTerms, ["text"]],
    ];
    for (const [qTerms, fields] of tokenQueries) {
      if (!qTerms.length) continue;
      const sub = new Map();
      const opts = fields ? { fields } : undefined;
      for (const r of mini.search(qTerms.join(" "), opts)) collect(sub, r);
      if (hits === null) hits = sub;
      else intersectInto(hits, sub);
    }

    let candidates;
    if (hits !== null) {
      candidates = [...hits.entries()]
        .map(([id, h]) => ({ record: byId.get(id), score: h.score, byField: h.byField }))
        .filter((c) => c.record);
    } else {
      candidates = records.map((r) => ({ record: r, score: 0, byField: new Map() }));
    }

    const out = [];
    for (const c of candidates) {
      const rec = c.record;
      const author = (rec.author || "").toLowerCase();
      const recTags = (rec.tags || []).map((t) => t.toLowerCase());

      if (tags.length && !tags.every((q) => recTags.some((t) => t.startsWith(q)))) continue;
      if (authors.length && !authors.every((q) => author.startsWith(q))) continue;

      if (phrases.length) {
        const noteHay = (rec.notes || []).map((n) => (n.note || "") + "\n" + (n.quote || "")).join("\n");
        const hay = ((rec.text || "") + "\n" + (rec.threadTitle || "") + "\n" + noteHay).toLowerCase();
        if (!phrases.every((p) => hay.includes(p))) continue;
        c.score += phrases.length * 5;
      }

      const byField = {};
      for (const f of FIELDS) byField[f] = [...(c.byField.get(f) || [])];

      out.push({ record: rec, score: c.score, highlight: { byField, phrases } });
    }

    const ranked = hits !== null || phrases.length;
    out.sort((a, b) =>
      ranked
        ? b.score - a.score || b.record.savedAt - a.record.savedAt
        : b.record.savedAt - a.record.savedAt
    );
    return out;
  }

  return { build, upsert, remove, search, parseQuery };
})();
