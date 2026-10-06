# Agent Automation

An AI agent in your browser's side panel. Connect a local model (LM Studio, Ollama) or any cloud API, pick a model, and ask it to work on the page beside it: read it, click, type, fill forms, reply to enquiries, or apply the same change across many rows. It can also research the web in other tabs, generate and edit images, and act as a general assistant for questions that have nothing to do with the current page.

It runs in Chrome, in other Chromium-based browsers (Chromium, Edge, Brave, Opera) and in Firefox.

**[User guide](docs/USER_GUIDE.md)**: a tour of the panel, step-by-step recipes for common jobs, every setting, and troubleshooting.

Version 1.2 adds:

- **Runs continue when the panel is closed.** The agent now works in a background part of the extension. Hiding the panel does not stop a job; a badge on the toolbar icon shows how many chats are running, and approvals and finished jobs arrive as desktop notifications. See [Runs continue when the panel is closed](#runs-continue-when-the-panel-is-closed).
- **No step limit by default.** A run ends when the task is done or when you press Stop. A loop guard nudges the model when it repeats the same failing action. See [Long tasks](#long-tasks).
- **Remote access.** One click in Settings opens a Cloudflare tunnel, so a browser on another computer can use your local models. See [Remote access](#remote-access-use-your-models-from-another-browser).
- **Desktop tools (Linux and macOS).** With the companion, the agent can open apps, list and focus windows, take a screenshot of the whole screen, press keys and type into other programs. See [Computer tools](#computer-tools-and-local-mcp-servers-companion).
- **Firefox and Chromium builds.** One codebase, built for Chrome, Chromium-based browsers and Firefox. See [Install](#install).

Requires Chrome 116 or later (or a Chromium-based browser of the same age), or Firefox 128 or later. Firefox has a few limits; see [Firefox](#firefox).

## Install

Pick the download for your browser from the [Releases page](https://github.com/cyberkyd01/agent-automation/releases/latest). Version 1.2.0 has these files:

| File | For |
|---|---|
| `agent-automation-chrome-v1.2.0.zip` | Chrome |
| `agent-automation-chromium-v1.2.0.zip` | Chromium, Edge, Brave and Opera. It is the same build as the Chrome one, in its own file. |
| `agent-automation-firefox-v1.2.0.zip` and `agent-automation-firefox-v1.2.0.xpi` | Firefox |
| `agent-companion.mjs` | Optional: computer tools, desktop tools and remote access (see [Computer tools](#computer-tools-and-local-mcp-servers-companion)) |

### Chrome and other Chromium-based browsers

1. Download the zip for your browser (see the table). Keep it as a zip; do not unzip it.
2. Open the browser's extensions page: `chrome://extensions` (Chrome, Chromium), `edge://extensions`, `brave://extensions` or `opera://extensions`.
3. Turn on **Developer mode**.
4. Drag the zip file onto the page.
5. Pin the extension from the puzzle-piece menu in the toolbar.
6. Click the icon, or press **Ctrl+Shift+Y** (Mac: **Cmd+Shift+Y**), to open the side panel. Clicking the icon again hides it.

Chrome only installs `.crx` files that come from the Chrome Web Store, which is why the single-file install is a zip and needs Developer mode. If the browser refuses the dropped zip, unzip it and use **Load unpacked** on the unzipped folder instead. If the shortcut does nothing, another extension probably already uses it; set a different one at `chrome://extensions/shortcuts`.

### Firefox

1. Download `agent-automation-firefox-v1.2.0.xpi` (or the zip).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick the `.xpi`. If you built it from source, pick `manifest.json` in `dist/firefox`. The sidebar opens by itself.
4. The toolbar button, or **Ctrl+Shift+Y** (Mac: **Cmd+Shift+Y**), opens and closes the sidebar. If the shortcut does nothing, set another one in `about:addons` (gear menu, **Manage Extension Shortcuts**).
5. If Firefox has not given the extension access to websites, the panel shows an **Allow access** banner. Click it: without that access the agent cannot read or act on any page. You can also change it in `about:addons` → Agent Automation → **Permissions**.

**A temporary add-on is removed when Firefox quits**, so you have to repeat steps 2 and 3 each time you start Firefox. Release and Beta Firefox refuse unsigned add-ons and ignore the setting that would allow them. To keep the extension installed, use one of these:

- **Firefox Developer Edition, Nightly or ESR.** Open `about:config`, set `xpinstall.signatures.required` to `false`, then open `about:addons`, click the gear and choose **Install Add-on From File…**, and pick the `.xpi`.
- **Sign your own copy.** Mozilla's add-on service can sign an add-on for your own use. Create API keys at addons.mozilla.org → Developer Hub → **Manage API Keys**, then run `npx web-ext sign --source-dir dist/firefox --channel unlisted --api-key <JWT issuer> --api-secret <JWT secret>`. Release Firefox installs the signed `.xpi` it returns.

Limits in Firefox (the Firefox build also declares to Firefox that it collects no data):

- **Trusted input events** (Settings → Behaviour) is not available, and neither is the fallback for pages whose security policy blocks scripts. Both need Chrome's debugger API.
- Approval notifications have no **Allow** and **Deny** buttons. Clicking one opens the panel in a browser tab (not the sidebar), on the chat that needs an answer.
- In Firefox 128 to 151, the `screenshot` tool only works on a tab where you clicked the toolbar button or pressed the shortcut. From Firefox 152 it works on every tab. `read_page` is not affected.

### From source

1. Clone or download this repository.
2. Run `./scripts/build.sh`. It writes `dist/chrome`, `dist/chromium` (identical to `dist/chrome`) and `dist/firefox`, plus the zip files and the Firefox `.xpi` that the release carries. The `companion/` and `scripts/` folders are not part of them.
3. In Chrome or a Chromium-based browser: open the extensions page, turn on **Developer mode**, click **Load unpacked** and pick `dist/chrome` (or `dist/chromium`). While developing for Chrome you can also pick the repository folder itself, the one that contains `manifest.json`. In Firefox, follow the Firefox steps above and pick `manifest.json` in `dist/firefox`.

After editing a file, run the build again if you use `dist/…`, then press the reload icon on the extension's card (in Firefox, **Reload** in `about:debugging`) and reopen the panel. Reloading the extension ends any running job.

## Connect a model

### LM Studio (preconfigured)

Load a model, open the **Developer** tab and start the server. The extension uses the default address `http://localhost:1234/v1`.

### Ollama (preconfigured)

Run `ollama serve`. The extension uses the default address `http://localhost:11434/v1`.

You do not need to set `OLLAMA_ORIGINS`. The extension rewrites the Origin header on its requests to local and private-network servers, so they accept them without any CORS setup.

### Cloud providers

Settings → **Add provider** → choose a preset → paste the API key → **Test connection**.

Presets: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together AI. For models on another computer, use **Add from connection code** (see [Remote access](#remote-access-use-your-models-from-another-browser)).

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
| Desktop | with the companion on Linux or macOS: list and launch apps, list, focus and close windows, screenshot the whole screen, press keys and type into other programs |

## Example prompts

- "Summarise this page in five bullet points."
- "Go through the open enquiries on this page and reply to each using our refund policy: …"
- "For every product in this table set status to Archived if stock is 0."
- "Compare our pricing page with three competitors and list features we lack."
- "Generate a 1200x630 banner for this article and upload it to the cover image field."
- "Fill in this form with the details below: …"
- "Read the attached PDF and fill in this form from it."
- With desktop tools on Linux: "Open the text editor, type the list above into it and take a screenshot of the screen."

For bulk work, state exactly what to change and what to leave alone, and let it do one item first so you can check the result.

## Runs continue when the panel is closed

The agent works in a background part of the extension, not in the panel. The panel is only a view of it, so closing or hiding the panel (clicking the toolbar icon toggles it) does not stop a job.

- **Badge.** While chats are running, the toolbar icon shows the number of running chats. The badge turns amber while one of them waits for your approval.
- **Approvals.** With the panel closed, an approval request appears as a desktop notification with **Allow** and **Deny** buttons (Chrome). Click the notification itself to open the panel on that chat. For **Allow all (this chat)** or **Always allow this tool (this chat)**, open the panel.
- **Finished and failed jobs** also send a notification.
- **Settings → Behaviour → Desktop notifications** turns notifications off. It is on by default. Notifications only appear while no panel is open in any window.
- **Firefox:** notifications have no buttons. Click one to open the panel in a browser tab, on the chat that needs an answer.
- **Closing the browser still ends runs.** The chat is kept; reopen it and use **Continue**. Reloading or updating the extension ends runs too.

## Long tasks

**Settings → Behaviour → Max steps per prompt** is `0` by default, which means no limit: a run ends when the model has finished the task or when you press **Stop**. A loop guard helps with runs that get stuck. When the model repeats the exact same action and it has failed three times in a row, the result tells it to try another approach or ask you. The guard never stops the run.

To cap runs, for example with a paid cloud model on unattended jobs, enter a number. When a run reaches it, the chat shows `Step limit reached (N). Send "continue" to keep going.` Installs that still had the old default of 40 are changed to 0 once, when you update.

## Chats, tabs and history

Each chat is a tab at the top of the panel.

- Click **+** to start another chat. Double-click a tab's title, or select it and press **F2**, to rename it.
- Closing a tab never deletes the chat. If the chat is still working, the tab first asks you to confirm, and closing it then stops the run.
- Each chat runs independently, so one chat can work while you read or start another. Chats that work at the same time should use different browser tabs.
- Every chat is saved automatically on this computer: its messages, its queue and its attached and generated files.
- The open chat tabs are the same in every browser window.
- A run that was cut off, for example because the browser was closed, is marked "This chat was interrupted." when you reopen the chat. Use **Continue** to carry on.
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

By default the agent can only work inside the browser. The **companion** is a small program that runs on your computer and gives the agent tools for the computer itself. A browser extension cannot start programs, so this part has to run outside the browser. It is optional: everything else works without it.

It provides:

- **Built-in tools:** run commands, read and write files, list and find files, open files, folders, apps and URLs, read and write the clipboard, and show system information.
- **Desktop tools (Linux and macOS):** `list_apps`, `launch_app`, `list_windows`, `focus_window`, `close_window`, `desktop_screenshot`, `send_keys` and `type_in_app`. They let the agent work with other programs on your screen. Windows has no desktop tools yet.
- **Local MCP servers:** programs that speak MCP over stdio (started with `npx`, `uvx`, `docker` and similar). The companion starts them and passes their tools to the agent.
- **Remote access:** the Cloudflare tunnel described [below](#remote-access-use-your-models-from-another-browser).

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

### Desktop tools

Settings → Computer tools → **Desktop tools** has an **Enabled** switch, and lists which tools work on this computer and what to install for the others.

- **macOS:** nothing to install. macOS asks for **Automation**, **Accessibility** and **Screen Recording** permission for your terminal app (or `node`, when the companion starts at login).
- **Linux, X11:** `sudo apt install xdotool wmctrl scrot` (Debian, Ubuntu) or `sudo dnf install xdotool wmctrl scrot` (Fedora).
- **Linux, Wayland:** `grim` and `wtype` or `ydotool`. Most Wayland desktops cannot list, focus or close windows; choose an X11 session at login if you need that.

Every desktop tool asks for approval. Details for each system are in the [user guide](docs/USER_GUIDE.md#desktop-tools).

Details, options and troubleshooting are in [`companion/README.md`](companion/README.md).

## Remote access: use your models from another browser

You can reach the models on your home or office computer from a browser somewhere else, for example your laptop. The companion starts a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for you, so you need no Cloudflare account and no router settings.

<img src="docs/images/remote-access.png" alt="Settings, Remote access section: a green Running badge, the public link, the connection code hidden behind dots with Show and Copy buttons, three checkboxes (Expose local models ticked), and the list of local models with LM Studio ticked." width="400">

1. On the computer that runs the models, connect the companion (see [Set up](#set-up)) and open Settings → **Remote access**.
2. Click **Start tunnel**. The first time, the companion downloads its own private copy of `cloudflared` (about 40 MB).
3. Under **Expose these local models**, tick the models to share. **Expose local models** is on by default; **Expose computer tools** is off.
4. Copy the **Connection code** (use **Show** or **Copy**).
5. In the other browser, install the extension, open Settings → Providers → **Add from connection code**, paste the code and click **Add**. It adds one provider per shared model, named like `LM Studio (remote)`. Pick it in the panel header.

Know before you use it:

- **Anyone who has both the link and the token can use what you share.** Treat the connection code like a password, and stop the tunnel when you are not using it. Settings and the tunnel controls only work on the computer that runs the companion. After 10 wrong tokens, a client is blocked for 15 minutes.
- **The tunnel is separate from any other Cloudflare setup** on that computer: the companion uses its own `cloudflared` copy and its own configuration, never touches `~/.cloudflared`, and never changes services or accounts. **Stop tunnel** ends only its own process.
- **The link changes** every time a quick tunnel starts, so paste the new code into the other browser. A named tunnel (Advanced, with its token and public address) keeps one address.
- **Cloudflare quick tunnels have no uptime guarantee.** An answer that has not started after about 100 seconds fails with an error 524, so use models that stream their reply.

More in the [user guide](docs/USER_GUIDE.md#remote-access) and [`companion/README.md`](companion/README.md#remote-access-cloudflare-tunnel).

## Safety and control

- **Ask before acting** (default): the agent asks for approval before actions that change something: clicking, typing, choosing from a list, pressing keys, closing tabs, running scripts, uploading, downloading, sending non-GET web requests, and tools from MCP servers (except tools a server marks as read-only). Reading pages, scrolling, opening and switching tabs, searching and screenshots never ask. **Allow all (this chat)** approves everything for the rest of the current conversation. If the panel is closed, the question arrives as a desktop notification.
- **Act without asking**: no approval prompts for browser actions, for unattended bulk work.
- The **Stop** button (or **Esc**) halts a run at any point.
- Page content is treated as data, not instructions, but no model is immune to prompt injection. Be careful with **Act without asking** on sites you don't control, and review replies before letting the agent send messages to customers.
- API keys are stored unencrypted in the extension's local storage on this computer. They are sent only to the provider you configured them for.
- **Trusted input events** (Settings → Behaviour) uses Chrome's debugger to send real mouse and keyboard events, for sites that ignore simulated ones. Chrome shows a debugging banner at the top of the window while it is active. The debugger is also used to run scripts on pages whose security policy blocks them, so the banner can appear then too. Firefox does not have Chrome's debugger API, so neither feature works there.
- Chats and attached files are stored unencrypted in the browser profile on this computer. Delete a chat in History to remove it and its files.

### Computer tools

Computer tools run with the permissions of your user account. They can read, change and delete your files and run any program you could run yourself. Desktop tools can also press keys and type into any program that is open, and a desktop screenshot shows everything on your screen, not only the browser.

- By default, **every computer-tool call asks for approval, even in "Act without asking" mode.** This is Settings → Computer tools → Approval: **Always ask before computer tools (recommended)**. In the approval prompt, **Always allow this tool (this chat)** stops the questions for that one tool in that one chat.
- Do not switch Approval to **Follow the chat's approval mode** unless you trust every page the agent reads. A web page could try to trick the model into running a command.
- The companion only listens on this computer (apart from the tunnel, which you start yourself), requires its secret token for every request, and refuses requests that come from web pages.
- Turn off **Allow shell commands**, **Allow writing files** or **Desktop tools** if you do not need them, and stop the companion when you are not using it.

## Limitations and troubleshooting

| Problem | Cause or fix |
|---|---|
| The agent can't act on a page | Extensions can't act on `chrome://` pages, the Chrome Web Store or Chrome's built-in PDF viewer (in Firefox, `about:` pages). |
| Part of a page is missing from what it reads | Content inside cross-origin iframes can't be read. Open the frame's URL in its own tab. |
| "Cannot reach …" | The local server isn't running, or the URL or port is wrong. |
| It loops, ignores tools or invents results | The context window is too small (see above), or the model isn't capable enough. Try a larger context or a stronger model. |
| Context-length errors with a small model | Lower **Context budget** in Settings. |
| A very long chat seems to forget its start | Older messages are trimmed for the model to fit the **Context budget**. The chat itself keeps everything. |
| "Could not attach the debugger" | DevTools is open on that tab. Close it; debugger-based features don't work on a tab while DevTools is open. |
| The model list is empty | Check the URL and API key with **Test connection**. You can still enter a **Custom model ID…**. |
| A run stopped on its own | It finished, you pressed Stop, an error ended it (use **Retry**), you set a step limit and it was reached, or the browser or extension was closed or reloaded (use **Continue**). Hiding the panel does not stop a run. |
| No notification when the panel is closed | Settings → Behaviour → **Desktop notifications** is off, a panel is open in another window, or your operating system blocks notifications from the browser. |
| Firefox: no page can be read, or the extension is gone after a restart | Click **Allow access** in the panel's banner. A temporary add-on is removed when Firefox quits; see [Firefox](#firefox). |
| Firefox: the screenshot tool fails | In Firefox 128 to 151, click the toolbar button on that tab first, or use `read_page`. |
| "The companion is not running at …" | Start it with `node agent-companion.mjs`, and check the address in Settings → Computer tools. |
| A local MCP server shows an error | Its card in Settings → Computer tools shows the error text. The usual cause is a wrong command path; use the full path to the program. |
| A desktop tool is missing | Settings → Computer tools → Desktop tools lists the missing helpers and what to install. |
| The tunnel will not start | See [`companion/README.md`](companion/README.md#troubleshooting). |

## Project layout

| Path | Purpose |
|---|---|
| `manifest.json` | Chrome extension manifest |
| `background.js` | Chrome service worker: opens the side panel, makes the browser calls for the engine, sets the toolbar badge and shows notifications |
| `offscreen.html` | Chrome page that hosts the agent engine, so jobs go on while the panel is closed |
| `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | Side panel UI: chat tabs, queue, History, batch dialog. It is a view of the engine. |
| `settings-tools.css` | Styles for the Computer tools and Remote access settings |
| `src/engine/` | The engine that owns the chats, queues and runs; `PROTOCOL.md` describes how the panel talks to it |
| `src/host/` | `api.js`: one interface to the browser APIs, used by the engine in Chrome and in Firefox |
| `src/agent.js` | Agent loop, including the loop guard |
| `src/providers.js` | OpenAI-compatible and Anthropic adapters, streaming, prompted tool-calling fallback |
| `src/tools.js` | Browser, search, file and image tools |
| `src/page.js` | Code injected into web pages |
| `src/cdp.js` | Chrome debugger helpers (trusted input, script fallback) |
| `src/mcp.js` | MCP client |
| `src/files.js` | Attached files: type detection and text extraction |
| `src/sessions.js` | Saved chats: storage, export and import |
| `src/settings-ui.js` | Settings screen |
| `src/settings-tools-ui.js` | Computer tools, Remote access and Remote MCP settings |
| `src/markdown.js` | Markdown rendering for chat messages |
| `src/storage.js` | Settings, defaults and provider presets |
| `src/util.js` | Shared helpers |
| `platform/firefox/` | Firefox manifest (`manifest.json`) and background page (`background.html`) |
| `vendor/pdfjs/` | Mozilla pdf.js (Apache-2.0), used to read PDF text |
| `companion/` | The companion program, its tests and its README |
| `docs/` | The [user guide](docs/USER_GUIDE.md) and its screenshots |
| `icons/` | Extension icons |
| `scripts/build.sh` | Builds the Chrome, Chromium and Firefox versions into `dist/` |
| `scripts/package.sh` | Runs `build.sh`, and also writes the Chrome zip under its old name, `agent-automation-v<version>.zip` |
| `LICENSE` | MIT licence |

## Feedback

If the extension is useful, star it on [GitHub](https://github.com/cyberkyd01/agent-automation). The same link is in Settings → About → **Rate on GitHub**.

Report bugs and request features through [Issues](https://github.com/cyberkyd01/agent-automation/issues).

## Licence

MIT. See `LICENSE`. The bundled pdf.js is Apache-2.0; see `vendor/pdfjs/LICENSE`.
