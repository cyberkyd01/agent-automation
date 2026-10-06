# Agent Automation companion

A small program that runs on your computer and gives the Agent Automation extension tools for that computer. Chrome extensions cannot start programs themselves, so the companion does it for them.

- **Built-in tools:** `run_command` (shell), `read_file`, `write_file`, `list_directory`, `find_files`, `open_path`, `clipboard_read`, `clipboard_write`, `system_info`.
- **Terminal sessions:** `terminal_open`, `terminal_send`, `terminal_read`, `terminal_interrupt`, `terminal_close`, `terminal_list`: shells that stay open, so the agent can run a command, read the answer and continue. See [Terminal sessions](#terminal-sessions).
- **Desktop tools:** `list_apps`, `launch_app`, `list_windows`, `focus_window`, `close_window`, `desktop_screenshot`, `send_keys`, `type_in_app`. See [Desktop tools](#desktop-tools).
- **Application tools:** `app_open_file`, `app_read_text`, `app_write_text`, and `run_applescript` (macOS) or `run_powershell` (Windows), to read and change what is in TextEdit, Notepad, Excel and other apps. See [Working in applications](#working-in-applications).
- **Local MCP servers:** it starts the stdio MCP servers you configure (`npx …`, `uvx …`, `docker …`) and passes their tools to the agent as `<server>__<tool>`.
- **Remote access:** with one click it opens a Cloudflare tunnel, so a browser on another computer can use your local models (LM Studio, Ollama, …) through the companion. See [Remote access](#remote-access-cloudflare-tunnel).

It is a single file, `agent-companion.mjs`. It needs [Node.js](https://nodejs.org) 18 or later and nothing else.

## Start it

```sh
node agent-companion.mjs
```

It prints something like:

```
Agent Automation companion 1.3.0
  URL      http://127.0.0.1:8765
  Token    3f9a…
Paste the token into the extension: Settings → Computer tools
```

In the extension, open **Settings → Computer tools**, turn it on, and paste the token. The URL is already filled in. Press **Ctrl+C** to stop the companion.

To show the token again later, run `node agent-companion.mjs --print-token`.

## How it keeps you safe

The companion can run commands as you, so it only accepts requests that pass all of these checks:

- **Only this computer can reach it.** It listens on `127.0.0.1`, which other computers cannot connect to.
- **A secret token is required.** Every request except a basic "are you running?" check must carry the token. The token is a random 64-character code. It is created on first start and stored in `companion.json`, which only your user account can read.
- **Websites are blocked.** Requests from web pages are refused, even if a page somehow had the token. This includes pages served from your own computer, such as a development server on another port: a page on `localhost` or `127.0.0.1` is accepted only when it uses the companion's own port. The companion accepts requests only from the extension and from local tools that send no web-page origin. It sends no CORS headers and refuses requests addressed to any name other than `127.0.0.1` or `localhost`, which blocks DNS-rebinding attacks. The one exception is the model proxy (`/llm/…`), which web apps that have the token may use: see [Use with other apps](#use-with-other-apps).
- **You approve every action.** By default the extension asks before each computer tool runs, even when you have chosen "auto" for browser actions. You can change this in Settings → Computer tools.
- **You can switch off risky tools.** Turning off "shell commands" (`allowShell`) removes `run_command`, `open_path`, the terminal sessions, `run_applescript` and `run_powershell`. Turning off "file writing" (`allowWrite`) removes `write_file`. Turning off "desktop tools" (`desktopTools`) removes the desktop and application tools.

Everything the agent runs is listed in the companion window and in `companion.log`. Calls that come through the tunnel are marked `[through the tunnel]`.

The tunnel is the one exception to "only this computer": see [Remote access](#remote-access-cloudflare-tunnel) for what it opens up and how it is protected.

**Don't use `--host` to listen on your network.** If you do, the companion prints a warning. Anyone who has the token could then use the companion, and the token travels unencrypted. Requests from other computers are treated like requests through the tunnel: they only reach `/health`, `GET /status` and, when you allow it, `/llm/…` and `/mcp`. Use the tunnel instead.

## Options

| Option | Meaning |
|---|---|
| `--port <n>` | Port to listen on (default 8765). If you change it, change the URL in the extension too. |
| `--host <address>` | Address to listen on (default `127.0.0.1`). See the warning above. |
| `--home <dir>` | Folder for the settings and log (default `~/.agent-automation`, or `$AGENT_COMPANION_HOME`). |
| `--print-token` | Print the token and exit. |
| `--install-autostart` | Start the companion automatically when you log in. |
| `--uninstall-autostart` | Stop starting it automatically. |
| `--dry-run` | With the two options above: show exactly what would be written and run, and change nothing. |
| `--version`, `--help` | |

## Start automatically at login

```sh
node agent-companion.mjs --install-autostart
```

This copies the program to `~/.agent-automation/agent-companion.mjs`, registers it to start at login and starts it right away. Run it from the same Node.js you want it to use. To see what it would do first, add `--dry-run`. To undo it:

```sh
node agent-companion.mjs --uninstall-autostart
```

- **macOS:** installs a LaunchAgent, `~/Library/LaunchAgents/com.agent-automation.companion.plist`. Startup messages go to `~/.agent-automation/autostart.log`.
- **Linux:** installs a systemd user service, `~/.config/systemd/user/agent-companion.service`. **Not tested yet.**
- **Windows:** puts `agent-companion.cmd` in your Startup folder, which opens the companion in a minimized window. **Not tested yet.**

## Remote access (Cloudflare tunnel)

In **Settings → Remote access**, **Start tunnel** gives the companion a public `https://…` address through [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/). A browser on another computer can then use your local models through it. You need no Cloudflare account for this.

**What the tunnel exposes.** Only these, and nothing else:

- `/health` (the "are you running?" check, no token needed),
- `GET /status`, reduced to the version, the tunnel state and what is shared (no folders, user name, tools or settings),
- `/llm/<name>/…`, your local model servers, when **Expose local models** is on (`exposeLlm`, on by default), and only the ones you ticked,
- `/mcp`, the computer tools, when **Expose computer tools** is on (`exposeMcp`, off by default). This lets the other browser run commands on this computer, so only turn it on if you need it.

Settings, `/config` and the tunnel controls are refused with "403" through the tunnel. They work only on this computer.

**How it is protected.** Every request through the tunnel needs the companion's token, like local requests. The address alone is not enough. After 10 wrong tokens from one address, that address is blocked for 15 minutes. The connection between the other browser and Cloudflare is encrypted (HTTPS). Web pages cannot reach the settings, the tunnel controls or the computer tools; only the model proxy (`/llm/…`) accepts browser-based apps, and only with the token. Anyone who has both the address and the token can use what you expose, so treat the connection code like a password.

**Connect the other browser.** Settings → Remote access shows a connection code (`aa1:…`). It holds the address, the token and the model addresses. In the other browser, open **Settings → Models & providers → Add from connection code** and paste it.

**The address changes.** A quick tunnel gets a new random `https://….trycloudflare.com` address each time it starts, including after the companion restarts. Paste the new connection code into the other browser when that happens. Turn on **Start tunnel when the companion starts** (`autostart`) to have it come back on its own; if cloudflared stops unexpectedly it is then restarted after 1, 5, 15, 30 and 60 seconds.

**Named tunnels** (optional, for a fixed address). Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), give it a public hostname whose service is `http://127.0.0.1:8765`, and set **HTTP Host Header** to `127.0.0.1:8765` in that hostname's HTTP settings. Copy the tunnel token (the long code starting with `eyJ`; pasting the whole `cloudflared service install …` line works too) into the advanced part of Settings → Remote access and choose **named**. Also enter the public address (for example `https://companion.example.com`) so the connection code can be made; with it, the companion also accepts that host name when the HTTP Host Header setting is left out. The token is stored in `companion.json` and is never shown again.

**cloudflared.** The companion downloads Cloudflare's official `cloudflared` program from GitHub into `~/.agent-automation/bin/` the first time you start a tunnel (about 40 MB) and checks that it runs. If the download fails and a `cloudflared` is already installed (for example with Homebrew), that one is used as it is. You can also install it yourself: `brew install cloudflared` (macOS), [pkg.cloudflare.com](https://pkg.cloudflare.com/) (Linux), `winget install --id Cloudflare.cloudflared` (Windows).

**It does not interfere with your own Cloudflare setup.** The companion's cloudflared is kept apart from anything else that uses Cloudflare on this computer:

- It never reads or writes `~/.cloudflared` (config.yml, cert.pem, tunnel credentials): it runs with its own config file, `~/.agent-automation/cloudflared.yml`, and its own home folder, `~/.agent-automation/cloudflared/`. Your `TUNNEL_…` environment variables are not passed to it.
- It never changes or updates an installed cloudflared, never logs in, never creates, routes or deletes tunnels, and never installs cloudflared as a service. It runs only `cloudflared tunnel --config … --no-autoupdate --metrics 127.0.0.1:0 --url http://127.0.0.1:8765 --http-host-header 127.0.0.1:8765` (quick) or `cloudflared tunnel --config … --no-autoupdate --metrics 127.0.0.1:0 run` with the token in its environment (named). The metrics port is a random free one, so it never collides with another cloudflared.
- Stop, and quitting the companion, stop only the cloudflared the companion started. If the companion was killed and left its cloudflared running, the next start stops that one, and only if its command line names the companion's own config file.
- Autostart starts the companion only; cloudflared runs as the companion's child.

**Log.** cloudflared's output goes to `~/.agent-automation/tunnel.log` (capped at about 1 MB; one older copy is kept as `tunnel.log.1`). When the tunnel fails, Settings → Remote access shows the last lines.

### Local model URLs

`/llm/<name>/<rest>` forwards to the base URL you configured for `<name>`, plus `/<rest>`. With `"lmstudio": { "url": "http://localhost:1234/v1" }`:

| Request to the companion | Goes to |
|---|---|
| `POST https://….trycloudflare.com/llm/lmstudio/chat/completions` | `POST http://localhost:1234/v1/chat/completions` |
| `GET http://127.0.0.1:8765/llm/lmstudio/models` | `GET http://localhost:1234/v1/models` |
| `GET https://….trycloudflare.com/llm/lmstudio/v1/models` | `GET http://localhost:1234/v1/models` (when the base URL ends with `/v1`, a second `/v1` is dropped) |
| `GET https://….trycloudflare.com/llm/lmstudio` | the model server's base URL, or a short list of the endpoints if it has nothing there |

So in an OpenAI-compatible client the base URL is `<companion address>/llm/<name>` and the API key is the companion's token. Every method works. Bodies and answers are passed through as they are, including streamed answers (server-sent events), which arrive piece by piece. The `Authorization` header is replaced: the model server gets none, or `Bearer <apiKey>` if you set an `apiKey` for it. If the model server is not running you get a "502" with a message such as `LM Studio is not running at http://localhost:1234/v1`. Closing the request (the Stop button) also stops the request to the model server. A streamed answer may pause for up to 10 minutes between pieces. Through the tunnel, Cloudflare gives up when an answer has not started within about 100 seconds ("524"), so use streaming for slow models.

### Use with other apps

The tunnel works as an OpenAI-compatible API, so any AI chat app or tool that lets you add an "OpenAI-compatible" provider can use your local models, not only this extension:

- **Base URL:** `https://<link>/llm/<name>`, for example `https://mins-conference-replace-mutual.trycloudflare.com/llm/lmstudio`. Apps that add `/v1` themselves, or want it in the base URL, work too. The link on its own is not a base URL: opening it in a browser, or an app asking it for `/models` or `/v1/…`, gets a "404" whose message points to `<link>/llm/<name>`.
- **API key:** the companion token (it is also inside the connection code).
- **Model:** a name listed by `https://<link>/llm/<name>/models`.

```sh
curl https://<link>/llm/lmstudio/chat/completions \
  -H "Authorization: Bearer <companion token>" \
  -H "Content-Type: application/json" \
  -d '{"model": "<model name>", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

Web apps work as well: the model proxy, and only the model proxy, answers browser preflight requests (CORS) from any website, because every request still needs the token and no cookies are used. After 10 wrong tokens from one website on this computer, or from one address through the tunnel, that website or address is blocked for 15 minutes. The rest of the companion (`/mcp`, settings, tunnel controls) still refuses all web pages.

## Desktop tools

These let the agent work with other programs on your screen. Like every computer tool, each one asks for your approval first in the extension (a screenshot shows the model whatever is on your screen, so even the tools that only look ask). The three that only look — `list_apps`, `list_windows` and `desktop_screenshot` — are marked read-only, which matters when another browser reaches this computer as a remote MCP server: there they skip the question in "Ask before acting" mode. Turn them all off with **Desktop tools** in Settings → Computer tools (`desktopTools`). Settings → Computer tools also shows which ones work on this computer and what to install for the others.

| Tool | What it does |
|---|---|
| `list_apps` | Lists the installed applications. |
| `launch_app` | Starts one by name, id or path (with optional files or URLs). It keeps running when the companion stops. |
| `list_windows`, `focus_window`, `close_window` | Lists the open windows; brings one to the front; closes one as if you clicked its close button. |
| `desktop_screenshot` | Takes a picture of the whole screen, scaled down to at most 1600 pixels wide. |
| `send_keys` | Presses keys and shortcuts such as `ctrl+s`, `alt+F4`, `Return`, `ctrl+a ctrl+c` (on macOS: `cmd+s`). |
| `type_in_app` | Types text into the focused window. |

**macOS** needs nothing extra, but macOS asks for permission the first time:

- **Automation** (for windows and keys): macOS asks whether your terminal app, or `node` when the companion starts at login, may control "System Events". Click **OK**. If you clicked "Don't Allow", change it in System Settings → Privacy & Security → Automation.
- **Accessibility** (for `send_keys`, `type_in_app`, window titles, `close_window`): System Settings → Privacy & Security → Accessibility → **+** → add your terminal app (Terminal, iTerm, …), or the `node` program when the companion starts at login (find its path with `which node`; in the file dialog press Cmd+Shift+G to type it). Turn the switch on.
- **Screen Recording** (for `desktop_screenshot`): System Settings → Privacy & Security → Screen & System Audio Recording, same app. Without it the picture shows only the desktop background.

**Linux** reads applications from the `.desktop` files of your desktop menu and uses small helper programs for the rest:

| Session | Install | Gives you |
|---|---|---|
| X11 (Xorg) | Debian/Ubuntu: `sudo apt install xdotool wmctrl scrot` · Fedora: `sudo dnf install xdotool wmctrl scrot` | keys and typing (xdotool), windows (wmctrl), screenshots (scrot; gnome-screenshot, maim or ImageMagick `import` also work) |
| Wayland | Debian/Ubuntu: `sudo apt install grim wtype ydotool` · Fedora: `sudo dnf install grim wtype ydotool` | screenshots (grim on Sway/Hyprland; gnome-screenshot on GNOME, spectacle on KDE), keys and typing (wtype on Sway/Hyprland; ydotool on GNOME/KDE, which needs its `ydotoold` service running) |

`gtk-launch` (part of GTK) is used to start applications when it is installed. On Wayland, GNOME and KDE do not let other programs list, focus or close windows, so those three tools are not offered there (apps that run through XWayland can be reached when `wmctrl` is installed). Choose an "X11"/"Xorg" session at the login screen if you need them. If the companion runs as a systemd service and the desktop tools say "No graphical session", run `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE` and restart it.

**Windows:** the desktop tools work through Windows PowerShell, which is part of Windows. **They have not been tested on Windows yet.** See [Working in applications](#working-in-applications).

## Terminal sessions

`run_command` runs one command and forgets everything. A terminal session is a shell that stays open, so the agent can work the way you do in a terminal window: run a command, read what it printed, decide, run the next one. The folder it `cd`'d into, the variables it `export`ed and the programs still running (a Python prompt, `ssh`, a database client, a long build) are all still there on the next call.

| Tool | What it does |
|---|---|
| `terminal_open` | Starts a session: your own shell (or `shell`, such as `bash` or `python3`), in your home folder or in `cwd`, with an optional `name`. |
| `terminal_send` | Types `input`, presses Enter, and returns what the session printed. Control keys work too, such as Ctrl-C (`\u0003`) or Ctrl-D (`\u0004`). |
| `terminal_read` | Returns what was printed since the last call; it can wait for the running command to finish or for some text. |
| `terminal_interrupt` | Presses Ctrl-C to stop the running command. |
| `terminal_close` | Ends the session and everything running in it. |
| `terminal_list` | Lists the open sessions, what runs in them and their folders. |

Like every computer tool, each one asks for your approval first in the extension. `terminal_read` and `terminal_list` only look and are marked read-only, which matters when another browser reaches this computer as a remote MCP server: there they skip the question in "Ask before acting" mode.

**When a call comes back.** `terminal_send` returns as soon as the command has finished (the shell shows its prompt again; the result gives the exit code and the current folder), or when the text in `wait_for` appears (for example `password:` or `>>> `), or when nothing new was printed for `quiet_ms` (0.8 seconds by default: the program is probably waiting for input), or after `timeout_sec` (30 seconds by default, at most 10 minutes). If a program is still running, the result says so and names it, and the agent can answer it, wait with `terminal_read`, or stop it with `terminal_interrupt`. The output comes back as plain text: colors and other terminal codes are removed, a progress bar shows only its last state, and the command the agent typed is not repeated.

**A real terminal.** On macOS and Linux the shell runs on a pseudo-terminal, so programs behave as in a terminal window: `sudo` and `ssh` can ask for a password, `python3` and `node` show their prompts, Ctrl-C stops the running program. The companion gets the terminal from the `script` program that comes with macOS and Linux, or from Python when `script` is missing. With neither, the session runs on plain pipes and says so; programs that insist on a terminal may then not work. A session presents itself as a simple terminal (`TERM=dumb`, 200 columns), so full-screen programs such as `vim`, `top` or `less` are of no use there; the agent is told to use their non-interactive forms instead.

**Your shell, slightly adjusted.** A session runs your login shell (zsh or bash; if yours is fish, bash) with your usual start-up files, prompt and PATH. For zsh and bash the companion adds an invisible marker before each prompt, so it knows exactly when a command has finished. It also keeps the agent's command history apart from yours (in `~/.agent-automation/terminal/`), allows `#` comments, and turns off `!` history expansion, which would otherwise mangle commands such as `echo "done!"`. The small start-up files that do this are in `~/.agent-automation/terminal/` and are rewritten whenever a session starts. Inside a session `AGENT_AUTOMATION_TERMINAL` is set, in case your own start-up files should behave differently there.

**Limits and clean-up.** At most 8 sessions run at a time. A session keeps the last 256 KB of output the agent has not read yet; one call returns at most 60,000 characters (the beginning and the end, with a note saying how much was left out). A session that the agent has not used and that printed nothing for 30 minutes is closed (`terminalIdleMinutes` in the settings; 0 means never). **Close all terminal sessions** in Settings → Computer tools closes them at once (`POST /terminals/close-all`); stopping the companion and turning off shell commands do too. Closing a session also ends what was started in it, including background jobs; a program started with `nohup` keeps running.

**Passwords.** When the agent answers something that looks like a password prompt, `companion.log` shows only the length of the answer. (Programs turn off the echo while you type a password, so the answer does not appear in the session's output either.)

**Windows.** A session is Windows PowerShell connected through plain pipes. A real console (ConPTY) would need native code, which a one-file companion cannot include, so console programs that ask questions or draw on the screen may not work there; commands and scripts do. `terminal_interrupt` ends the programs started from the session. **This has not been tested on Windows yet.**

## Working in applications

To let the agent work inside your applications (write in TextEdit or Notepad, fill in an Excel sheet, read a document that is open), the companion offers these tools besides the desktop tools above. They are part of the desktop tools and can be turned off with them.

| Tool | Where | What it does |
|---|---|---|
| `app_open_file` | all | Opens a file in its default application or a named one, and reports the window that shows it. |
| `app_read_text` | all | Reads all the text in an app window: Select All and Copy, then the clipboard is read. |
| `app_write_text` | all | Replaces, appends or inserts text in an app window by pasting it. |
| `run_applescript` | macOS | Runs AppleScript or JavaScript for Automation (`osascript`) and returns the result. |
| `run_powershell` | Windows | Runs a PowerShell script, for example to control Excel or Word through COM. |

**Reading and writing through the clipboard** works with almost any app that edits text: TextEdit, Notepad, gedit, VS Code, text fields on web pages. `app_read_text` brings the window to the front, presses Select All and Copy (cmd+A cmd+C on macOS, Ctrl+A Ctrl+C elsewhere), reads the clipboard, then presses → so the text is no longer selected and typing next cannot replace it. The cells of a spreadsheet come back as tab-separated text. `app_write_text` puts the text on the clipboard, brings the window to the front, then selects everything and pastes over it (`replace`), moves to the end and pastes (`append`: cmd+↓ on macOS, Ctrl+End elsewhere), or pastes at the cursor (`insert`). Saving is a separate step (`send_keys` with cmd+S or Ctrl+S). Both put your clipboard back afterwards, **but only text**: an image or a file you had copied is gone. Both press keys in that window for a moment, so don't type while they run. They need what `send_keys` needs, and on Linux a clipboard program too: `xclip` or `xsel` (X11, `sudo apt install xclip`) or `wl-clipboard` (Wayland). `app_read_text` changes the selection and the clipboard briefly, so it is not marked read-only.

**AppleScript (macOS)** is the precise way into apps that can be scripted: TextEdit, Pages, Numbers, Keynote, Microsoft Excel and Word, Mail, Safari, Finder, Terminal and many more. The tool's description gives the agent examples to adapt, such as `tell application "Microsoft Excel" to get value of range "A1:C5" of active sheet` or `tell application "TextEdit" to set text of front document to "…"`. The first time a script controls an app, macOS asks whether your terminal app (or `node`, when the companion starts at login) may control it, and the script waits for your answer. You can change this later in System Settings → Privacy & Security → **Automation**. Scripts can also run shell commands, so `run_applescript` is off when shell commands are off.

**PowerShell (Windows)** reaches Office through COM: `New-Object -ComObject Excel.Application` or `Word.Application`, or an Excel that is already open. It runs any PowerShell, so it too is off when shell commands are off.

**Linux** has no common way to script applications. The clipboard pair, `send_keys`, `type_in_app` and screenshots cover editors. For office documents, LibreOffice's command line is the reliable route, through `run_command` or a terminal session: `soffice --headless --convert-to xlsx report.csv` (or `--convert-to csv`, `pdf`, `docx`, …), and macros with `soffice --headless "macro:///Standard.Module1.Main"`. The extension's `read_file` already reads the .xlsx and .docx files this produces.

**Windows desktop tools.** On Windows all desktop and application tools go through Windows PowerShell: windows are listed with `Get-Process` and brought to the front with `WScript.Shell` (Windows sometimes refuses to let a background program do that), keys are sent with SendKeys (the Windows key cannot be pressed), screenshots use System.Drawing, and the applications come from the Start menu and the App Paths registry key. **They have not been tested on Windows yet**, and Settings → Computer tools says so.

## Settings file

The settings live in `~/.agent-automation/companion.json`. You normally change them from the extension. You can also edit the file directly: the companion notices the change within a few seconds.

```json
{
  "token": "…",
  "allowShell": true,
  "allowWrite": true,
  "commandTimeoutSec": 120,
  "desktopTools": true,
  "terminalIdleMinutes": 30,
  "mcpServers": {},
  "llmUpstreams": {
    "lmstudio": { "url": "http://localhost:1234/v1" },
    "ollama": { "url": "http://localhost:11434/v1" }
  },
  "tunnel": { "autostart": false, "kind": "quick", "exposeLlm": true, "exposeMcp": false }
}
```

- `commandTimeoutSec` is how long a shell command may run before it is stopped, together with everything it started. The agent can ask for a different limit for a single command.
- `terminalIdleMinutes` is how long a terminal session may sit unused (and silent) before it is closed. Decimals are allowed; `0` means never.
- `llmUpstreams` are the model servers reachable at `/llm/<name>/…`. Names may use letters, digits, `_` and `-`, up to 32 characters. An optional `"apiKey"` is sent to that server as `Authorization: Bearer …`; the extension can set it but never read it back.
- `tunnel`: `kind` is `"quick"` or `"named"`; a named tunnel also has `namedToken` (never shown by the extension) and `namedUrl` (its public address).
- If the file is damaged, the companion saves it as `companion.json.broken-<time>`, keeps the token if it can still read it, and starts with the default settings.
- **To get a new token,** stop the companion, delete `companion.json` and start it again. Your MCP servers are stored in the same file, so copy them out first.

## Adding MCP servers

The `mcpServers` section uses the same format as Claude Desktop's configuration, so you can paste entries from an MCP server's documentation:

```json
"mcpServers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"]
  },
  "github": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }
  },
  "fetch": { "command": "uvx", "args": ["mcp-server-fetch"], "disabled": true }
}
```

- Server names may use letters, digits, `_` and `-`, up to 32 characters. The agent sees the tools as `filesystem__read_file` and so on.
- Optional fields: `env` (extra environment variables), `cwd` (working folder) and `disabled`.
- Only local (stdio) servers belong here. Add remote (URL) MCP servers in the extension's own MCP settings.
- Commands like `npx`, `uvx` and `docker` are found through the PATH from your login shell, even when the companion was started at login.
- If a server crashes, it is restarted after 1, 5 and 15 seconds. After that the companion gives up until one of the server's tools is called or the settings change. The extension's Computer tools section shows each server's state and its last error messages.

## Troubleshooting

- **"Port 8765 is already in use".** The companion is probably already running, for example through autostart. Otherwise start it with `--port 8766` and change the URL in the extension to match.
- **The extension says "401" or "wrong token".** Copy the token again with `node agent-companion.mjs --print-token`.
- **"403 Forbidden".** The request came from a web page (including a local page on a different port), or from an address other than `127.0.0.1` or `localhost`. Point the extension at `http://127.0.0.1:8765`.
- **An MCP server shows "error".** Read its error text in Settings → Computer tools, or in `companion.log`.
  - "Command not found": install the program, or put its full path in `command`.
  - "does not support Node vXX": a different `node` was found than the one you expected. Put the full path to the right `node` in `command`.
  - A first `npx -y …` run downloads the package, so the server can show "starting" for a while.
- **macOS asks whether "node" may access your Documents, Desktop or Downloads.** That is macOS privacy protection. Allow it if you want the agent to work with files there.
- **Aliases from `~/.zshrc` don't work in commands.** Commands run in a non-interactive login shell. They get your PATH but not your aliases or shell functions.
- **The tunnel says "Could not download cloudflared".** The computer could not reach GitHub. Install cloudflared yourself (see [Remote access](#remote-access-cloudflare-tunnel)) and press Start again; the installed one is then used.
- **The tunnel stops with an error.** Settings → Remote access shows cloudflared's last lines; all of them are in `~/.agent-automation/tunnel.log`. A quick tunnel needs outgoing internet access to Cloudflare (ports 443 and 7844).
- **The other browser gets "403".** The path is not shared through the tunnel: turn on "Expose local models" or "Expose computer tools", or tick the model in the list. **"401"**: paste the current connection code again. **"429"**: too many wrong tokens; wait 15 minutes.
- **The other browser stopped working after a restart.** A quick tunnel's address changes each time it starts. Copy the new connection code, or use a named tunnel.
- **A desktop tool says "osascript did not answer" (macOS).** macOS is showing a permission dialog. Click OK, then try again. See [Desktop tools](#desktop-tools).
- **`run_applescript` says "Not authorized to send Apple events".** You clicked "Don't Allow" when macOS asked. Allow it in System Settings → Privacy & Security → Automation.
- **`app_read_text` says "Nothing was copied".** The window had no text field with the keyboard focus, or the app does not copy text. Click into the text once, or use `run_applescript` / `run_powershell` for that app.
- **A terminal session says it uses "plain pipes".** Neither `script` nor `python3` was found. On Linux install util-linux (`script`) or Python 3.
- **A terminal session's start-up looks stuck.** Your shell's start-up files may be asking something (for example an update question). The agent sees the question and can answer it. To skip such steps in agent sessions, check for `AGENT_AUTOMATION_TERMINAL` in your start-up files.
- **Logs:** `~/.agent-automation/companion.log`. It is capped at about 2 MB; one older copy is kept as `companion.log.1`. The tunnel has its own log, `tunnel.log`.

## Development

Run the tests with `node --test companion/test.mjs`. They use temporary folders and random ports, and they never touch your real settings, clipboard, desktop or login items. Tunnels in the tests use a fake cloudflared and never reach the network; desktop and application tools use stand-in helper programs (including a small fake editor and clipboard, and a fake `powershell` for the Windows paths, which are checked only for the commands they would run). Terminal sessions run real shells (`bash`, `zsh`, `python3 -i`, `cat`, `sleep`) as hidden processes in temporary folders, and `run_applescript` runs `return 1 + 1` once on macOS.

Opt-in extras: `COMPANION_TEST_TUNNEL=1` opens one real quick tunnel through the installed cloudflared and stops it again; `COMPANION_TEST_DOWNLOAD=1` downloads the real cloudflared into a temporary folder; `COMPANION_TEST_DESKTOP=1` (macOS) runs `list_apps`, `list_windows` and `desktop_screenshot` for real (nothing is typed or clicked); `COMPANION_TEST_CLIPBOARD=1` uses the real clipboard.
