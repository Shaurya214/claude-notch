#!/usr/bin/env python3
"""Claude Notch bridge: Claude Code hooks/statusline -> GNOME Shell extension over a Unix socket.

  notch-hook.py                    hook mode (Claude Code pipes hook JSON on stdin)
  notch-hook.py statusline [CMD]   statusline mode; CMD is your previous statusline, if any
  notch-hook.py install | uninstall
"""
import ast
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
from pathlib import Path

SOCK = Path(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}') / 'claude-notch.sock'
HERE = Path(__file__).resolve()
UUID = 'claude-notch@shaurya214.github.io'
EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
          'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure']
PY = '/usr/bin/python3' if os.path.exists('/usr/bin/python3') else sys.executable
CMD = f'{PY} {shlex.quote(str(HERE))}'


def parent(pid):
    try:
        return int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
    except (OSError, IndexError, ValueError):
        return 0


def comm(pid):
    try:
        return Path(f'/proc/{pid}/comm').read_text().strip()
    except OSError:
        return ''


def lineage():
    """(claude pid, pids above it). Claude lives as long as the session; the pids above lead to the terminal window."""
    pids, pid = [], os.getppid()
    while pid > 1:
        pids.append(pid)
        pid = parent(pid)
    claude = next((p for p in pids if comm(p) == 'claude'), None)
    return claude, (pids[pids.index(claude) + 1:] if claude else pids)


def send(event, wait=False):
    event['claude_pid'], event['pids'] = lineage()
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(None if wait else 1)
        s.connect(str(SOCK))
        s.sendall(json.dumps(event).encode() + b'\n')
        return s.makefile().readline() if wait else ''


def hook():
    event = json.load(sys.stdin)
    try:
        reply = send(event, wait=event.get('hook_event_name') == 'PermissionRequest')
    except OSError:
        return  # notch not running: Claude carries on with its own prompt
    decision = json.loads(reply) if reply.strip() else {}
    if decision.get('behavior'):  # {} = "ask in terminal": no output, Claude shows its dialog
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': decision}}))


def statusline(cmd):
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
        send({**data, 'hook_event_name': 'StatusLine'})
    except (OSError, ValueError):
        data = {}
    if cmd:
        sys.stdout.write(subprocess.run(cmd, shell=True, input=raw, capture_output=True, text=True).stdout)
        return
    pct = (data.get('context_window') or {}).get('used_percentage')
    print((data.get('model') or {}).get('display_name', 'Claude') + (f' · {pct:.0f}% context' if pct is not None else ''))


def ours(h):
    return str(HERE) in (h or {}).get('command', '')


def set_enabled(on):
    cur = subprocess.run(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'],
                         capture_output=True, text=True).stdout.strip()
    exts = [e for e in ast.literal_eval(cur.removeprefix('@as ') or '[]') if e != UUID]
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(exts + [UUID] * on)], check=True)


def edit_settings(change):
    path = Path.home() / '.claude' / 'settings.json'
    s = json.loads(path.read_text()) if path.exists() else {}
    if path.exists():
        shutil.copy(path, path.with_name('settings.json.claude-notch.bak'))
    change(s)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('settings.json.tmp')
    tmp.write_text(json.dumps(s, indent=2) + '\n')
    tmp.replace(path)


def add_ours(s):
    hooks = s.setdefault('hooks', {})
    for ev in EVENTS:
        groups = hooks.setdefault(ev, [])
        if not any(ours(h) for g in groups for h in g.get('hooks', [])):
            # PermissionRequest keeps the default 600s timeout: it waits for your click.
            groups.append({'hooks': [{'type': 'command', 'command': CMD} | ({} if ev == 'PermissionRequest' else {'timeout': 5})]})
    sl = s.get('statusLine') or {}
    if not ours(sl):
        old = sl.get('command')
        s['statusLine'] = {**sl, 'type': 'command', 'command': f'{CMD} statusline' + (f' {shlex.quote(old)}' if old else '')}


def remove_ours(s):
    hooks = s.get('hooks', {})
    for ev in list(hooks):
        for g in hooks[ev]:
            g['hooks'] = [h for h in g.get('hooks', []) if not ours(h)]
        hooks[ev] = [g for g in hooks[ev] if g['hooks']]
        if not hooks[ev]:
            del hooks[ev]
    if 'hooks' in s and not hooks:
        del s['hooks']
    sl = s.get('statusLine')
    if ours(sl):
        old = shlex.split(sl['command'])[3:]  # [python, script, 'statusline', old?]
        if old:
            sl['command'] = old[0]
        else:
            del s['statusLine']


def install():
    edit_settings(add_ours)
    link = Path.home() / '.local/share/gnome-shell/extensions' / UUID
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.is_symlink():
        link.symlink_to(HERE.parent / 'extension')
    set_enabled(True)
    print(f'Installed. On Wayland, log out and back in once so GNOME Shell picks up {UUID}.')


def uninstall():
    edit_settings(remove_ours)
    set_enabled(False)
    link = Path.home() / '.local/share/gnome-shell/extensions' / UUID
    if link.is_symlink():
        link.unlink()
    print('Uninstalled.')


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        hook()
    elif args[0] == 'statusline':
        statusline(args[1] if len(args) > 1 else None)
    elif args[0] in ('install', 'uninstall'):
        globals()[args[0]]()
    else:
        sys.exit(__doc__)
