// Widgets for the card. No state of their own: callers pass the data and what to do on a click.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {preview, alwaysRules, decision, answerDecision, answered, agentLine} from './state.js';

const CENTER = Clutter.ActorAlign.CENTER;
const START = Clutter.ActorAlign.START;

export function wrapped(text, styleClass) {
    const l = new St.Label({text, style_class: styleClass});
    l.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR, ellipsize: Pango.EllipsizeMode.NONE});
    return l;
}

export function paintDot(widget, status, colors) {
    widget.style = `background-color: ${colors[status] ?? colors.idle};`;
}

export function dot(status, colors) {
    const w = new St.Widget({style_class: 'claude-notch-dot', y_align: CENTER});
    paintDot(w, status, colors);
    return w;
}

function button(box, label, cls, onClick) {
    const b = new St.Button({label, style_class: `claude-notch-btn ${cls}`});
    b.connect('clicked', onClick);
    box.add_child(b);
    return b;
}

const buttonRow = () => new St.BoxLayout({style_class: 'claude-notch-buttons', x_align: Clutter.ActorAlign.END});
const project = p => GLib.path_get_basename(p.ev.cwd ?? '');

export function permCard(p, reply) {
    const card = new St.BoxLayout({style_class: 'claude-notch-perm', vertical: true});
    card.add_child(new St.Label({text: `${project(p)} wants to use ${p.ev.tool_name}`, style_class: 'claude-notch-project'}));
    card.add_child(wrapped(preview(p.ev.tool_name, p.ev.tool_input), 'claude-notch-preview'));
    const buttons = buttonRow();
    button(buttons, 'Deny', 'claude-notch-deny', () => reply(decision('deny', p.ev)));
    if (alwaysRules(p.ev).length)
        button(buttons, 'Always', '', () => reply(decision('always', p.ev)));
    button(buttons, 'Allow', 'claude-notch-allow', () => reply(decision('allow', p.ev)));
    card.add_child(buttons);
    return card;
}

// AskUserQuestion: clicking the option of a lone single-select question answers it; otherwise pick
// (and/or type under "Other") and press Submit. focusEntry(entry) must give the entry the keyboard,
// releaseFocus() takes it back (Escape).
export function questionCard(p, reply, focusEntry, releaseFocus) {
    const qs = p.ev.tool_input.questions;
    const picks = qs.map(() => new Set());
    const others = qs.map(() => '');
    const entries = [];
    const instant = qs.length === 1 && !qs[0].multiSelect;
    const ready = () => qs.every((_q, i) => answered(picks[i], others[i]));
    const submit = () => reply(answerDecision(p.ev, picks, others));

    const card = new St.BoxLayout({style_class: 'claude-notch-perm', vertical: true});
    card.add_child(new St.Label({text: `${project(p)} asks`, style_class: 'claude-notch-project'}));
    const buttons = buttonRow();
    let submitBtn = null;
    const sync = () => {
        submitBtn.reactive = ready();
        submitBtn.opacity = ready() ? 255 : 90;
    };

    qs.forEach((q, i) => {
        card.add_child(wrapped(q.multiSelect ? `${q.question} (pick any)` : q.question, 'claude-notch-question'));
        const opts = q.options.map(o => {
            const box = new St.BoxLayout({vertical: true, x_expand: true, x_align: Clutter.ActorAlign.FILL});
            box.add_child(new St.Label({text: o.label, style_class: 'claude-notch-opt-label', x_align: START}));
            if (o.description) {
                const d = wrapped(o.description, 'claude-notch-muted');
                d.x_align = START;
                box.add_child(d);
            }
            const b = new St.Button({child: box, style_class: 'claude-notch-opt', x_expand: true});
            b.connect('clicked', () => {
                if (q.multiSelect && picks[i].has(o.label)) {
                    picks[i].delete(o.label);
                } else if (q.multiSelect) {
                    picks[i].add(o.label);
                } else {
                    picks[i] = new Set([o.label]);
                    entries[i].set_text(''); // an option and typed text are alternatives on a single-select
                }
                opts.forEach(([btn, label]) => (btn.checked = picks[i].has(label)));
                if (instant)
                    submit();
                else
                    sync();
            });
            card.add_child(b);
            return [b, o.label];
        });

        const entry = new St.Entry({style_class: 'claude-notch-entry', hint_text: 'Other: type your own answer', can_focus: true, x_expand: true});
        entry.clutter_text.connect('text-changed', () => {
            others[i] = entry.get_text();
            if (others[i] && !q.multiSelect) {
                picks[i].clear();
                opts.forEach(([btn]) => (btn.checked = false));
            }
            sync();
        });
        entry.clutter_text.connect('activate', () => ready() && submit());
        entry.clutter_text.connect('key-press-event', (_t, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            releaseFocus();
            return Clutter.EVENT_STOP;
        });
        // Capture phase: the text actor swallows the click before it bubbles up to the entry. Do not hook
        // key-focus-in instead: GrabHelper restores the old focus on release, and re-grabbing there traps the keyboard.
        entry.connect('captured-event', (_a, event) => {
            if ([Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN].includes(event.type()))
                focusEntry(entry);
            return Clutter.EVENT_PROPAGATE;
        });
        entries.push(entry);
        card.add_child(entry);
    });

    button(buttons, 'Answer in terminal', '', () => reply({}));
    submitBtn = button(buttons, 'Submit', 'claude-notch-allow', submit);
    sync();
    card.add_child(buttons);
    return card;
}

// One muted line per running subagent, indented under its session.
export function agentRows(s) {
    if (!s.agents.size)
        return null;
    const box = new St.BoxLayout({style_class: 'claude-notch-agents', vertical: true});
    for (const a of s.agents.values()) {
        const l = new St.Label({text: `↳ ${agentLine(a)}`, style_class: 'claude-notch-muted'});
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(l);
    }
    return box;
}

// Recent prompts and replies of one session, newest at the bottom.
export function chatPanel(s) {
    const box = new St.BoxLayout({style_class: 'claude-notch-chat', vertical: true});
    for (const m of s.history) {
        box.add_child(new St.Label({
            text: m.role === 'user' ? 'You' : m.role === 'agent' ? m.who : 'Claude',
            style_class: `claude-notch-who claude-notch-who-${m.role}`,
            x_align: START,
        }));
        box.add_child(wrapped(m.text, 'claude-notch-msg'));
    }
    if (!s.history.length)
        box.add_child(wrapped('Nothing yet. Prompts and replies show up here once Claude finishes a turn.', 'claude-notch-muted'));

    const scroll = new St.ScrollView({
        style_class: 'claude-notch-chat-scroll', overlay_scrollbars: true,
        hscrollbar_policy: St.PolicyType.NEVER, x_expand: true,
    });
    scroll.add_child(box);
    let alive = true;
    scroll.connect('destroy', () => (alive = false));
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        if (alive)
            scroll.vadjustment.value = scroll.vadjustment.upper - scroll.vadjustment.page_size;
        return GLib.SOURCE_REMOVE;
    });
    return scroll;
}
