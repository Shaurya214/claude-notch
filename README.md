# Claude Notch

A dynamic-island style notch for **Claude Code on Linux (GNOME 46, Wayland)**. It sits in the middle of the top bar and shows what each Claude Code session is doing. When Claude asks for a permission, the notch drops down with a preview and **Allow / Always / Deny** buttons. The terminal prompt stays live too, so you can answer in either place.

- Live status per session (working, needs you, done, error) and the current tool, e.g. `Bash: npm test`
- Permission approvals from the notch
- Usage meters: 5-hour and 7-day limits, context % per session (Pro/Max)
- Click a session to focus its terminal window
- Sound and a pulse when Claude finishes or needs you

## How it works

```
Claude Code ──hook / statusline JSON──▶ notch-hook.py ──Unix socket──▶ GNOME Shell extension
            ◀──allow/deny (PermissionRequest only)──┘   $XDG_RUNTIME_DIR/claude-notch.sock
```

- `notch-hook.py` is registered for the Claude Code hook events and as the statusline. It forwards each event and exits.
- For `PermissionRequest` it waits for your click and prints the decision.
- If the extension isn't running, the script is a silent no-op and Claude behaves as usual.
- `extension/` is the GNOME Shell extension. It owns the socket, keeps session state in memory and draws the pill and card.

## Install

```sh
git clone https://github.com/Shaurya214/claude-notch.git && cd claude-notch
./notch-hook.py install     # hooks + statusline into ~/.claude/settings.json, links + enables the extension
```

Then **log out and back in once**, because GNOME on Wayland only picks up new extensions at login. Start `claude` and the notch appears. It hides itself when no sessions are running.

What `install` changes:
- It appends hook entries to `~/.claude/settings.json` and leaves your existing hooks alone. A backup goes to `settings.json.claude-notch.bak`.
- It sets `statusLine` to the bridge. If you already had a status line, it is wrapped and still prints as before. If not, you get `Model · N% context`. A custom status line hides Claude Code's footer key hints.
- It symlinks `extension/` into `~/.local/share/gnome-shell/extensions/` and adds the extension to `org.gnome.shell enabled-extensions`.

`./notch-hook.py uninstall` reverts all of it. It is safe to run either command repeatedly.

## Tests

```sh
gjs -m tests/test_state.js     # session state / decisions
python3 tests/test_hook.py     # hook relay, no-notch fallback, install/uninstall round-trip
```

Debug the extension with `journalctl -f -o cat /usr/bin/gnome-shell`.

## Known limits

- With gnome-terminal, every window belongs to one server process, so "jump to terminal" focuses a gnome-terminal window but not always the right one.
- Usage meters only appear for claude.ai Pro/Max, after the first response in a session.
- The extension only supports GNOME 46 (Ubuntu 24.04). Other versions need their number added to `metadata.json` and testing.
