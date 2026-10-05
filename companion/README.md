# Agent Automation companion

A small program that runs on your computer and gives the Agent Automation extension tools for that computer. Chrome extensions cannot start programs themselves, so the companion does it for them.

- **Built-in tools:** `run_command` (shell), `read_file`, `write_file`, `list_directory`, `find_files`, `open_path`, `clipboard_read`, `clipboard_write`, `system_info`.
- **Local MCP servers:** it starts the stdio MCP servers you configure (`npx …`, `uvx …`, `docker …`) and passes their tools to the agent as `<server>__<tool>`.

It is a single file, `agent-companion.mjs`. It needs [Node.js](https://nodejs.org) 18 or later and nothing else.

## Start it

```sh
node agent-companion.mjs
```

It prints something like:

```
Agent Automation companion 1.1.0
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

Everything the agent runs is listed in the companion window and in `companion.log`.

**Don't use `--host` to listen on your network.** If you do, the companion prints a warning. Anyone who has the token could then run commands as you, and the token travels unencrypted.

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

## Settings file

The settings live in `~/.agent-automation/companion.json`. You normally change them from the extension. You can also edit the file directly: the companion notices the change within a few seconds.

```json
{
  "token": "…",
  "allowShell": true,
  "allowWrite": true,
  "commandTimeoutSec": 120,
  "mcpServers": {}
}
```

- `commandTimeoutSec` is how long a shell command may run before it is stopped, together with everything it started. The agent can ask for a different limit for a single command.
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
- **Logs:** `~/.agent-automation/companion.log`. It is capped at about 2 MB; one older copy is kept as `companion.log.1`.

## Development

Run the tests with `node --test companion/test.mjs`. They use temporary folders and random ports, and they never touch your real settings, clipboard or login items.
