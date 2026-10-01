# Claude Notch: design

## Goal
A personal tool for seeing what every Claude Code session is doing and answering its permission prompts from a notch at the top of the screen, without switching to the terminal. Target: Ubuntu 24.04, GNOME 46, Wayland.

## v1 scope
- Live status per session and the current tool
- Approve/deny permissions
- Usage meters
- Jump to terminal
- Alerts and sound

## Architecture (option A: the extension owns the socket)
- **Why an extension:** GNOME on Wayland has no layer-shell, so a normal app can't pin itself to the top of the screen. A GNOME Shell extension draws inside the compositor.
- **`notch-hook.py`** (Python stdlib) is one script with several modes: hook, statusline wrapper, install and uninstall. It sends one JSON line per event to `$XDG_RUNTIME_DIR/claude-notch.sock`. That directory is mode 0700, so only this user can connect. Each event is tagged with `claude_pid`, used to prune sessions that crash without a `SessionEnd`. It also carries the ancestor pids above Claude, which lead to the terminal window.
- **`extension/state.js`** holds pure state functions, so tests run with plain `gjs`.
- **`extension/extension.js`** contains the `Gio.SocketService`, the panel pill and a top-chrome card.
- **Rejected:** a separate daemon over D-Bus. It adds a process and an IPC layer that a personal v1 doesn't need.
- **Rejected:** a file inbox. It can't carry an answer back for approvals.

## Hooks used
- **Events:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`.
- **Timeouts:** every hook except `PermissionRequest` runs synchronously with a 5s timeout. That keeps events in order, and Python starts in about 20ms. `PermissionRequest` keeps the default 600s.
- **Usage data:** the statusline JSON provides `rate_limits` and `context_window`.

## Permission flow (verified against Claude Code 2.1.286)
1. The hook connects, sends the request, and blocks reading one reply line.
2. **Correction to the docs:** the terminal dialog is shown at the same time as the hook runs. Whichever answers first wins.
3. A reply of `{behavior: allow|deny, …}` is printed as `hookSpecificOutput.decision`. An empty reply or EOF means the hook prints nothing, and the terminal dialog handles it.
4. If you answer in the terminal, Claude does **not** cancel the waiting hook. The extension drops the card when it sees `PostToolUse*` with the same `tool_input`, or `Stop`, `StopFailure`, `UserPromptSubmit` or `SessionEnd` for that session.
5. "Always" returns `updatedPermissions` set to Claude's own `permission_suggestions`, minus `setMode`, so the notch never flips you into accept-edits.
6. `Notification(permission_prompt)` follows every request. It doesn't re-alert while the session is already waiting.

## Questions (`AskUserQuestion`), verified against Claude Code 2.1.286
- A question arrives as an ordinary `PermissionRequest` with `tool_name: AskUserQuestion` and `tool_input.questions[]` (`question`, `header`, `options[{label, description}]`, `multiSelect`). The docs don't mention this, so it was found by experiment.
- The hook answers it by returning `{behavior: "allow", updatedInput: {...tool_input, answers}}`, where `answers` maps each question's text to the chosen label, or `"a, b"` (in option order) for multi-select. Claude shows it as the user's answer.
- UI: a lone single-select question answers on click. Anything else (several questions or multi-select) toggles picks, and Submit enables once every question has one.
- "Answer in terminal" replies `{}`, which closes the card and leaves Claude's dialog to handle it. Free text ("Other") is not offered in the notch.
- Answering in the terminal makes `PostToolUse` arrive with extra `answers` and `annotations` keys in `tool_input`. Resolution therefore matches `tool_name` plus a subset of the request's `tool_input` keys, not equality.

## Failure modes
- **Extension not running:** connect fails, the hook exits 0 with no output, and Claude behaves normally.
- **Extension disabled mid-request:** pending connections are closed. The hooks see EOF and the terminal dialog takes over.
- **Shell crashed:** a stale socket file leads to connection refused, handled the same as "not running". The extension removes the socket file on startup.

## Testing
- `tests/test_state.js` covers state transitions, resolution and decisions.
- `tests/test_hook.py` covers the relay, the no-notch fallback, and an install/uninstall round-trip that preserves your own hooks and statusline.
- Manual checks done:
  - Real Claude Code in tmux against a fake socket server, to verify the permission semantics above.
  - The extension running in a nested `gnome-shell --nested --wayland` with isolated dconf and extensions dirs, covering:
    - allow
    - deny
    - answered in the terminal
    - hook killed
    - disable and re-enable with a request open

## Subagents, chat, free text, settings (v2), verified against Claude Code 2.1.286
- **Events:** `SubagentStart` (`agent_id`, `agent_type`) and `SubagentStop` (plus `last_assistant_message`) are registered by `install`. A subagent's own tool calls carry `agent_id`/`agent_type` on `PreToolUse`/`PostToolUse`, so they update that agent's row instead of the session's status. `SubagentStop` for an id never started is ignored (Claude Code emits some).
- **Background agents outlive the turn:** the main `Stop` can arrive while an agent still runs. So a session with running agents shows as working (`effectiveStatus`), and `Stop` raises the done-alert only when none are running.
- **Chat:** per session, the last 12 entries from `UserPromptSubmit.prompt`, `Stop.last_assistant_message` and subagent reports, 4000 characters each. Prompts starting with `<` (system notifications) are skipped. History only covers what happened since the extension started. The built panel is cached until the history changes, so scrolling survives other events.
- **Free text:** an "Other" entry under every question. For a single-select question typed text replaces the pick, for multi-select it is appended. Claude accepts arbitrary text as the answer.
- **Keyboard:** the card is a chrome actor and gets no keys by default. Clicking the entry takes a `GrabHelper` grab (popup action mode) with the entry focused, from a capture-phase handler (button press or touch begin). Do not hook `key-focus-in` instead: releasing the grab restores the old focus, which re-grabs and traps the keyboard. The grab owner has to be the card (focus outside the owner receives no keys). The entry handles Escape itself, because the grab helper does not see keys aimed at an entry inside its owner. The grab is also released when the card hides.
- **Cards are built once per request** and re-parented, so typed text and picks survive other requests arriving.
- **Settings:** GSettings schema `org.gnome.shell.extensions.claude-notch` (compiled by `install`, git-ignored), `prefs.js` with Adw (switches, one color button per status). Changes apply live. Per-status colors are applied as inline styles.

## Deliberately left out
- Transcript history from before the extension started (would mean reading the transcript JSONL)
- Other agents (Codex, Gemini)
- Per-tab terminal matching
- Free-text for `ExitPlanMode` / plan approval previews
