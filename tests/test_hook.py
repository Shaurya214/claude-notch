"""Run: python3 tests/test_hook.py"""
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'notch-hook.py'
tmp = Path(tempfile.mkdtemp())
env = {**os.environ, 'XDG_RUNTIME_DIR': str(tmp), 'HOME': str(tmp)}


def run(*args, stdin=''):
    return subprocess.run([sys.executable, SCRIPT, *args], input=stdin, env=env,
                          capture_output=True, text=True, check=True).stdout


perm = json.dumps({'hook_event_name': 'PermissionRequest', 'session_id': 's', 'tool_name': 'Bash',
                   'tool_input': {'command': 'ls'}})

# 1. Notch not running: hook is a silent no-op, Claude's own flow continues.
assert run(stdin=perm) == ''

# 2. Notch running: the hook relays the decision it gets back.
srv = socket.socket(socket.AF_UNIX)
srv.bind(str(tmp / 'claude-notch.sock'))
srv.listen()
seen = []


def serve(replies):
    for reply in replies:
        conn, _ = srv.accept()
        with conn:
            seen.append(json.loads(conn.makefile().readline()))
            conn.sendall(reply)


answer = {'behavior': 'allow', 'updatedInput': {'questions': [], 'answers': {'Which?': 'A, B'}}}
t = threading.Thread(target=serve, args=([b'{"behavior": "allow"}\n', b'{}\n', json.dumps(answer).encode() + b'\n'],))
t.start()
out = json.loads(run(stdin=perm))
assert out == {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {'behavior': 'allow'}}}, out
assert run(stdin=perm) == '', 'empty decision = ask in terminal'
out = json.loads(run(stdin=perm))
assert out['hookSpecificOutput']['decision'] == answer, 'question answers pass through untouched'
t.join()
assert seen[0]['tool_input'] == {'command': 'ls'} and 'pids' in seen[0] and 'claude_pid' in seen[0]

# 3. install/uninstall round-trip keeps the user's own hooks and statusline.
bin_dir = tmp / 'bin'
bin_dir.mkdir()
(bin_dir / 'gsettings').write_text('#!/bin/sh\n[ "$1" = get ] && echo "@as []"\nexit 0\n')
(bin_dir / 'gsettings').chmod(0o755)
env['PATH'] = f'{bin_dir}:{env["PATH"]}'
settings = tmp / '.claude' / 'settings.json'
settings.parent.mkdir()
original = {'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'mine.sh'}]}]},
            'statusLine': {'type': 'command', 'command': "echo 'hi there'", 'padding': 1}}
settings.write_text(json.dumps(original))
run('install')
run('install')  # idempotent
s = json.loads(settings.read_text())
assert len(s['hooks']['Stop']) == 2 and len(s['hooks']['PermissionRequest']) == 1, s['hooks']
assert {'SubagentStart', 'SubagentStop'} <= set(s['hooks']), 'subagent events registered'
assert s['statusLine']['command'].endswith("statusline 'echo '\"'\"'hi there'\"'\"''") and s['statusLine']['padding'] == 1
assert (tmp / '.local/share/gnome-shell/extensions/claude-notch@shaurya214.github.io').is_symlink()
assert run('statusline', "echo 'hi there'", stdin='{}') == 'hi there\n'
run('uninstall')
assert json.loads(settings.read_text()) == original

# 4. A moved/deleted checkout must never block Claude. Plain python exits 2 on a missing script, which blocks PreToolUse.
run('install')
s = json.loads(settings.read_text())
cmd = s['hooks']['PreToolUse'][0]['hooks'][0]['command']
gone = tmp / 'gone.py'
assert subprocess.run([sys.executable, gone], capture_output=True).returncode == 2, 'the failure being guarded against'
r = subprocess.run(['sh', '-c', cmd.replace(str(SCRIPT), str(gone))], input='{}', capture_output=True, text=True)
assert (r.returncode, r.stdout, r.stderr) == (0, '', ''), r
r = subprocess.run(['sh', '-c', cmd], input=json.dumps({'hook_event_name': 'PreToolUse'}), env=env, capture_output=True, text=True)
assert r.returncode == 0, 'the guarded command still runs the real script'

# 5. Re-install upgrades commands written by the older unguarded install, without duplicating anything.
old_cmd = f'/usr/bin/python3 {shlex.quote(str(SCRIPT))}'
s['hooks']['PreToolUse'][0]['hooks'][0]['command'] = old_cmd
s['statusLine']['command'] = f"{old_cmd} statusline {shlex.quote(original['statusLine']['command'])}"
settings.write_text(json.dumps(s))
run('install')
s2 = json.loads(settings.read_text())
assert s2['hooks']['PreToolUse'] == [{'hooks': [{'type': 'command', 'command': cmd, 'timeout': 5}]}], s2['hooks']['PreToolUse']
assert s2['statusLine']['command'].startswith(cmd + ' statusline '), s2['statusLine']
run('uninstall')
assert json.loads(settings.read_text()) == original, 'uninstall of an upgraded install restores your own settings'

print('hook ok')
