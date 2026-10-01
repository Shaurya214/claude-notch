// Run: gjs -m tests/test_state.js
import {newState, apply, prune, summary, preview, resolves, decision} from '../extension/state.js';

function eq(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const st = newState();
const ev = (hook_event_name, extra = {}) => apply(st, {session_id: 'a', cwd: '/x/proj', claude_pid: 42, hook_event_name, ...extra});

ev('SessionStart');
eq(summary(st), {status: 'idle', text: 'Idle'}, 'new session idle');

ev('PreToolUse', {tool_name: 'Bash', tool_input: {command: 'npm test'}});
eq(summary(st), {status: 'working', text: 'Bash: npm test'}, 'tool shown');

eq(ev('PermissionRequest', {tool_name: 'Bash', tool_input: {command: 'rm x'}}), 'attention', 'permission alerts');
eq(ev('Notification', {notification_type: 'idle_prompt'}), null, 'idle_prompt ignored');
eq(ev('Notification', {notification_type: 'permission_prompt'}), null, 'no double alert while waiting');

apply(st, {session_id: 'b', hook_event_name: 'Stop', claude_pid: 43});
eq(summary(st), {status: 'waiting', text: 'Needs you  ·  2'}, 'most urgent wins');

eq(ev('Stop'), 'done', 'stop alerts done');
ev('StatusLine', {context_window: {used_percentage: 37}, rate_limits: {five_hour: {used_percentage: 12}}});
eq(st.sessions.get('a').context, 37, 'context from statusline');
eq(st.limits.five_hour.used_percentage, 12, 'limits from statusline');

prune(st, pid => pid === 42);
eq([...st.sessions.keys()], ['a'], 'dead claude pruned');

ev('SessionEnd');
eq(summary(st), null, 'session end removes');

eq(preview('Edit', {file_path: '/a/b.js', new_string: 'x\ny'}), 'Edit: /a/b.js\nx\ny', 'edit preview');

const req = {session_id: 'a', tool_input: {command: 'ls'},
    permission_suggestions: [{type: 'addRules', rules: []}, {type: 'setMode', mode: 'acceptEdits'}]};
eq(resolves(req, {session_id: 'a', hook_event_name: 'PostToolUse', tool_input: {command: 'ls'}}), true, 'answered in terminal');
eq(resolves(req, {session_id: 'a', hook_event_name: 'PostToolUse', tool_input: {command: 'pwd'}}), false, 'other tool');
eq(resolves(req, {session_id: 'b', hook_event_name: 'Stop'}), false, 'other session');
eq(resolves(req, {session_id: 'a', hook_event_name: 'Stop'}), true, 'turn ended');
eq(decision('always', req), {behavior: 'allow', updatedPermissions: [{type: 'addRules', rules: []}]}, 'always skips setMode');

print('state ok');
