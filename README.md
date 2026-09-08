# HN Comment Saver

A self-contained Firefox extension that saves Hacker News comments locally, lets you tag them, and finds them again with proper full-text search: token matching with prefix + word-level typo tolerance, BM25-style ranking, exact-phrase support, and match highlighting.

<img width="2904" height="1592" alt="ext" src="https://github.com/user-attachments/assets/eaf83f61-cb98-4130-b5fa-e670bcaf3a3b" />

https://github.com/user-attachments/assets/d2bfba2f-13f0-4c47-84d8-9660dcff4641

## Install

**Temporary (any Firefox):**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick `manifest.json` inside this folder

Temporary add-ons are removed when Firefox closes, but your saved comments are **not** - they live in IndexedDB under the extension's ID and survive reloads of the add-on.

## Use

- On any HN page (threads, item pages, comment permalinks, `/threads`, `/newcomments`), every comment header gets a **save** link. Click to save; it turns into **saved ✓** (click again to unsave). Already-saved comments are marked when the page loads.
- Click the toolbar button to open the **Saved Comments** manager.

### Search syntax

| token | aliases | meaning |
|---|---|---|
| `plain words` | | token search across text, title, author, tags, notes - prefix matching (`lobot` finds "lobotomized") with word-level typo tolerance |
| `"exact"` | | verbatim substring, case-insensitive (body, title, notes) |
| `#tag` | `tag:` `tags:` | must have a tag starting with the value |
| `by:user` | `author:` `user:` | author must start with the value |
| `thread:word` | `title:` | token search restricted to the thread title |
| `note:word` | `notes:` | token search restricted to your notes |
| `text:word` | `body:` `comment:` | token search restricted to the comment body |

All tokens must match (AND). Ranking is MiniSearch's BM25-style relevance with field boosts (author 3× > tags 2.5× > title 2× > body). Matched words and phrases are **highlighted** in the results - including the expansions of prefix/typo matches - and highlighting is field-accurate: a `thread:` match only lights up the title, a `note:` match only the note, never the comment body. The tag bar below the search box also toggles tag filters by click.

### Highlights & notes

Select any text inside a saved comment in the manager and an **✎ add note** bubble appears. The highlighted passage gets a dashed-orange underline, and your notes are listed under the comment (with edit/delete). Clicking a highlight jumps to its note.

Anchoring is Web-Annotation style: each note stores the exact quote, a short prefix for disambiguation, and a character-offset hint - resolution tries offset → prefix+quote → first quote occurrence, so highlights survive re-renders and re-imports. If a quote can't be located (it can't change, since saved comments are immutable, but belt and suspenders), the note still appears in the list.

Notes are indexed: plain search terms match note text (boosted above body text), `note:` restricts to notes, and `"phrases"` match inside notes too. Matches are highlighted in both the comment and the note rows. Notes ride along in export/import; importing into an existing collection unions notes per comment.

### Tags

`edit tags` on any saved comment opens an inline editor (comma-separated, Enter saves, Esc cancels). As you type, existing tags matching the current prefix are suggested with their usage counts (most-used first, tags already on the comment excluded): ↑/↓ to pick, Tab or Enter to complete, Esc to dismiss. Tags are normalized to lowercase, spaces become `-`.

### Import / export

- **export** downloads a JSON file with the comment HTML in plain text (readable, diffable, greppable).
- **import** accepts that file (or any JSON array of records). Existing comments are kept; their tags are merged (union). New ones are added. Nothing is overwritten destructively.

## Storage design

- **IndexedDB**, not `storage.local` - binary-capable, indexed, no JSON re-stringify of the whole dataset on every write.
- The comment **HTML is gzip-compressed** (`CompressionStream`) at save time and stored as an `ArrayBuffer` (typically 3–5× smaller). It is only decompressed when rendered or exported.
- A **plain-text copy stays uncompressed** - it's small and it's what gets indexed, so searching never touches the compressed blobs. The MiniSearch inverted index is built in memory when the manager opens and kept in sync on save/delete/tag edits.
- Indexes on `savedAt`, `threadId`, `author`, and `tags` (multiEntry).

## Auto-backups

Daily backups are **on by default** and land in `Downloads/hn-comment-saver/` as weekday slots - `backup-mon.json` … `backup-sun.json`, each written with overwrite (a fixed set of 7 files, up to a week of history, no accumulation). A backup only runs when something actually changed since the last one (every write bumps a revision counter), checked hourly and on browser startup, so closed-laptop days are caught up. The **backups** link in the manager shows status, on/off, and a "backup now" button (which writes `backup-manual.json`). Backups are ordinary export files - restore any of them with the import button. The extension also requests persistent (non-evictable) storage via `navigator.storage.persist()`.

## Privacy

Everything is local. The extension makes zero network requests and only runs its content script on `news.ycombinator.com`. Backups are written only to your own Downloads folder via the browser's downloads API.

## LICENSE

MIT
