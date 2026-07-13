/* background.js — event page. db.js is loaded before this (see manifest). */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

// Ask Firefox to mark our storage non-evictable (belt & suspenders for IndexedDB).
try {
  navigator.storage?.persist?.();
} catch (e) {
  /* non-fatal */
}

// ---- auto-backup -------------------------------------------------------------
//
// Design: an hourly *check* alarm (cheap). A backup actually runs only when
// all of: enabled, >= 24h since the last one, and the data revision counter
// moved since the last one. Files go to Downloads/hn-comment-saver/ as
// weekday slots (backup-mon.json ... backup-sun.json) written with
// conflictAction "overwrite" — a fixed set of 7 files, up to a week of
// history, zero cleanup bookkeeping. Because alarms don't fire while the
// browser is closed, every background wake-up also runs the same check
// (catch-up for laptop-lid schedules).

const BACKUP_ALARM = "hncs-backup-check";
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_SLOTS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pendingRevoke = new Map(); // download id -> blob URL

async function getBackupState() {
  const d = await api.storage.local.get({
    backupEnabled: true,
    lastBackupAt: 0,
    lastBackupRev: -1,
    lastBackupFile: "",
    lastBackupError: "",
    hncsRev: 0,
  });
  return d;
}

async function ensureAlarm() {
  const existing = await api.alarms.get(BACKUP_ALARM);
  if (!existing) api.alarms.create(BACKUP_ALARM, { periodInMinutes: 60 });
}

async function maybeBackup() {
  const s = await getBackupState();
  if (!s.backupEnabled) return;
  if (Date.now() - s.lastBackupAt < BACKUP_INTERVAL_MS) return;
  if (s.hncsRev === s.lastBackupRev) return; // nothing changed since last backup
  await runBackup(null);
}

/** slot: explicit name ("backup-manual") or null for today's weekday slot. */
async function runBackup(slot) {
  const s = await getBackupState();
  const comments = await hncsDB.exportAll();
  const payload = {
    format: "hn-comment-saver",
    version: 1,
    exportedAt: new Date().toISOString(),
    kind: slot ? "manual-backup" : "auto-backup",
    count: comments.length,
    comments,
  };
  const name = slot || "backup-" + DAY_SLOTS[new Date().getDay()];
  const filename = "hn-comment-saver/" + name + ".json";
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" }),
  );
  try {
    const id = await api.downloads.download({
      url,
      filename,
      conflictAction: "overwrite",
      saveAs: false,
    });
    pendingRevoke.set(id, url);
    await api.storage.local.set({
      lastBackupAt: Date.now(),
      lastBackupRev: s.hncsRev,
      lastBackupFile: filename,
      lastBackupError: "",
    });
    return { ok: true, at: Date.now(), file: filename, count: comments.length };
  } catch (e) {
    URL.revokeObjectURL(url);
    const error = String(e && e.message ? e.message : e);
    await api.storage.local.set({ lastBackupError: error });
    return { ok: false, error };
  }
}

api.downloads.onChanged.addListener((delta) => {
  const url = pendingRevoke.get(delta.id);
  if (!url || !delta.state) return;
  if (
    delta.state.current === "complete" ||
    delta.state.current === "interrupted"
  ) {
    URL.revokeObjectURL(url);
    pendingRevoke.delete(delta.id);
  }
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) maybeBackup();
});

// Every event-page wake: make sure the alarm exists, catch up if overdue.
ensureAlarm();
maybeBackup();

// ---- toolbar / messages --------------------------------------------------------

// Toolbar button opens the manager page.
api.action.onClicked.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL("manager.html") });
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "save": {
          const id = await hncsDB.saveComment(msg.record);
          sendResponse({ ok: true, id });
          break;
        }
        case "unsave": {
          await hncsDB.deleteComment(msg.id);
          sendResponse({ ok: true });
          break;
        }
        case "checkSaved": {
          const all = new Set(await hncsDB.getAllIds());
          const saved = (msg.ids || []).filter((id) => all.has(id));
          sendResponse({ ok: true, saved });
          break;
        }
        case "openManager": {
          api.tabs.create({ url: api.runtime.getURL("manager.html") });
          sendResponse({ ok: true });
          break;
        }
        case "backupStatus": {
          const s = await getBackupState();
          sendResponse({
            ok: true,
            enabled: s.backupEnabled,
            lastBackupAt: s.lastBackupAt,
            lastBackupFile: s.lastBackupFile,
            lastBackupError: s.lastBackupError,
            dirty: s.hncsRev !== s.lastBackupRev,
          });
          break;
        }
        case "backupToggle": {
          await api.storage.local.set({ backupEnabled: !!msg.enabled });
          if (msg.enabled) maybeBackup(); // may be overdue
          sendResponse({ ok: true, enabled: !!msg.enabled });
          break;
        }
        case "backupNow": {
          sendResponse(await runBackup("backup-manual"));
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: String(e && e.message ? e.message : e),
      });
    }
  })();
  return true; // keep the channel open for the async response
});
