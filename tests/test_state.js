// Run: gjs -m tests/test_state.js
import {
    newState, apply, prune, summary, preview, resolves, decision, isQuestion, pendingLabel, answerDecision,
    answered, statusText, agentLine,
} from '../extension/state.js';

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

const req = {session_id: 'a', tool_name: 'Bash', tool_input: {command: 'ls'},
    permission_suggestions: [{type: 'addRules', rules: []}, {type: 'setMode', mode: 'acceptEdits'}]};
eq(resolves(req, {session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'ls'}}), true, 'answered in terminal');
eq(resolves(req, {session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'pwd'}}), false, 'other tool');
eq(resolves(req, {session_id: 'b', hook_event_name: 'Stop'}), false, 'other session');
eq(resolves(req, {session_id: 'a', hook_event_name: 'Stop'}), true, 'turn ended');
const ask = {session_id: 'a', tool_name: 'AskUserQuestion', tool_input: {questions: [
    {question: 'Size?', options: [{label: 'S'}, {label: 'L'}], multiSelect: false},
    {question: 'Toppings?', options: [{label: 'Cheese'}, {label: 'Olives'}, {label: 'Basil'}], multiSelect: true}]}};
eq(isQuestion(ask), true, 'question detected');
eq(isQuestion(req), false, 'bash is not a question');
eq(pendingLabel(ask), 'Size?', 'question in pill');
eq(pendingLabel({tool_name: 'Bash'}), 'Allow Bash?', 'tool in pill');
const out = answerDecision(ask, [new Set(['L']), new Set(['Basil', 'Cheese'])]);
eq(out.updatedInput.answers, {'Size?': 'L', 'Toppings?': 'Cheese, Basil'}, 'answers keyed by question, in option order');
eq(out.updatedInput.questions, ask.tool_input.questions, 'questions kept');
// terminal answer: PostToolUse carries extra keys, must still resolve
eq(resolves(ask, {session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion',
    tool_input: {...ask.tool_input, answers: {'Size?': 'S'}, annotations: {}}}), true, 'question answered in terminal');
eq(resolves(ask, {session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: ask.tool_input}), false, 'tool name must match');
eq(decision('always', req),{behavior: 'allow', updatedPermissions: [{type: 'addRules', rules: []}]}, 'always skips setMode');

// free-text answers
const typed = answerDecision(ask, [new Set(['L']), new Set(['Basil'])], ['', 'extra "spicy" ✓']);
eq(typed.updatedInput.answers, {'Size?': 'L', 'Toppings?': 'Basil, extra "spicy" ✓'}, 'multi-select appends typed text');
eq(answerDecision(ask, [new Set(['L']), new Set()], ['  my own size ', 'x']).updatedInput.answers['Size?'], 'my own size', 'single-select: typed text replaces pick');
eq([answered(new Set(), ''), answered(new Set(), '  '), answered(new Set(['a']), ''), answered(new Set(), 'hi')], [false, false, true, true], 'answered()');

// subagents
const sub = newState();
const sev = (hook_event_name, extra = {}) => apply(sub, {session_id: 'z', cwd: '/p', claude_pid: 7, hook_event_name, ...extra});
sev('UserPromptSubmit', {prompt: 'do the thing'});
sev('SubagentStart', {agent_id: 'a1', agent_type: 'Explore'});
sev('SubagentStart', {agent_id: 'a2', agent_type: 'general-purpose'});
sev('PreToolUse', {agent_id: 'a1', tool_name: 'Grep', tool_input: {pattern: 'foo'}});
eq(sub.sessions.get('z').tool, null, 'subagent tool does not become the session tool');
eq(agentLine(sub.sessions.get('z').agents.get('a1')), 'Explore · Grep: foo', 'agent shows its tool');
sev('PostToolUse', {agent_id: 'a1', tool_name: 'Grep', tool_input: {pattern: 'foo'}});
eq(agentLine(sub.sessions.get('z').agents.get('a1')), 'Explore · working', 'agent idle between tools');
eq(sev('Stop', {last_assistant_message: 'spawned'}), null, 'no done-alert while agents run');
eq(summary(sub), {status: 'working', text: '2 agents running'}, 'finished turn but busy agents = working');
sev('SubagentStop', {agent_id: 'a1', last_assistant_message: 'found it'});
sev('SubagentStop', {agent_id: 'ghost'});
eq(sub.sessions.get('z').agents.size, 1, 'unknown agent stop ignored');
eq(statusText(sub.sessions.get('z')), '1 agent running', 'singular');
sev('SubagentStop', {agent_id: 'a2', last_assistant_message: 'also done'});
eq(summary(sub), {status: 'done', text: 'Done'}, 'back to done when agents finish');
eq(sev('Stop', {last_assistant_message: 'all finished'}), 'done', 'done-alert once agents are gone');

// chat history
sev('UserPromptSubmit', {prompt: '<task-notification>agent finished</task-notification>'});
eq(sub.sessions.get('z').history.map(m => [m.role, m.who, m.text]), [
    ['user', null, 'do the thing'], ['assistant', null, 'spawned'], ['agent', 'Explore', 'found it'],
    ['agent', 'general-purpose', 'also done'], ['assistant', null, 'all finished'],
], 'history: prompts, replies, agent reports; system prompts skipped');
for (let i = 0; i < 20; i++)
    sev('UserPromptSubmit', {prompt: `p${i}`});
eq(sub.sessions.get('z').history.length, 12, 'history is capped');
eq(sub.sessions.get('z').history.at(-1).text, 'p19', 'newest kept');

print('state ok');
