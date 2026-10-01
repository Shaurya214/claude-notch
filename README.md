# Claude Notch

A dynamic-island style notch for **Claude Code on Linux (GNOME 46, Wayland)**. It sits in the middle of the top bar and shows what each Claude Code session is doing. When Claude asks for a permission, the notch drops down with a preview and **Allow / Always / Deny** buttons. The terminal prompt stays live too, so you can answer in either place.

- Live status per session (working, needs you, done, error) and the current tool, e.g. `Bash: npm test`
- Permission approvals from the notch: Allow / Always / Deny with a preview
- Claude's multiple-choice questions (`AskUserQuestion`): click an option, or pick several and press Submit. There is also an "Other" box to type your own answer; click it, type, press Enter. Escape releases the keyboard. "Answer in terminal" hands the question back to Claude's own dialog.
- Subagents: each running subagent is listed under its session with the tool it is using. A session whose turn ended but whose agents are still running shows as working, and the "done" sound waits until they finish.
- Chat: the **Chat** chip on a session row shows its recent prompts, Claude's replies and subagent reports (history starts when the extension starts)
- Usage meters: 5-hour and 7-day limits, context % per session (Pro/Max)
- Click a session to focus its terminal window
- Sound and a pulse when Claude finishes or needs you
- Settings (`gnome-extensions prefs claude-notch@shaurya214.github.io`, or the Extensions app): sound, pulse, open-automatically, usage line, and the five status colors

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

After pulling an update, run `./notch-hook.py install` again (it registers any new hook events and recompiles the settings schema) and log out and back in, because GNOME keeps the old extension code loaded until then.

What `install` changes:
- It appends hook entries to `~/.claude/settings.json` and leaves your existing hooks alone. A backup goes to `settings.json.claude-notch.bak`.
- It sets `statusLine` to the bridge. If you already had a status line, it is wrapped and still prints as before. If not, you get `Model · N% context`. A custom status line hides Claude Code's footer key hints.
- It symlinks `extension/` into `~/.local/share/gnome-shell/extensions/` and adds the extension to `org.gnome.shell enabled-extensions`.

`./notch-hook.py uninstall` reverts all of it. It is safe to run either command repeatedly.

The hook commands point at this checkout, so run `uninstall` before moving or deleting it. If you forget, the hooks do nothing (they check that the script exists first) and Claude Code carries on as normal, but the notch stays dark until you reinstall.

## Tests

```sh
gjs -m tests/test_state.js     # session state / decisions
python3 tests/test_hook.py     # hook relay, no-notch fallback, install/uninstall round-trip
```

Debug the extension with `journalctl -f -o cat /usr/bin/gnome-shell`.

The extension itself was checked by running it in a throwaway `gnome-shell --headless --wayland --virtual-monitor 1400x800` with its own settings and runtime dir (so the real notch socket is never touched). Not `--nested`: that runs on X11 and forwards injected input to the host.

## Known limits

- With gnome-terminal, every window belongs to one server process, so "jump to terminal" focuses a gnome-terminal window but not always the right one.
- Usage meters only appear for claude.ai Pro/Max, after the first response in a session.
- The extension only supports GNOME 46 (Ubuntu 24.04). Other versions need their number added to `metadata.json` and testing.

## License

MIT, see [LICENSE](LICENSE).
