// Pure session state, no Shell imports, so tests run under plain `gjs -m`.

// Notification types that mean "Claude is blocked on you".
const ATTENTION = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const RANK = {waiting: 4, error: 3, working: 2, done: 1, idle: 0};
const MAX_HISTORY = 12;
const MAX_TEXT = 4000;

export function newState() {
    return {sessions: new Map(), limits: null};
}

export function toolText(name, input = {}) {
    const arg = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? '';
    return arg ? `${name}: ${arg}` : name;
}

// Command/path plus the first lines of what an Edit/Write will put in the file.
export function preview(name, input = {}) {
    const body = (input.new_string ?? input.content ?? '').split('\n').slice(0, 6).join('\n');
    return [toolText(name, input), body].filter(Boolean).join('\n').slice(0, 600);
}

// A request answered in the terminal leaves our hook waiting: later events tell us it's settled.
const SETTLES = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'SessionEnd']);
export function resolves(req, ev) {
    if (ev.session_id !== req.session_id)
        return false;
    if (SETTLES.has(ev.hook_event_name))
        return true;
    // Subset match: answering a question in the terminal adds `answers`/`annotations` to tool_input.
    return !!ev.hook_event_name?.startsWith('PostToolUse') && ev.tool_name === req.tool_name &&
        Object.entries(req.tool_input ?? {}).every(([k, v]) => JSON.stringify(ev.tool_input?.[k]) === JSON.stringify(v));
}

export const isQuestion = req => req.tool_name === 'AskUserQuestion' && Array.isArray(req.tool_input?.questions);

export const pendingLabel = req => (isQuestion(req) ? req.tool_input.questions[0].question : `Allow ${req.tool_name}?`);

// A question counts as answered by a picked option or by typed text.
export const answered = (picked, other) => picked.size > 0 || !!other?.trim();

// Claude Code takes the answer as {question text: "label" | "a, b" | typed text} merged into the tool input.
// picks[i] is the Set of labels chosen for question i, others[i] the text typed into its "Other" box.
// Typed text replaces the pick on a single-select question and is appended on a multi-select one.
export function answerDecision(req, picks, others = []) {
    const answers = {};
    req.tool_input.questions.forEach((q, i) => {
        const labels = q.options.map(o => o.label).filter(l => picks[i].has(l));
        const other = others[i]?.trim();
        answers[q.question] = (other ? (q.multiSelect ? [...labels, other] : [other]) : labels).join(', ');
    });
    return {behavior: 'allow', updatedInput: {...req.tool_input, answers}};
}

// "Always" applies Claude's own suggestions (the terminal's "don't ask again"), minus mode switches.
export function alwaysRules(req) {
    return (req.permission_suggestions ?? []).filter(s => s.type !== 'setMode');
}

export function decision(kind, req) {
    if (kind === 'deny')
        return {behavior: 'deny', message: 'Denied from Claude Notch'};
    return kind === 'always' ? {behavior: 'allow', updatedPermissions: alwaysRules(req)} : {behavior: 'allow'};
}

function remember(s, role, text, who = null) {
    if (!text?.trim())
        return;
    s.history.push({role, who, text: text.trim().slice(0, MAX_TEXT)});
    if (s.history.length > MAX_HISTORY)
        s.history.shift();
}

// Applies one hook/statusline event. Returns 'done' | 'attention' | null for alerting.
export function apply(state, ev) {
    const id = ev.session_id;
    const name = ev.hook_event_name;
    if (!id)
        return null;
    if (name === 'SessionEnd') {
        state.sessions.delete(id);
        return null;
    }
    let s = state.sessions.get(id);
    if (!s) {
        s = {
            id, cwd: '', status: 'idle', tool: null, context: null, error: null, claudePid: null, pids: [],
            agents: new Map(), history: [],
        };
        state.sessions.set(id, s);
    }
    s.cwd = ev.cwd ?? ev.workspace?.current_dir ?? s.cwd;
    s.claudePid = ev.claude_pid ?? s.claudePid;
    if (ev.pids?.length)
        s.pids = ev.pids;

    // A subagent's own tool calls must not overwrite the session's status/tool.
    if (ev.agent_id && (name === 'PreToolUse' || name.startsWith('PostToolUse'))) {
        const a = s.agents.get(ev.agent_id);
        if (a)
            a.tool = name === 'PreToolUse' ? toolText(ev.tool_name, ev.tool_input) : null;
        return null;
    }

    switch (name) {
    case 'UserPromptSubmit':
        s.status = 'working';
        s.tool = null;
        if (!/^\s*</.test(ev.prompt ?? '')) // "<task-notification>…" and friends are Claude Code talking, not you
            remember(s, 'user', ev.prompt);
        break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
        s.status = 'working';
        s.tool = null;
        break;
    case 'PreToolUse':
        s.status = 'working';
        s.tool = toolText(ev.tool_name, ev.tool_input);
        break;
    case 'PermissionRequest':
        s.status = 'waiting';
        s.tool = toolText(ev.tool_name, ev.tool_input);
        return 'attention';
    case 'Notification':
        // permission_prompt also follows every PermissionRequest: don't alert twice.
        if (!ATTENTION.has(ev.notification_type) || s.status === 'waiting')
            return null;
        s.status = 'waiting';
        return 'attention';
    case 'SubagentStart':
        // ponytail: an agent only leaves on SubagentStop/SessionEnd/dead claude; an interrupted agent may linger.
        if (ev.agent_id)
            s.agents.set(ev.agent_id, {id: ev.agent_id, type: ev.agent_type || 'agent', tool: null});
        break;
    case 'SubagentStop': {
        const a = s.agents.get(ev.agent_id);
        if (a) {
            s.agents.delete(ev.agent_id);
            remember(s, 'agent', ev.last_assistant_message, a.type);
        }
        break;
    }
    case 'Stop':
        s.status = 'done';
        s.tool = null;
        remember(s, 'assistant', ev.last_assistant_message);
        // A background subagent can outlive the turn: the real "done" comes with the next Stop.
        return s.agents.size ? null : 'done';
    case 'StopFailure':
        s.status = 'error';
        s.error = ev.error_type ?? 'unknown';
        return 'attention';
    case 'StatusLine':
        s.context = ev.context_window?.used_percentage ?? s.context;
        if (ev.rate_limits)
            state.limits = ev.rate_limits;
        break;
    }
    return null;
}

// Drops sessions whose claude process is gone (crashed, killed: no SessionEnd).
export function prune(state, alive) {
    for (const [id, s] of state.sessions) {
        if (s.claudePid && !alive(s.claudePid))
            state.sessions.delete(id);
    }
}

// Running subagents keep a finished-looking session busy.
export function effectiveStatus(s) {
    return s.agents.size && (s.status === 'done' || s.status === 'idle') ? 'working' : s.status;
}

export function statusText(s) {
    const n = s.agents.size;
    switch (effectiveStatus(s)) {
    case 'working': return s.tool ?? (n ? `${n} agent${n > 1 ? 's' : ''} running` : 'Working…');
    case 'waiting': return 'Needs you';
    case 'done': return 'Done';
    case 'error': return `Error: ${s.error}`;
    default: return 'Idle';
    }
}

export const agentLine = a => `${a.type} · ${a.tool ?? 'working'}`;

// What the collapsed pill shows: the most urgent session wins.
export function summary(state) {
    const all = [...state.sessions.values()];
    if (!all.length)
        return null;
    const top = all.reduce((a, b) => (RANK[effectiveStatus(b)] > RANK[effectiveStatus(a)] ? b : a));
    const count = all.length > 1 ? `  ·  ${all.length}` : '';
    return {status: effectiveStatus(top), text: statusText(top) + count};
}
