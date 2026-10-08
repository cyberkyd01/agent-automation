# Panel ↔ engine protocol (v1.2)

The engine (`engine.js`, started by `startEngine({ api, keepAlive })`) owns every open chat: its `Agent`, queue,
transcript, approvals and saving. A side panel is only a view. It connects with
`chrome.runtime.connect({ name: 'panel' })`; any number of panels (one per window) may be connected, and all of
them receive the same events. When none is connected the engine keeps working; approvals and finished/failed
jobs then become desktop notifications.

## Starting

1. Chrome: the panel first sends `chrome.runtime.sendMessage({ to: 'aa-host', op: 'ensureEngine' })`. The service
   worker (`background.js`) creates the offscreen document (`offscreen.html` → `offscreen.js`) if needed and answers
   `{ ok }` once the engine replies to `{ to: 'aa-engine', op: 'ping' }` with `{ ready: true }`. Firefox: the
   background page (`firefox.js`) is both host and engine and answers `{ ok: true }` itself. A failed
   `sendMessage` is ignored; the panel connects anyway and retries with a growing delay.
2. The panel connects the port and sends `hello { windowId }` (its browser window: jobs started from this panel
   work in it, and notifications reopen the side panel there).
3. The engine answers with `snapshot`, then one `items` message per loaded chat.
4. If the port disconnects (the engine document was closed or crashed), the panel reconnects from step 1 and
   rebuilds itself from the new snapshot. A restarted engine restores the open chats from the store; chats that
   were running come back with the "This chat was interrupted. [Continue]" notice and their queues paused.

## Engine → panel

| message | meaning |
|---|---|
| `snapshot { activeId, sessions: State[], drafts: { [id]: { text, pending } } }` | sent once after `hello` |
| `sessions { sessions: State[], activeId }` | the set or order of open chat-tabs changed (new, open, close) |
| `state { s: State }` | one chat's state changed |
| `items { sid, items: Item[], assets: AssetMeta[] }` | a chat's whole transcript (after loading, or a new chat) |
| `item { sid, item }` | add an item, or replace the item with that `id` (streaming text, tool finished, approval …) |
| `notes { id, notes }` | the chat's progress log changed (the agent called `update_progress`); `notes` is also in `State` |
| `itemRemoved { sid, id }` | an item disappears (an empty answer bubble, a prompt handed back) |
| `asset { sid, asset: AssetMeta }` / `assetRemoved { sid, id }` | the chat's assets changed |
| `status { text, kind }` | for the status line (e.g. "Choose a model first" when a queued job cannot start) |
| `draftBack { sid, text, ids }` | a prompt that never reached the history goes back into the message box |
| `focus { sid }` | show this chat (its notification was clicked) |
| `reply { rid, ok, value?, error? }` | the answer to a command that carried `rid` (`error` is a readable message) |

`State = { id, meta: { id, title, createdAt, updatedAt, url, pageTitle }, stored, ready, loadError: { text, retry } | null,
running, asking (number of pending approvals), queue: QueueItem[], notes (the per-chat progress log, '' when none),
paused, drain, saveError: string | null, closeBlocked }`

`Item` (all have `id`, unique within the chat):
- `{ type: 'user', text, atts: [{ id, kind, name, mime, size, src? }] }` — `src` only for v1.0 inline images
- `{ type: 'assistant', content, reasoning, done }` — streamed (`done: false`) at most every 50 ms
- `{ type: 'tool', name, args, state: 'running' | 'ok' | 'error' | 'stopped', ask: { sensitive, tool } | null, result?, images? }`
  — `ask` is set while the tool waits for approval; `result` is capped at 4,000 characters
- `{ type: 'notice', text, kind: 'info' | 'error', actions: [{ label, id }] }` — action ids `continue`, `retry`
- `{ type: 'asset', assetId }`

`AssetMeta = { id, kind, name, mime, size, label, url }` — `url` is an object URL of the asset's Blob made by the
engine; it works in any page of the extension while that engine runs (a reconnect brings new URLs).

## Panel → engine

Every command may carry `rid` to get a `reply`. `id` is a chat id.

| command | does |
|---|---|
| `hello { windowId }` | see above |
| `new { id? }` | open a fresh chat-tab (the panel may choose the id, a UUID, so it can show the tab at once) → `{ id }` |
| `open { id, meta?, replace? }` | open a stored chat (from History); `replace`: a pristine chat to close instead → `{ id }` |
| `activate { id }` / `load { id }` | the panel shows this chat (remembered for the next panel); load its history if needed |
| `close { id, save? }` | stop it if running, save, close → `{ closed }` (`false`: the save failed, the chat stays open with `closeBlocked`) |
| `rename { id, title }` | open or closed chats |
| `delete { id }` | closes it everywhere, then deletes it with its files |
| `flush { id? , timeout? }` | resolves when pending saves are written (before History reads or exports the store) |
| `send { id, text, attachmentIds, qid?, page? }` | run now, or queue it (under `qid`) when the chat is busy → `{ queued, n? }` |
| `batch { id, jobs: (string \| { id, text })[], mode?, page? }` | queue many prompts (under the panel's ids when given) and start when idle → `{ n }` |
| `queue { id, op, itemId? }` | `up`, `down`, `remove`, `edit` (→ `{ text, attachmentIds }`), `clear`, `runNext`, `runAll`, `resume` |
| `stop { id }` | stop the running job |
| `noticeAction { id, itemId, action }` | a notice button (`continue` / `retry`) |
| `approve { id, itemId, answer }` | `allow`, `always`, `deny` for a tool item that is asking |
| `attachReserve { id, name, mime, size }` | name, type, kind and a fresh `img_N` / `file_N` id for a user attachment (rejects when too large) |
| `attach { id, assetId }` | the panel has written the attachment into the store with `store.putAsset`; the engine takes it → `AssetMeta` |
| `discard { id, assetId }` | a draft attachment was removed: deleted unless a queued prompt or the history uses it |
| `notice { id, text, kind }` | add a notice to the transcript (e.g. "could not attach …") |
| `draft { id, text, pending }` | the message being written, kept in the engine so a reopened panel gets it back |
| `retrySave { id }` | after a save error |
| `settings` | reload the settings now (the panel just saved them; the engine also follows `chrome.storage` changes) |

`page: { url, title }` is the panel's active browser tab: the first prompt of a chat records it as the chat's source page.

The panel shows its own actions at once (a new tab under the id it chose, a chat being opened, a queued prompt
under `qid`, a job starting, queue edits) and the engine's next `state` / `sessions` replaces that guess.

## What stays in the panel

- Settings: the panel loads and saves them itself (`loadSettings` / `saveSettings`, direct `chrome.storage`), and
  fetches model lists. The engine reloads them on every `chrome.storage` change and before every job.
- History: listing, searching and exporting read the store directly (after `flush`). Rename and delete go through
  the engine. Import is done by the panel (a big .zip is read in place, never sent over the port); it then sends
  `open` for the first imported chat.
- Attachments: written into the store (IndexedDB, shared by both) by the panel, then handed over with `attach`.

## Notifications (engine → service worker)

Ids: `aa|ask|<chat>|<item>|<window>` (buttons Allow / Deny) and `aa|job|<chat>|<n>|<window>`. Clicking the body
opens the side panel in that window (in the service worker's click handler, which has the user gesture) and the
engine makes that chat the active one; the buttons answer the approval. Shown only while no panel is connected and
`settings.notifications` is on. The toolbar badge shows the number of running chats (amber while one waits for
approval).
