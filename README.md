# Agent Automation

An AI agent in Chrome's side panel. Connect a local model (LM Studio, Ollama) or any cloud API, pick a model, and ask it to work on the page beside it: read it, click, type, fill forms, reply to enquiries, or apply the same change across many rows. It can also research the web in other tabs, generate and edit images, and act as a general assistant for questions that have nothing to do with the current page.

**[User guide](docs/USER_GUIDE.md)**: a tour of the panel, step-by-step recipes for common jobs, every setting, and troubleshooting.

Version 1.1 adds:

- **Chat tabs and saved history.** Keep several chats open at once, and come back to any chat later.
- **Queue and batch jobs.** Add prompts while the agent is busy, or queue one job per line of a list.
- **Any-file attachments.** Give it text files, PDFs, Word, Excel and PowerPoint documents, or any other file to upload.
- **Computer tools (optional).** With a small companion program, the agent can also run commands, work with files and use local MCP servers on your computer.

Requires Chrome 116 or later.

## Install

### Option A: from the release zip (single file)

1. Download `agent-automation-v<version>.zip` from the [Releases page](https://github.com/cyberkyd01/agent-automation/releases/latest). Keep it as a zip; do not unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Drag the zip file onto the page.
5. Pin the extension from the puzzle-piece menu in the toolbar.
6. Click the icon, or press **Ctrl+Shift+Y** (Mac: **Cmd+Shift+Y**), to open the side panel.

Chrome only installs `.crx` files that come from the Chrome Web Store, which is why the single-file install is a zip and needs Developer mode.

If Chrome refuses the dropped zip, unzip it and use Option B on the unzipped folder.

The release has two downloads: the extension zip, and `agent-companion.mjs`. You only need the second one if you want computer tools (see [Computer tools](#computer-tools-and-local-mcp-servers-companion)).

### Option B: from source

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu in the toolbar.
6. Click the icon, or press **Ctrl+Shift+Y** (Mac: **Cmd+Shift+Y**), to open the side panel.

After editing any file in this folder, press the reload icon on the extension's card in `chrome://extensions`, then reopen the panel.

If the shortcut does nothing, another extension probably already uses it. Set a different one at `chrome://extensions/shortcuts`.

## Connect a model

### LM Studio (preconfigured)

Load a model, open the **Developer** tab and start the server. The extension uses the default address `http://localhost:1234/v1`.

### Ollama (preconfigured)

Run `ollama serve`. The extension uses the default address `http://localhost:11434/v1`.

You do not need to set `OLLAMA_ORIGINS`. The extension rewrites the Origin header on its requests to local and private-network servers, so they accept them without any CORS setup.

### Cloud providers

Settings → **Add provider** → choose a preset → paste the API key → **Test connection**.

Presets: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together AI.

For any other service with an OpenAI-style `/chat/completions` endpoint, choose **Custom (OpenAI-compatible)** and enter its base URL (the part before `/chat/completions`, for example `https://example.com/v1`).

### Choose a model

Pick the provider and model in the panel header. The reload button refreshes the model list from the server. If your model isn't listed, choose **Custom model ID…** and type it in.

## Local models: context window and tool calling

> **Read this before judging a local model.** The agent sends a long system prompt and a list of tools with every request. If the model's context window is too small, the tool list is cut off without any error, and the agent misbehaves: it ignores tools, loops, or makes things up.

- **Set the context length to at least 16k tokens, ideally 32k.**
  - LM Studio: in the model's load settings, before loading it.
  - Ollama: start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, or add `PARAMETER num_ctx 32768` to a Modelfile. Ollama's default is too small for an agent.
- **Prefer models trained for tool calling**, for example the Qwen, Llama 3.1+, Mistral/Devstral and GPT-OSS families.
- Models without native tool calling still work. The extension switches automatically to a "prompted" mode where the model writes tool calls as text, but this is less reliable.
- Vision-capable models can also look at screenshots of the page and at attached images.
- With a small-context model, lower **Context budget** in Settings so older parts of the conversation are trimmed sooner.

## What it can do

| Area | Tools |
|---|---|
| Tabs | list, open, close, navigate, and switch by tab id or by a title or URL (for example "switch to the orders tab") |
| Read page | text outline of the page with numbered interactive elements |
| Act on page | click, type, select options, press keys, scroll, hover, wait |
| Screenshot | capture the visible page (vision models only) |
| Scripts | run JavaScript in the page |
| Web | web search, fetch a URL |
| Files | `read_file` (the text of an attached file or a file URL), upload any file into a file input, download any file |
| Images | generate, edit, view, preview on the page |
| Remote MCP | any tools from the MCP servers you add |
| Computer | with the companion connected, tools named `mcp_computer_…`: run commands, read and write files, clipboard, and more (see below) |

## Example prompts

- "Summarise this page in five bullet points."
- "Go through the open enquiries on this page and reply to each using our refund policy: …"
- "For every product in this table set status to Archived if stock is 0."
- "Compare our pricing page with three competitors and list features we lack."
- "Generate a 1200x630 banner for this article and upload it to the cover image field."
- "Fill in this form with the details below: …"
- "Read the attached PDF and fill in this form from it."

For bulk work, state exactly what to change and what to leave alone, and let it do one item first so you can check the result.

## Chats, tabs and history

Each chat is a tab at the top of the panel.

- Click **+** to start another chat. Double-click a tab's title, or select it and press **F2**, to rename it.
- Closing a tab never deletes the chat. If the chat is still working, the tab first asks you to confirm, and closing it then stops the run.
- Each chat runs independently, so one chat can work while you read or start another. Chats that work at the same time should use different browser tabs.
- Every chat is saved automatically on this computer: its messages, its queue and its attached and generated files.
- A chat that is open in another browser window is shown read-only here. It becomes editable when the other window closes it, or you can open a copy.
- Runs stop if you close the side panel. The chat is kept; reopen it and use **Continue** to carry on.
- If you used v1.0, its single saved chat is moved into History automatically.

Click the clock icon in the header to open **History**:

- **Search chats** looks at each chat's title, first message and page address. Tick **This site** to show only chats that were started on the site of the current browser tab.
- Click a chat to open it, from any web page, and continue it where it stopped.
- The **…** button on a chat shows **Rename**, **Export**, **Export Markdown** (a readable transcript) and **Delete**. **Export** saves a `.zip` that includes the chat's files (attachments and files the agent created), or a `.json` file when the chat has no files.
- **Import** adds chats from `.zip` and `.json` export files (including exports from older versions), and always as new chats; it never overwrites one. **Export all** saves every chat as one `.zip`, as a backup.

## Queue and batch jobs

Type a prompt while the agent is working and it is added to that chat's queue instead of interrupting the run. Open the queue bar above the message box to see what is waiting. Queued prompts keep working in the tab the previous prompt ended on.

- **Queue mode** (also in Settings → Behaviour) decides what happens when a prompt finishes. **Run all** starts the next one straight away. **One at a time** waits for you, and shows **Run next** and **Run all remaining**.
- **Stop**, or an error, pauses the queue. Choose **Resume** to carry on with the queue, **Retry** (after an error) or **Continue** (after Stop) on the message in the chat to finish the interrupted prompt first, or **Clear** to empty the queue. A queue that was saved with a chat never starts by itself when you reopen the chat.
- Queued items can be moved up or down, removed, or edited (an edited item goes back to the message box).
- Short connection problems with the model are retried automatically, so a brief network hiccup does not end a long job.

### Batch

The **Batch jobs** button (the list icon beside the paperclip) queues many jobs at once:

1. Type or paste the items, one per line (URLs, names, order numbers).
2. Optionally write an instruction. Put `{{item}}` where each line should go, for example `Open {{item}} and write a short summary of the product`. Without `{{item}}`, each line is added after the instruction. With no instruction, each line is the whole prompt.
3. Choose **Run all** or **One at a time**, check the preview, and click **Add jobs to queue**.

## Attaching files

Attach files with the paperclip button, by pasting into the message box, or by dragging them onto the panel. Any file type is accepted, up to 100 MB each.

What the model can read as text:

- Plain text and code, CSV, JSON, XML and similar files
- PDF files that have a text layer
- Word `.docx`, Excel `.xlsx` and PowerPoint `.pptx` files

Any file, readable or not (a zip or a video, for example), can be uploaded to a web page by the agent (into a file input), or downloaded to your Downloads folder.

Limits:

- A scanned PDF has no text layer, so there is nothing to read. Use a PDF with selectable text.
- Old `.doc`, `.xls` and `.ppt` files and password-protected files cannot be read. Save them as `.docx`, `.xlsx` or `.pptx` without a password first.
- Images are only "seen" by a model with vision. Other models can still upload them.

## Images

Settings → **Image generation**: choose a provider and an image model, then a mode:

- **Images API**: for OpenAI-style `/images/generations` and `/images/edits` endpoints (OpenAI, LocalAI and similar).
- **Chat completions with image output**: for multimodal chat models that return images, for example Gemini image models via OpenRouter.

The agent can take an image from the page, edit it, preview the result in place on the page, and upload it through the site's own upload field.

## Remote MCP servers

Settings → **Remote MCP servers** → **Add MCP server** → enter a name and the server URL, plus optional headers such as `Authorization: Bearer <token>` (one per line). Click **Test** to check the connection; it lists the tools the server offers. Streamable HTTP is used by default, and URLs ending in `/sse` use the older SSE transport. Servers that run on your own computer (stdio servers) are set up in the next section.

## Computer tools and local MCP servers (companion)

By default the agent can only work inside Chrome. The **companion** is a small program that runs on your computer and gives the agent tools for the computer itself. A browser extension cannot start programs, so this part has to run outside the browser. It is optional: everything else works without it.

It provides:

- **Built-in tools:** run commands, read and write files, list and find files, open files, folders, apps and URLs, read and write the clipboard, and show system information.
- **Local MCP servers:** programs that speak MCP over stdio (started with `npx`, `uvx`, `docker` and similar). The companion starts them and passes their tools to the agent.

It needs [Node.js](https://nodejs.org) 18 or later and nothing else.

### Set up

1. Install Node.js 18 or later.
2. Download `agent-companion.mjs` from the [Releases page](https://github.com/cyberkyd01/agent-automation/releases/latest).
3. In a terminal, go to the folder with that file and run `node agent-companion.mjs`.
4. Copy the token it prints into Settings → **Computer tools** → **Token**, and switch **Enabled** on.
5. Click **Test connection**. A working setup shows the companion's version, platform, user and how many tools it offers.

To start the companion every time you log in, run `node agent-companion.mjs --install-autostart` once. This is tested on macOS; the Linux and Windows versions are written but untested.

### Local MCP servers

Once the connection works, Settings → **Computer tools** shows the companion's own settings:

- **Local MCP servers (stdio):** click **Add server** and fill in the name, command, arguments, environment and working directory, or click **Paste JSON** and paste an entry from an MCP server's documentation, in the Claude Desktop `mcpServers` format. Then click **Apply**. Nothing changes on the companion until you apply, and **Discard changes** takes you back. Each server's card shows whether it is running, and its error text if it failed.
- **Allow shell commands** and **Allow writing files** switch off the riskiest tools. Without shell commands the agent cannot run commands or open files and apps; without file writing it can only read files.

Details, options and troubleshooting are in [`companion/README.md`](companion/README.md).

## Safety and control

- **Ask before acting** (default): the agent asks for approval before actions that change something: clicking, typing, choosing from a list, pressing keys, closing tabs, running scripts, uploading, downloading, sending non-GET web requests, and tools from MCP servers (except tools a server marks as read-only). Reading pages, scrolling, opening and switching tabs, searching and screenshots never ask. **Allow all (this chat)** approves everything for the rest of the current conversation.
- **Act without asking**: no approval prompts for browser actions, for unattended bulk work.
- The **Stop** button (or **Esc**) halts a run at any point.
- Page content is treated as data, not instructions, but no model is immune to prompt injection. Be careful with **Act without asking** on sites you don't control, and review replies before letting the agent send messages to customers.
- API keys are stored unencrypted in the extension's local storage on this computer. They are sent only to the provider you configured them for.
- **Trusted input events** (Settings → Behaviour) uses Chrome's debugger to send real mouse and keyboard events, for sites that ignore simulated ones. Chrome shows a debugging banner at the top of the window while it is active. The debugger is also used to run scripts on pages whose security policy blocks them, so the banner can appear then too.
- Chats and attached files are stored unencrypted in the browser profile on this computer. Delete a chat in History to remove it and its files.

### Computer tools

Computer tools run with the permissions of your user account. They can read, change and delete your files and run any program you could run yourself.

- By default, **every computer-tool call asks for approval, even in "Act without asking" mode.** This is Settings → Computer tools → Approval: **Always ask before computer tools (recommended)**. In the approval prompt, **Always allow this tool (this chat)** stops the questions for that one tool in that one chat.
- Do not switch Approval to **Follow the chat's approval mode** unless you trust every page the agent reads. A web page could try to trick the model into running a command.
- The companion only listens on this computer, requires its secret token for every request, and refuses requests that come from web pages.
- Turn off **Allow shell commands** or **Allow writing files** if you do not need them, and stop the companion when you are not using it.

## Limitations and troubleshooting

| Problem | Cause or fix |
|---|---|
| The agent can't act on a page | Extensions can't act on `chrome://` pages, the Chrome Web Store or Chrome's built-in PDF viewer. |
| Part of a page is missing from what it reads | Content inside cross-origin iframes can't be read. Open the frame's URL in its own tab. |
| "Cannot reach …" | The local server isn't running, or the URL or port is wrong. |
| It loops, ignores tools or invents results | The context window is too small (see above), or the model isn't capable enough. Try a larger context or a stronger model. |
| Context-length errors with a small model | Lower **Context budget** in Settings. |
| A very long chat seems to forget its start | Older messages are trimmed for the model to fit the **Context budget**. The chat itself keeps everything. |
| "Could not attach the debugger" | DevTools is open on that tab. Close it; debugger-based features don't work on a tab while DevTools is open. |
| The model list is empty | Check the URL and API key with **Test connection**. You can still enter a **Custom model ID…**. |
| A run stopped when I closed the panel | Runs only continue while the side panel is open. The chat is kept: reopen it and choose **Continue**. |
| After a restart only some chats are open | With two browser windows, only the open chats of the window that changed last are restored. Every chat is still in History. |
| "The companion is not running at …" | Start it with `node agent-companion.mjs`, and check the address in Settings → Computer tools. |
| A local MCP server shows an error | Its card in Settings → Computer tools shows the error text. The usual cause is a wrong command path; use the full path to the program. |

## Building the zip

`./scripts/package.sh` writes `dist/agent-automation-v<version>.zip`, with `manifest.json` at the root of the zip. The `companion/` and `scripts/` folders are not included in the zip.

## Project layout

| Path | Purpose |
|---|---|
| `manifest.json` | Extension manifest |
| `background.js` | Opens the side panel when the toolbar icon is clicked |
| `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | Side panel UI: chat tabs, queue, History, batch dialog |
| `settings-tools.css` | Styles for the Computer tools settings |
| `src/agent.js` | Agent loop |
| `src/providers.js` | OpenAI-compatible and Anthropic adapters, streaming, prompted tool-calling fallback |
| `src/tools.js` | Browser, search, file and image tools |
| `src/page.js` | Code injected into web pages |
| `src/cdp.js` | Chrome debugger helpers (trusted input, script fallback) |
| `src/mcp.js` | MCP client |
| `src/files.js` | Attached files: type detection and text extraction |
| `src/sessions.js` | Saved chats: storage, export and import |
| `src/settings-ui.js` | Settings screen |
| `src/settings-tools-ui.js` | Computer tools and Remote MCP settings |
| `src/markdown.js` | Markdown rendering for chat messages |
| `src/storage.js` | Settings, defaults and provider presets |
| `src/util.js` | Shared helpers |
| `vendor/pdfjs/` | Mozilla pdf.js (Apache-2.0), used to read PDF text |
| `companion/` | The companion program, its tests and its README |
| `docs/` | The [user guide](docs/USER_GUIDE.md) and its screenshots |
| `icons/` | Extension icons |
| `scripts/package.sh` | Builds the release zip into `dist/` |
| `LICENSE` | MIT licence |

## Feedback

If the extension is useful, star it on [GitHub](https://github.com/cyberkyd01/agent-automation). The same link is in Settings → About → **Rate on GitHub**.

Report bugs and request features through [Issues](https://github.com/cyberkyd01/agent-automation/issues).

## Licence

MIT. See `LICENSE`. The bundled pdf.js is Apache-2.0; see `vendor/pdfjs/LICENSE`.
