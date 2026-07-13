/* content.js — runs on news.ycombinator.com. Adds a "save" link to every
 * comment header. Works on item pages, comment permalinks, /threads,
 * /newcomments, profile comment listings, etc. */
"use strict";

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const HN = "https://news.ycombinator.com/";

  // ---- page-level thread detection ----------------------------------------

  function pageItemId() {
    const m = location.search.match(/[?&]id=(\d+)/);
    return location.pathname === "/item" && m ? m[1] : null;
  }

  /**
   * Figure out the story (thread) this page belongs to, when the page itself
   * is an item page. Returns {threadId, threadTitle, threadUrl} or null.
   */
  function pageStory() {
    const fat = document.querySelector(".fatitem");
    if (!fat) return null;

    // Case 1: the fatitem is the story itself (title row present).
    const titleLink = fat.querySelector(".athing .titleline > a");
    if (titleLink) {
      const id = fat.querySelector(".athing")?.id || pageItemId();
      return {
        threadId: id || null,
        threadTitle: titleLink.textContent.trim(),
        threadUrl: id ? HN + "item?id=" + id : titleLink.href,
      };
    }

    // Case 2: the fatitem is a comment permalink — HN shows "on: <story>".
    const on = fat.querySelector(".onstory a") || document.querySelector("span.onstory a");
    if (on) {
      const m = on.getAttribute("href")?.match(/id=(\d+)/);
      return {
        threadId: m ? m[1] : null,
        threadTitle: on.textContent.trim(),
        threadUrl: new URL(on.getAttribute("href"), HN).href,
      };
    }
    return null;
  }

  function fallbackStory() {
    const t = document.title.replace(/\s*\|\s*Hacker News\s*$/, "").trim();
    return { threadId: null, threadTitle: t, threadUrl: location.href };
  }

  const PAGE_STORY = pageStory();

  // ---- per-comment scraping ------------------------------------------------

  function commentStory(row) {
    // On /threads and /newcomments each row carries its own "on: story" link.
    const on = row.querySelector(".onstory a");
    if (on) {
      const m = on.getAttribute("href")?.match(/id=(\d+)/);
      return {
        threadId: m ? m[1] : null,
        threadTitle: on.textContent.trim(),
        threadUrl: new URL(on.getAttribute("href"), HN).href,
      };
    }
    return PAGE_STORY || fallbackStory();
  }

  function scrapeComment(row) {
    const id = row.id;
    if (!id || !/^\d+$/.test(id)) return null;

    const author = row.querySelector(".hnuser")?.textContent.trim() || "";
    const ageEl = row.querySelector(".age");
    const ageText = ageEl?.textContent.trim() || "";
    // .age title looks like "2026-07-12T19:23:11 1783891391" on current HN.
    const timeISO = ageEl?.getAttribute("title")?.split(/\s+/)[0] || null;

    const textEl = row.querySelector(".commtext");
    // Clone and drop HN's inline "reply" leftovers if any sneak in.
    let html = "";
    let text = "";
    if (textEl) {
      const clone = textEl.cloneNode(true);
      clone.querySelectorAll(".reply").forEach((n) => n.remove());
      html = clone.innerHTML;
      text = clone.textContent.replace(/\s+/g, " ").trim();
    }

    const story = commentStory(row);

    // Parent id: the "parent" nav link, if present. Its href varies by page:
    // on item pages it's a same-page anchor ("#123..."), on permalink pages
    // an item link ("item?id=123"), and sometimes both ("item?id=story#123",
    // where the fragment is the parent comment). Fragment wins.
    let parentId = null;
    for (const a of row.querySelectorAll(".comhead a")) {
      if (a.textContent.trim() === "parent") {
        const href = a.getAttribute("href") || "";
        const frag = href.match(/#(\d+)/);
        const qid = href.match(/[?&]id=(\d+)/);
        parentId = frag ? frag[1] : qid ? qid[1] : null;
        break;
      }
    }

    return {
      id,
      author,
      timeISO,
      ageText,
      text,
      html,
      threadId: story.threadId,
      threadTitle: story.threadTitle,
      threadUrl: story.threadUrl,
      commentUrl: HN + "item?id=" + id,
      parentId,
      tags: [],
    };
  }

  // ---- UI injection ----------------------------------------------------------

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        const p = api.runtime.sendMessage(msg, (resp) => resolve(resp));
        // Firefox returns a promise; Chrome uses the callback.
        if (p && typeof p.then === "function") p.then(resolve).catch(() => resolve(null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function makeLink(row) {
    const comhead = row.querySelector(".comhead");
    if (!comhead || comhead.querySelector(".hncs-save")) return null;

    const sep = document.createTextNode(" | ");
    const a = document.createElement("a");
    a.href = "#";
    a.className = "hncs-save";
    a.textContent = "save";
    a.title = "Save this comment (HN Comment Saver)";

    a.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (a.dataset.busy) return;
      a.dataset.busy = "1";

      if (a.classList.contains("hncs-saved")) {
        const resp = await sendMessage({ type: "unsave", id: row.id });
        if (resp && resp.ok) setState(a, false);
      } else {
        const record = scrapeComment(row);
        if (!record) return;
        a.textContent = "saving…";
        const resp = await sendMessage({ type: "save", record });
        if (resp && resp.ok) {
          setState(a, true);
        } else {
          a.textContent = "save failed";
          setTimeout(() => setState(a, false), 1500);
        }
      }
      delete a.dataset.busy;
    });

    comhead.appendChild(sep);
    comhead.appendChild(a);
    return a;
  }

  function setState(a, saved) {
    a.classList.toggle("hncs-saved", saved);
    a.textContent = saved ? "saved ✓" : "save";
    a.title = saved
      ? "Saved — click to remove (HN Comment Saver)"
      : "Save this comment (HN Comment Saver)";
  }

  async function init() {
    const rows = Array.from(document.querySelectorAll("tr.athing.comtr"));
    // A comment-permalink page: the fatitem row is also a comment but has no
    // .comtr class; include it if it looks like a comment.
    const fatRow = document.querySelector(".fatitem tr.athing");
    if (fatRow && fatRow.querySelector(".commtext") && !rows.includes(fatRow)) {
      rows.unshift(fatRow);
    }
    if (!rows.length) return;

    const links = new Map();
    for (const row of rows) {
      const a = makeLink(row);
      if (a) links.set(row.id, a);
    }

    const resp = await sendMessage({ type: "checkSaved", ids: [...links.keys()] });
    if (resp && resp.ok) {
      for (const id of resp.saved) {
        const a = links.get(id);
        if (a) setState(a, true);
      }
    }
  }

  init();
})();
