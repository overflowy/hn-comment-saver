/* manager.js — the saved-comments UI. Uses hncsDB (db.js) and hncsFuzzy. */
"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#list");
  const tagbarEl = $("#tagbar");
  const emptyEl = $("#empty");
  const qEl = $("#q");
  const hintEl = $("#search-hint");
  const countEl = $("#stat-count");

  /** In-memory copy of all records (html still compressed). */
  let all = [];
  let activeTags = new Set();

  // ---- sanitizer -----------------------------------------------------------
  // HN's HTML is already tame, but never trust stored markup blindly.
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    doc
      .querySelectorAll("script, style, iframe, object, embed, link, meta")
      .forEach((n) => n.remove());
    for (const el of doc.body.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        if (
          (name === "href" || name === "src") &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === "A") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
    return doc.body;
  }

  // ---- highlighting ----------------------------------------------------------

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /**
   * Wrap matches in <mark class="hl"> across the text nodes of `root`.
   * terms: whole indexed words MiniSearch matched (word-boundary anchored);
   * phrases: verbatim strings (matched anywhere, case-insensitive).
   */
  function highlight(root, terms, phrases) {
    const parts = [
      ...(phrases || []).filter(Boolean).map((p) => escRe(p)),
      ...(terms || []).filter(Boolean).map((t) => "\\b" + escRe(t)),
    ];
    if (!parts.length) return;
    const re = new RegExp("(" + parts.join("|") + ")", "gi");

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest("mark.hl")) continue;
      if (re.test(n.nodeValue)) nodes.push(n);
      re.lastIndex = 0;
    }

    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      const str = node.nodeValue;
      let last = 0;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(str))) {
        if (m.index > last)
          frag.appendChild(document.createTextNode(str.slice(last, m.index)));
        const mark = document.createElement("mark");
        mark.className = "hl";
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++; // safety against zero-width loops
      }
      if (last < str.length)
        frag.appendChild(document.createTextNode(str.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // ---- annotations (highlight + note) ----------------------------------------
  //
  // A note anchors to text with the W3C-annotation-style trio: exact quote,
  // a short prefix for disambiguation, and a char-offset hint into the
  // comment's textContent. Anchoring tries offset → prefix+quote → quote.

  const PREFIX_LEN = 30;

  function resolveAnchor(bodyText, note) {
    const q = note.quote || "";
    if (!q) return null;
    if (
      Number.isInteger(note.start) &&
      bodyText.substr(note.start, q.length) === q
    ) {
      return [note.start, note.start + q.length];
    }
    if (note.prefix) {
      const i = bodyText.indexOf(note.prefix + q);
      if (i !== -1)
        return [i + note.prefix.length, i + note.prefix.length + q.length];
    }
    const i = bodyText.indexOf(q);
    if (i !== -1) return [i, i + q.length];
    return null; // unanchored — still shown in the notes list
  }

  /** Wrap [start, end) of root's concatenated text in marks (per text node). */
  function wrapTextRange(root, start, end, makeMark) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0;
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      const a = Math.max(start - pos, 0);
      const b = Math.min(end - pos, len);
      if (a < b) targets.push({ node: n, a, b });
      pos += len;
      if (pos >= end) break;
    }
    for (const { node, a, b } of targets) {
      const rest = node.splitText(a);
      rest.splitText(b - a);
      const mark = makeMark();
      rest.parentNode.insertBefore(mark, rest);
      mark.appendChild(rest);
    }
  }

  function applyAnnotations(body, rec, item) {
    const bodyText = body.textContent;
    for (const note of rec.notes || []) {
      const range = resolveAnchor(bodyText, note);
      if (!range) continue;
      wrapTextRange(body, range[0], range[1], () => {
        const m = document.createElement("mark");
        m.className = "note";
        m.dataset.nid = note.id;
        m.title = note.note || "";
        m.addEventListener("click", () => {
          const row = item.querySelector(`.note-row[data-nid="${note.id}"]`);
          if (row) {
            row.scrollIntoView({ block: "nearest" });
            row.classList.remove("flash");
            void row.offsetWidth; // restart animation
            row.classList.add("flash");
          }
        });
        return m;
      });
    }
  }

  async function persistNotes(item, rec) {
    rec.notes = (await hncsDB.setNotes(rec.id, rec.notes)) || rec.notes;
    hncsSearch.upsert(rec);
    await rerenderItem(item, rec);
  }

  async function rerenderItem(item, rec) {
    const fresh = await renderItem(rec, item._hl);
    if (item.classList.contains("collapsed")) {
      fresh.classList.add("collapsed");
      const t = fresh.querySelector(".toggle");
      if (t) t.textContent = "[+]";
    }
    item.replaceWith(fresh);
  }

  function renderNotes(item, rec) {
    const old = item.querySelector(".notes");
    if (old) old.remove();
    const notes = rec.notes || [];
    if (!notes.length) return;

    const wrap = document.createElement("div");
    wrap.className = "notes";
    for (const note of notes) {
      const row = document.createElement("div");
      row.className = "note-row";
      row.dataset.nid = note.id;

      const quote = document.createElement("span");
      quote.className = "note-quote";
      const q = note.quote || "";
      quote.textContent =
        "\u201C" + (q.length > 90 ? q.slice(0, 90) + "\u2026" : q) + "\u201D";
      quote.title = q;

      const text = document.createElement("span");
      text.className = "note-text";
      text.textContent = note.note || "";

      const ops = document.createElement("span");
      ops.className = "note-ops";
      const edit = document.createElement("a");
      edit.href = "#";
      edit.textContent = "edit";
      edit.addEventListener("click", (e) => {
        e.preventDefault();
        openNoteEditor(row, note.note || "", async (val) => {
          note.note = val;
          await persistNotes(item, rec);
        });
      });
      const del = document.createElement("a");
      del.href = "#";
      del.textContent = "delete";
      del.className = "danger";
      del.addEventListener("click", async (e) => {
        e.preventDefault();
        rec.notes = (rec.notes || []).filter((x) => x.id !== note.id);
        await persistNotes(item, rec);
        toast("note deleted");
      });
      ops.append(edit, " | ", del);

      row.append(quote, " \u2014 ", text, " ", ops);
      wrap.appendChild(row);
    }
    item.appendChild(wrap);
  }

  /** Inline textarea editor, used for both new notes and edits. */
  function openNoteEditor(anchorEl, initial, onSave) {
    if (anchorEl.parentNode.querySelector(".note-editor")) return;
    const box = document.createElement("div");
    box.className = "note-editor";
    const ta = document.createElement("textarea");
    ta.value = initial;
    ta.placeholder = "your note\u2026";
    ta.rows = 2;
    const save = document.createElement("a");
    save.href = "#";
    save.textContent = "save note";
    const cancel = document.createElement("a");
    cancel.href = "#";
    cancel.textContent = "cancel";
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "ctrl+enter to save \u00b7 esc to cancel";
    const bar = document.createElement("div");
    bar.className = "note-editor-bar";
    bar.append(save, " | ", cancel, " ", hint);
    box.append(ta, bar);
    anchorEl.after(box);
    ta.focus();

    const doSave = () => {
      const val = ta.value.trim();
      box.remove();
      onSave(val);
    };
    save.addEventListener("click", (e) => (e.preventDefault(), doSave()));
    cancel.addEventListener("click", (e) => (e.preventDefault(), box.remove()));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doSave();
      else if (e.key === "Escape") box.remove();
    });
  }

  // ---- selection -> "add note" bubble -----------------------------------------

  let pendingSel = null; // {item, rec, body, start, end}
  const noteBtn = document.createElement("a");
  noteBtn.id = "notebtn";
  noteBtn.href = "#";
  noteBtn.textContent = "\u270E add note";
  noteBtn.hidden = true;
  document.body.appendChild(noteBtn);

  function selectionOffsets(body, range) {
    const pre = range.cloneRange();
    pre.selectNodeContents(body);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    return [start, start + range.toString().length];
  }

  document.addEventListener("mouseup", (e) => {
    if (e.target === noteBtn || noteBtn.contains(e.target)) return;
    // Defer so the selection object is final.
    setTimeout(() => {
      const sel = window.getSelection();
      noteBtn.hidden = true;
      pendingSel = null;
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const body =
        range.commonAncestorContainer.nodeType === 1
          ? range.commonAncestorContainer.closest(".commtext")
          : range.commonAncestorContainer.parentElement?.closest(".commtext");
      if (!body) return;
      const item = body.closest(".item");
      const rec = all.find((r) => r.id === item?.dataset.id);
      if (!item || !rec) return;

      const [start, end] = selectionOffsets(body, range);
      if (end - start < 1) return;
      pendingSel = { item, rec, body, start, end };

      const rect = range.getBoundingClientRect();
      noteBtn.style.left = window.scrollX + rect.left + rect.width / 2 + "px";
      noteBtn.style.top = window.scrollY + rect.bottom + 4 + "px";
      noteBtn.hidden = false;
    }, 0);
  });

  noteBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
  noteBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (!pendingSel) return;
    const { item, rec, body, start, end } = pendingSel;
    noteBtn.hidden = true;
    pendingSel = null;

    const bodyText = body.textContent;
    const quote = bodyText.slice(start, end);
    const prefix = bodyText.slice(Math.max(0, start - PREFIX_LEN), start);
    window.getSelection()?.removeAllRanges();

    openNoteEditor(body, "", async (val) => {
      rec.notes = [
        ...(rec.notes || []),
        {
          id:
            (crypto.randomUUID && crypto.randomUUID()) ||
            String(Date.now()) + Math.random().toString(36).slice(2),
          quote,
          prefix,
          start,
          note: val,
          createdAt: Date.now(),
        },
      ];
      await persistNotes(item, rec);
      toast("note added");
    });
  });

  // ---- rendering -----------------------------------------------------------

  function fmtDate(ms) {
    try {
      return new Date(ms).toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }

  /** All tags in use, as [tag, count] sorted by count desc, then name. */
  function tagCounts() {
    const counts = new Map();
    for (const rec of all)
      for (const t of rec.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }

  function renderTagbar() {
    const tags = tagCounts();

    tagbarEl.textContent = "";
    if (!tags.length) return;
    const label = document.createElement("span");
    label.textContent = "tags: ";
    tagbarEl.appendChild(label);

    for (const [tag, n] of tags) {
      const a = document.createElement("a");
      a.href = "#";
      a.className = "tag" + (activeTags.has(tag) ? " active" : "");
      a.innerHTML = "";
      a.append("#" + tag, " ");
      const nEl = document.createElement("span");
      nEl.className = "n";
      nEl.textContent = "(" + n + ")";
      a.appendChild(nEl);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        activeTags.has(tag) ? activeTags.delete(tag) : activeTags.add(tag);
        refresh();
      });
      tagbarEl.appendChild(a);
    }
  }

  function comheadLink(text, href, cls) {
    const a = document.createElement("a");
    a.textContent = text;
    if (href) {
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    } else {
      a.href = "#";
    }
    if (cls) a.className = cls;
    return a;
  }

  async function renderItem(rec, hl) {
    const item = document.createElement("div");
    item.className = "item";
    item.dataset.id = rec.id;

    // --- comhead
    const head = document.createElement("div");
    head.className = "comhead";

    const toggle = document.createElement("span");
    toggle.className = "toggle";
    toggle.textContent = "[–]";
    toggle.addEventListener("click", () => {
      const c = item.classList.toggle("collapsed");
      toggle.textContent = c ? "[+]" : "[–]";
    });
    head.appendChild(toggle);

    const user = comheadLink(
      rec.author || "unknown",
      "https://news.ycombinator.com/user?id=" +
        encodeURIComponent(rec.author || ""),
    );
    user.className = "hnuser";
    head.appendChild(user);
    head.append(" ");

    head.appendChild(
      comheadLink(rec.ageText || fmtDate(rec.savedAt), rec.commentUrl),
    );
    if (rec.parentId) {
      head.append(" | ");
      head.appendChild(
        comheadLink(
          "parent",
          "https://news.ycombinator.com/item?id=" + rec.parentId,
        ),
      );
    }
    head.append(" | on: ");
    head.appendChild(
      comheadLink(rec.threadTitle || "(thread)", rec.threadUrl, "storyline"),
    );
    head.append(" | saved " + fmtDate(rec.savedAt) + " | ");

    // tags inline
    const tagsSpan = document.createElement("span");
    tagsSpan.className = "tags";
    renderInlineTags(tagsSpan, rec);
    head.appendChild(tagsSpan);

    const editA = comheadLink("edit tags");
    editA.className = "op";
    editA.addEventListener("click", (e) => {
      e.preventDefault();
      openTagEditor(item, rec, tagsSpan);
    });
    head.append(" | ");
    head.appendChild(editA);

    const delA = comheadLink("delete");
    delA.className = "op danger";
    delA.addEventListener("click", async (e) => {
      e.preventDefault();
      if (delA.dataset.armed) {
        await hncsDB.deleteComment(rec.id);
        hncsSearch.remove(rec.id);
        all = all.filter((r) => r.id !== rec.id);
        item.remove();
        renderTagbar();
        updateCount();
        toast("deleted");
      } else {
        delA.dataset.armed = "1";
        delA.textContent = "confirm delete?";
        setTimeout(() => {
          delete delA.dataset.armed;
          delA.textContent = "delete";
        }, 2500);
      }
    });
    head.append(" | ");
    head.appendChild(delA);

    item.appendChild(head);

    // --- body (decompress lazily but immediately; cheap per item)
    const body = document.createElement("div");
    body.className = "commtext";
    item.appendChild(body);
    const full = await hncsDB.inflate({ ...rec });
    const clean = sanitize(full.html || full.text || "");
    while (clean.firstChild) body.appendChild(clean.firstChild);

    item._hl = hl || null;
    applyAnnotations(body, rec, item);
    renderNotes(item, rec);

    if (hl) {
      const f = hl.byField || {};
      const phrases = hl.phrases || [];
      // Each element is only marked with terms that matched in ITS field —
      // a thread:-restricted hit never lights up the comment body.
      highlight(body, f.text, phrases);
      highlight(user, f.author, []);
      const story = head.querySelector(".storyline");
      if (story) highlight(story, f.threadTitle, phrases);
      const notesEl = item.querySelector(".notes");
      if (notesEl) highlight(notesEl, f.notes, phrases);
      const tagsEl = head.querySelector(".tags");
      if (tagsEl) highlight(tagsEl, f.tags, []);
    }

    return item;
  }

  function renderInlineTags(span, rec) {
    span.textContent = "";
    if (!rec.tags || !rec.tags.length) {
      span.append("no tags");
      return;
    }
    rec.tags.forEach((t, i) => {
      const a = comheadLink("#" + t);
      a.addEventListener("click", (e) => {
        e.preventDefault();
        activeTags = new Set([t]);
        refresh();
      });
      span.appendChild(a);
      if (i < rec.tags.length - 1) span.append(" ");
    });
  }

  function openTagEditor(item, rec, tagsSpan) {
    if (item.querySelector(".tag-editor")) return;
    const wrap = document.createElement("div");
    wrap.className = "tag-editor";
    const input = document.createElement("input");
    input.value = (rec.tags || []).join(", ");
    input.placeholder = "comma-separated tags";
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "enter to save · esc to cancel · tab to complete";
    const list = document.createElement("div");
    list.className = "tag-suggest";
    list.hidden = true;
    wrap.append(input, hint, list);
    item.insertBefore(wrap, item.querySelector(".commtext"));
    input.focus();
    input.select();

    // ---- autocomplete over the comma-separated segment at the caret ----
    const MAX_SUGGEST = 8;
    let suggestions = []; // [tag, count]
    let active = -1;

    // Bounds of the segment containing the caret, in input.value. Uses the
    // selection end so a fully selected value (editor just opened) resolves
    // to the last segment rather than the first.
    function segmentAt() {
      const pos = input.selectionEnd;
      const v = input.value;
      const start = v.lastIndexOf(",", pos - 1) + 1;
      const endIdx = v.indexOf(",", pos);
      const end = endIdx === -1 ? v.length : endIdx;
      return { start, end, raw: v.slice(start, end) };
    }

    function otherTags(seg) {
      const v = input.value;
      const rest = v.slice(0, seg.start) + "," + v.slice(seg.end);
      return new Set(hncsDB.normalizeTags(rest.split(",")));
    }

    function closeSuggest() {
      suggestions = [];
      active = -1;
      list.hidden = true;
      list.textContent = "";
    }

    function updateSuggest() {
      const seg = segmentAt();
      const prefix = hncsDB.normalizeTags([seg.raw])[0] || "";
      const taken = otherTags(seg);
      suggestions = tagCounts()
        .filter(([t]) => t.startsWith(prefix) && t !== prefix && !taken.has(t))
        .slice(0, MAX_SUGGEST);
      if (!suggestions.length) return closeSuggest();

      active = 0;
      list.textContent = "";
      suggestions.forEach(([t, n], i) => {
        const row = document.createElement("div");
        row.className = "s" + (i === active ? " active" : "");
        row.append("#" + t, " ");
        const nEl = document.createElement("span");
        nEl.className = "n";
        nEl.textContent = "(" + n + ")";
        row.appendChild(nEl);
        // mousedown, not click: click would blur the input first.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          accept(i);
        });
        row.addEventListener("mousemove", () => setActive(i));
        list.appendChild(row);
      });
      list.hidden = false;
    }

    function setActive(i) {
      active = (i + suggestions.length) % suggestions.length;
      list.querySelectorAll(".s").forEach((el, j) =>
        el.classList.toggle("active", j === active),
      );
    }

    // Replace the caret's segment with the chosen tag and start a new one.
    function accept(i) {
      const [tag] = suggestions[i] || [];
      if (!tag) return;
      const seg = segmentAt();
      const before = input.value.slice(0, seg.start).trimEnd();
      const after = input.value.slice(seg.end).replace(/^\s*,?\s*/, "");
      const head = (before ? before + " " : "") + tag + ", ";
      input.value = head + after;
      input.setSelectionRange(head.length, head.length);
      closeSuggest();
    }

    async function save() {
      const tags = await hncsDB.setTags(rec.id, input.value.split(","));
      rec.tags = tags || [];
      hncsSearch.upsert(rec);
      renderInlineTags(tagsSpan, rec);
      renderTagbar();
      wrap.remove();
      toast("tags saved");
    }

    input.addEventListener("input", updateSuggest);
    input.addEventListener("blur", closeSuggest);

    input.addEventListener("keydown", (e) => {
      const open = !list.hidden;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        open ? setActive(active + 1) : updateSuggest();
      } else if (e.key === "ArrowUp" && open) {
        e.preventDefault();
        setActive(active - 1);
      } else if (e.key === "Tab" && open) {
        e.preventDefault();
        accept(active);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter completes when a suggestion is highlighted, otherwise saves.
        open ? accept(active) : save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // First Esc dismisses the suggestions, second cancels the editor.
        open ? closeSuggest() : wrap.remove();
      }
    });
  }

  // ---- search / refresh ------------------------------------------------------

  let renderSeq = 0;
  async function refresh() {
    const seq = ++renderSeq;
    const q = qEl.value;

    let results;
    if (q.trim()) {
      results = hncsSearch
        .search(q, all)
        .map((r) => ({ record: r.record, hl: r.highlight }));
    } else {
      results = [...all]
        .sort((a, b) => b.savedAt - a.savedAt)
        .map((r) => ({ record: r, hl: null }));
    }
    if (activeTags.size) {
      results = results.filter((r) =>
        [...activeTags].every((t) => (r.record.tags || []).includes(t)),
      );
    }

    hintEl.textContent =
      q.trim() || activeTags.size
        ? results.length + " match" + (results.length === 1 ? "" : "es")
        : "";
    renderTagbar();

    listEl.textContent = "";
    emptyEl.hidden = all.length > 0;

    // Render in small batches so big collections stay snappy.
    const BATCH = 25;
    for (let i = 0; i < results.length; i += BATCH) {
      if (seq !== renderSeq) return; // superseded by a newer refresh
      const items = await Promise.all(
        results.slice(i, i + BATCH).map((r) => renderItem(r.record, r.hl)),
      );
      if (seq !== renderSeq) return;
      items.forEach((el) => listEl.appendChild(el));
      if (i + BATCH < results.length) await new Promise((r) => setTimeout(r));
    }
  }

  function updateCount() {
    countEl.textContent = String(all.length);
    emptyEl.hidden = all.length > 0;
  }

  let debounceT = null;
  qEl.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(refresh, 120);
  });

  // ---- import / export --------------------------------------------------------

  $("#btn-export").addEventListener("click", async (e) => {
    e.preventDefault();
    const comments = await hncsDB.exportAll();
    const payload = {
      format: "hn-comment-saver",
      version: 1,
      exportedAt: new Date().toISOString(),
      count: comments.length,
      comments,
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "hn-saved-comments-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("exported " + comments.length + " comments");
  });

  $("#btn-import").addEventListener("click", (e) => {
    e.preventDefault();
    $("#import-file").click();
  });

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const records = Array.isArray(data) ? data : data.comments;
      if (!Array.isArray(records)) throw new Error("no comments array found");
      const res = await hncsDB.importAll(records);
      await load();
      toast(
        `imported: ${res.added} new, ${res.merged} tag-merged, ${res.skipped} skipped`,
      );
    } catch (err) {
      toast("import failed: " + err.message);
    }
  });

  // ---- toast ----------------------------------------------------------------

  let toastT = null;
  function toast(msg) {
    let el = $("#toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastT);
    toastT = setTimeout(() => (el.style.display = "none"), 2600);
  }

  // ---- boot -------------------------------------------------------------------

  async function load() {
    all = await hncsDB.getAllMeta();
    hncsSearch.build(all);
    updateCount();
    await refresh();
  }

  load();
})();

/* ---- search help toggle (appended) ---- */
(() => {
  const toggle = document.querySelector("#help-toggle");
  const panel = document.querySelector("#help-panel");
  if (!toggle || !panel) return;
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    panel.hidden = !panel.hidden;
    toggle.classList.toggle("open", !panel.hidden);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      panel.hidden = true;
      toggle.classList.remove("open");
    }
  });
})();

/* ---- backups panel (appended) ---- */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const btn = document.querySelector("#btn-backups");
  const panel = document.querySelector("#backup-panel");
  const statusEl = document.querySelector("#backup-status");
  const toggleEl = document.querySelector("#backup-toggle");
  const nowEl = document.querySelector("#backup-now");
  if (!btn || !panel) return;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        const p = api.runtime.sendMessage(msg, (r) => resolve(r));
        if (p && typeof p.then === "function")
          p.then(resolve).catch(() => resolve(null));
      } catch {
        resolve(null);
      }
    });

  function renderStatus(s) {
    if (!s || !s.ok) {
      statusEl.textContent = "status unavailable";
      return;
    }
    toggleEl.textContent = s.enabled ? "disable" : "enable";
    const bits = [];
    bits.push("auto-backup: " + (s.enabled ? "on" : "off"));
    if (s.lastBackupAt) {
      bits.push(
        "last: " +
          new Date(s.lastBackupAt).toLocaleString() +
          (s.lastBackupFile ? " \u2192 " + s.lastBackupFile : ""),
      );
    } else {
      bits.push("last: never");
    }
    statusEl.textContent = bits.join(" \u00b7 ");
    if (s.dirty && s.enabled) {
      const d = document.createElement("span");
      d.className = "dirty";
      d.textContent = " \u00b7 changes since last backup";
      statusEl.appendChild(d);
    }
    if (s.lastBackupError) {
      const e = document.createElement("div");
      e.className = "err";
      e.textContent = "last error: " + s.lastBackupError;
      statusEl.appendChild(e);
    }
  }

  async function refreshStatus() {
    renderStatus(await send({ type: "backupStatus" }));
  }

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await refreshStatus();
  });

  toggleEl.addEventListener("click", async (e) => {
    e.preventDefault();
    const s = await send({ type: "backupStatus" });
    await send({ type: "backupToggle", enabled: !(s && s.enabled) });
    await refreshStatus();
  });

  nowEl.addEventListener("click", async (e) => {
    e.preventDefault();
    nowEl.textContent = "backing up\u2026";
    const r = await send({ type: "backupNow" });
    nowEl.textContent = "backup now";
    if (r && r.ok) {
      await refreshStatus();
    } else {
      statusEl.textContent =
        "backup failed: " + ((r && r.error) || "unknown error");
      statusEl.className = "err";
    }
  });

  // Persistent-storage request from a visible page has the best grant odds.
  try {
    navigator.storage?.persist?.();
  } catch {}
})();
