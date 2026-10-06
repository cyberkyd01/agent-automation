# Agent Automation companion

A small program that runs on your computer and gives the Agent Automation extension tools for that computer. Chrome extensions cannot start programs themselves, so the companion does it for them.

- **Built-in tools:** `run_command` (shell), `read_file`, `write_file`, `list_directory`, `find_files`, `open_path`, `clipboard_read`, `clipboard_write`, `system_info`.
- **Desktop tools** (Linux and macOS): `list_apps`, `launch_app`, `list_windows`, `focus_window`, `close_window`, `desktop_screenshot`, `send_keys`, `type_in_app`. See [Desktop tools](#desktop-tools).
- **Local MCP servers:** it starts the stdio MCP servers you configure (`npx …`, `uvx …`, `docker …`) and passes their tools to the agent as `<server>__<tool>`.
- **Remote access:** with one click it opens a Cloudflare tunnel, so a browser on another computer can use your local models (LM Studio, Ollama, …) through the companion. See [Remote access](#remote-access-cloudflare-tunnel).

It is a single file, `agent-companion.mjs`. It needs [Node.js](https://nodejs.org) 18 or later and nothing else.

## Start it

```sh
node agent-companion.mjs
```

It prints something like:

```
Agent Automation companion 1.2.0
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
- **Websites are blocked.** Requests from web pages are refused, even if a page somehow had the token. This includes pages served from your own computer, such as a development server on another port: a page on `localhost` or `127.0.0.1` is accepted only when it uses the companion's own port. The companion accepts requests only from the extension and from local tools that send no web-page origin. It sends no CORS headers and refuses requests addressed to any name other than `127.0.0.1` or `localhost`, which blocks DNS-rebinding attacks.
- **You approve every action.** By default the extension asks before each computer tool runs, even when you have chosen "auto" for browser actions. You can change this in Settings → Computer tools.
- **You can switch off risky tools.** Turning off "shell commands" (`allowShell`) removes `run_command` and `open_path`. Turning off "file writing" (`allowWrite`) removes `write_file`.

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

**How it is protected.** Every request through the tunnel needs the companion's token, like local requests. The address alone is not enough. After 10 wrong tokens from one address, that address is blocked for 15 minutes. The connection between the other browser and Cloudflare is encrypted (HTTPS). Requests from web pages are refused; only the extension (Chrome or Firefox) can use the tunnel. Anyone who has both the address and the token can use what you expose, so treat the connection code like a password.

**Connect the other browser.** Settings → Remote access shows a connection code (`aa1:…`). It holds the address, the token and the model addresses. In the other browser, open **Settings → Providers → Add from connection code** and paste it.

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

So in an OpenAI-compatible client the base URL is `<companion address>/llm/<name>` and the API key is the companion's token. Every method works. Bodies and answers are passed through as they are, including streamed answers (server-sent events), which arrive piece by piece. The `Authorization` header is replaced: the model server gets none, or `Bearer <apiKey>` if you set an `apiKey` for it. If the model server is not running you get a "502" with a message such as `LM Studio is not running at http://localhost:1234/v1`. Closing the request (the Stop button) also stops the request to the model server. A streamed answer may pause for up to 10 minutes between pieces. Through the tunnel, Cloudflare gives up when an answer has not started within about 100 seconds ("524"), so use streaming for slow models.

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

**Windows:** desktop tools are not available yet.

## Settings file

The settings live in `~/.agent-automation/companion.json`. You normally change them from the extension. You can also edit the file directly: the companion notices the change within a few seconds.

```json
{
  "token": "…",
  "allowShell": true,
  "allowWrite": true,
  "commandTimeoutSec": 120,
  "desktopTools": true,
  "mcpServers": {},
  "llmUpstreams": {
    "lmstudio": { "url": "http://localhost:1234/v1" },
    "ollama": { "url": "http://localhost:11434/v1" }
  },
  "tunnel": { "autostart": false, "kind": "quick", "exposeLlm": true, "exposeMcp": false }
}
```

- `commandTimeoutSec` is how long a shell command may run before it is stopped, together with everything it started. The agent can ask for a different limit for a single command.
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
- **Logs:** `~/.agent-automation/companion.log`. It is capped at about 2 MB; one older copy is kept as `companion.log.1`. The tunnel has its own log, `tunnel.log`.

## Development

Run the tests with `node --test companion/test.mjs`. They use temporary folders and random ports, and they never touch your real settings, clipboard, desktop or login items. Tunnels in the tests use a fake cloudflared and never reach the network; desktop tools use stand-in helper programs.

Opt-in extras: `COMPANION_TEST_TUNNEL=1` opens one real quick tunnel through the installed cloudflared and stops it again; `COMPANION_TEST_DOWNLOAD=1` downloads the real cloudflared into a temporary folder; `COMPANION_TEST_DESKTOP=1` (macOS) runs `list_apps`, `list_windows` and `desktop_screenshot` for real (nothing is typed or clicked); `COMPANION_TEST_CLIPBOARD=1` uses the real clipboard.
