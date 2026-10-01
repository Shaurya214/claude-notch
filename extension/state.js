// Pure session state, no Shell imports, so tests run under plain `gjs -m`.

// Notification types that mean "Claude is blocked on you".
const ATTENTION = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const RANK = {waiting: 4, error: 3, working: 2, done: 1, idle: 0};

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
    return !!ev.hook_event_name?.startsWith('PostToolUse') &&
        JSON.stringify(ev.tool_input) === JSON.stringify(req.tool_input);
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
        s = {id, cwd: '', status: 'idle', tool: null, context: null, error: null, claudePid: null, pids: []};
        state.sessions.set(id, s);
    }
    s.cwd = ev.cwd ?? ev.workspace?.current_dir ?? s.cwd;
    s.claudePid = ev.claude_pid ?? s.claudePid;
    if (ev.pids?.length)
        s.pids = ev.pids;

    switch (name) {
    case 'UserPromptSubmit':
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
    case 'Stop':
        s.status = 'done';
        s.tool = null;
        return 'done';
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

export function statusText(s) {
    switch (s.status) {
    case 'working': return s.tool ?? 'Working…';
    case 'waiting': return 'Needs you';
    case 'done': return 'Done';
    case 'error': return `Error: ${s.error}`;
    default: return 'Idle';
    }
}

// What the collapsed pill shows: the most urgent session wins.
export function summary(state) {
    const all = [...state.sessions.values()];
    if (!all.length)
        return null;
    const top = all.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
    const count = all.length > 1 ? `  ·  ${all.length}` : '';
    return {status: top.status, text: statusText(top) + count};
}
