# Agent Automation

An AI agent in Chrome's side panel. Connect a local model (LM Studio, Ollama) or any cloud API, pick a model, and ask it to work on the page beside it: read it, click, type, fill forms, reply to enquiries, or apply the same change across many rows. It can also research the web in other tabs, generate and edit images, and act as a general assistant for questions that have nothing to do with the current page.

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
- Vision-capable models can also look at screenshots of the page.
- With a small-context model, lower **Context budget** in Settings so older parts of the conversation are trimmed sooner.

## What it can do

| Area | Tools |
|---|---|
| Tabs | list, open, switch, close, navigate |
| Read page | text outline of the page with numbered interactive elements |
| Act on page | click, type, select options, press keys, scroll, hover, wait |
| Screenshot | capture the visible page (vision models only) |
| Scripts | run JavaScript in the page |
| Web | web search, fetch a URL |
| Images | generate, edit, view, upload into a file input, preview on the page, download |
| MCP | any tools from MCP servers you add |

## Example prompts

- "Summarise this page in five bullet points."
- "Go through the open enquiries on this page and reply to each using our refund policy: …"
- "For every product in this table set status to Archived if stock is 0."
- "Compare our pricing page with three competitors and list features we lack."
- "Generate a 1200x630 banner for this article and upload it to the cover image field."
- "Fill in this form with the details below: …"

For bulk work, state exactly what to change and what to leave alone, and let it do one item first so you can check the result.

## Images

Settings → **Image generation**: choose a provider and an image model, then a mode:

- **Images API**: for OpenAI-style `/images/generations` and `/images/edits` endpoints (OpenAI, LocalAI and similar).
- **Chat completions with image output**: for multimodal chat models that return images, for example Gemini image models via OpenRouter.

The agent can take an image from the page, edit it, preview the result in place on the page, and upload it through the site's own upload field.

## MCP servers

Settings → **MCP servers** → add the server URL, plus optional headers such as `Authorization: Bearer <token>`.

- Streamable HTTP is used by default. URLs ending in `/sse` use the older SSE transport.
- Browser extensions cannot start local stdio servers. Expose them over HTTP with a bridge such as `mcp-proxy` or `supergateway`, then add the bridge's URL.

## Safety and control

- **Ask before acting** (default): the agent asks for approval before clicks, typing, running scripts, uploads, downloads, non-GET requests and MCP tools. **Allow all (this chat)** approves everything for the rest of the current conversation.
- **Act without asking**: no approval prompts, for unattended bulk work.
- The **Stop** button halts a run at any point.
- Page content is treated as data, not instructions, but no model is immune to prompt injection. Be careful with **Act without asking** on sites you don't control, and review replies before letting the agent send messages to customers.
- API keys are stored unencrypted in the extension's local storage on this computer. They are sent only to the provider you configured them for.
- **Trusted input events** (Settings → Behaviour) uses Chrome's debugger to send real mouse and keyboard events, for sites that ignore simulated ones. Chrome shows a debugging banner at the top of the window while it is active. The debugger is also used to run scripts on pages whose security policy blocks them, so the banner can appear then too.

## Limitations and troubleshooting

| Problem | Cause or fix |
|---|---|
| The agent can't act on a page | Extensions can't act on `chrome://` pages, the Chrome Web Store or Chrome's built-in PDF viewer. |
| Part of a page is missing from what it reads | Content inside cross-origin iframes can't be read. Open the frame's URL in its own tab. |
| "Cannot reach …" | The local server isn't running, or the URL or port is wrong. |
| It loops, ignores tools or invents results | The context window is too small (see above), or the model isn't capable enough. Try a larger context or a stronger model. |
| Context-length errors with a small model | Lower **Context budget** in Settings. |
| "Could not attach the debugger" | DevTools is open on that tab. Close it; debugger-based features don't work on a tab while DevTools is open. |
| The model list is empty | Check the URL and API key with **Test connection**. You can still enter a **Custom model ID…**. |

## Building the zip

`./scripts/package.sh` writes `dist/agent-automation-v<version>.zip`, with `manifest.json` at the root of the zip.

## Project layout

| Path | Purpose |
|---|---|
| `manifest.json` | Extension manifest |
| `background.js` | Opens the side panel when the toolbar icon is clicked |
| `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | Side panel UI |
| `src/agent.js` | Agent loop |
| `src/providers.js` | OpenAI-compatible and Anthropic adapters, streaming, prompted tool-calling fallback |
| `src/tools.js` | Browser, search and image tools |
| `src/page.js` | Code injected into web pages |
| `src/cdp.js` | Chrome debugger helpers (trusted input, script fallback) |
| `src/mcp.js` | MCP client |
| `src/settings-ui.js` | Settings screen |
| `src/markdown.js` | Markdown rendering for chat messages |
| `src/storage.js` | Settings, defaults and provider presets |
| `src/util.js` | Shared helpers |
| `icons/` | Extension icons |
| `scripts/package.sh` | Builds the release zip into `dist/` |
| `LICENSE` | MIT licence |

## Feedback

If the extension is useful, star it on [GitHub](https://github.com/cyberkyd01/agent-automation). The same link is in Settings → About → **Rate on GitHub**.

Report bugs and request features through [Issues](https://github.com/cyberkyd01/agent-automation/issues).

## Licence

MIT. See `LICENSE`.
