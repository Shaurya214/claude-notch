import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    newState, apply, prune, summary, statusText, preview, resolves, decision, alwaysRules,
    isQuestion, pendingLabel, answerDecision,
} from './state.js';

// The shell already promisifies DataInputStream.read_line_async (resolves to [bytes, length]).
const SOUNDS = {done: 'complete', attention: 'message-new-instant'};
const CENTER = Clutter.ActorAlign.CENTER;

export default class ClaudeNotch extends Extension {
    enable() {
        this._state = newState();
        this._pending = []; // [{ev, conn}]: PermissionRequest hooks blocked on our answer
        this._expanded = false;
        this._buildUi();
        this._startServer();
        this._pruneId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            prune(this._state, pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS));
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
        this._render();
    }

    disable() {
        GLib.source_remove(this._pruneId);
        const pending = this._pending;
        this._pending = null;
        pending.forEach(p => p.conn.close(null)); // hooks see EOF and leave it to the terminal dialog
        this._service.stop();
        this._service.close();
        this._removeSocket();
        this._pill.destroy();
        this._card.destroy();
        this._state = this._pill = this._card = this._service = null;
    }

    _buildUi() {
        this._pill = new PanelMenu.Button(0.5, 'Claude Notch', true);
        const box = new St.BoxLayout({style_class: 'claude-notch-pill', y_align: CENTER});
        this._dot = new St.Widget({style_class: 'claude-notch-dot', y_align: CENTER});
        this._label = new St.Label({style_class: 'claude-notch-pill-label', y_align: CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._dot);
        box.add_child(this._label);
        this._pill.add_child(box);
        this._pill.connect('button-press-event', () => {
            this._expanded = !this._expanded;
            this._render();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(this.uuid, this._pill, 0, 'center');

        this._card = new St.BoxLayout({style_class: 'claude-notch-card', vertical: true, visible: false});
        this._usage = new St.Label({style_class: 'claude-notch-usage'});
        this._perms = new St.BoxLayout({style_class: 'claude-notch-section', vertical: true});
        this._rows = new St.BoxLayout({style_class: 'claude-notch-section', vertical: true});
        [this._usage, this._perms, this._rows].forEach(a => this._card.add_child(a));
        this._card.set_pivot_point(0.5, 0);
        Main.layoutManager.addTopChrome(this._card);
    }

    _startServer() {
        // $XDG_RUNTIME_DIR is private (0700), so only this user can talk to the socket.
        this._path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'claude-notch.sock']);
        this._removeSocket(); // leftover from a crashed shell
        this._service = new Gio.SocketService();
        this._service.add_address(Gio.UnixSocketAddress.new(this._path),
            Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
        this._service.connect('incoming', (_svc, conn) => {
            this._handle(conn).catch(e => logError(e, 'claude-notch'));
            return true;
        });
        this._service.start();
    }

    _removeSocket() {
        try {
            Gio.File.new_for_path(this._path).delete(null);
        } catch {
            // not there: fine
        }
    }

    async _handle(conn) {
        const input = new Gio.DataInputStream({base_stream: conn.get_input_stream()});
        const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (!line || !this._state) {
            conn.close(null);
            return;
        }
        const ev = JSON.parse(new TextDecoder().decode(line));
        this._pending.filter(p => resolves(p.ev, ev)).forEach(p => this._drop(p));
        const alert = apply(this._state, ev);
        if (alert)
            this._alert(alert);

        if (ev.hook_event_name !== 'PermissionRequest') {
            conn.close(null);
            this._render();
            return;
        }
        const p = {ev, conn};
        this._pending = [...this._pending, p];
        this._expanded = true;
        this._render();
        // Returns on EOF: the hook timed out or was killed.
        await input.read_line_async(GLib.PRIORITY_DEFAULT, null).catch(() => null);
        this._drop(p);
    }

    // payload: a hook decision, or {} to leave it to the terminal dialog.
    _reply(p, payload) {
        const bytes = new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
        try {
            p.conn.get_output_stream().write_all(bytes, null);
        } catch (e) {
            logError(e, 'claude-notch: hook went away before the answer'); // terminal dialog still works
        }
        const s = this._state.sessions.get(p.ev.session_id);
        if (s && payload.behavior)
            s.status = 'working';
        this._drop(p);
    }

    _drop(p) {
        if (!this._pending?.includes(p))
            return;
        this._pending = this._pending.filter(x => x !== p);
        p.conn.close(null);
        if (!this._pending.length)
            this._expanded = false;
        this._render();
    }

    _alert(kind) {
        global.display.get_sound_player().play_from_theme(SOUNDS[kind], 'Claude Notch', null);
        this._pill.set_pivot_point(0.5, 0.5);
        this._pill.ease({
            scale_x: 1.12, scale_y: 1.12, duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD, autoReverse: true, repeatCount: 1,
        });
    }

    _focus(s) {
        const wins = global.get_window_actors().map(a => a.meta_window);
        // Nearest ancestor with a window is the terminal. ponytail: one terminal server
        // (gnome-terminal) owns all its windows, so we focus its first; match by tty if that bites.
        for (const pid of s.pids) {
            const w = wins.find(win => win.get_pid() === pid);
            if (w) {
                Main.activateWindow(w);
                break;
            }
        }
        this._expanded = false;
        this._render();
    }

    _render() {
        if (!this._state)
            return;
        const sum = summary(this._state);
        this._pill.container.visible = !!sum;
        if (sum) {
            this._dot.style_class = `claude-notch-dot claude-notch-${sum.status}`;
            this._label.text = this._pending.length ? pendingLabel(this._pending[0].ev) : sum.text;
        }

        const show = !!sum && this._expanded;
        if (show && !this._card.visible) {
            this._card.set({visible: true, opacity: 0, scale_y: 0.7});
            this._card.ease({opacity: 255, scale_y: 1, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._card.visible = show;
        if (!show)
            return;

        this._renderUsage();
        // Rebuild permission cards only when the set changes, so a click isn't lost mid-rebuild.
        if (this._permsShown !== this._pending)
            this._renderPerms();
        this._renderRows();

        const m = Main.layoutManager.primaryMonitor;
        this._card.set_position(Math.round(m.x + (m.width - this._card.width) / 2), m.y + Main.panel.height + 6);
    }

    _renderUsage() {
        const lim = this._state.limits;
        const parts = [];
        if (lim?.five_hour) {
            const at = lim.five_hour.resets_at;
            parts.push(`5h ${Math.round(lim.five_hour.used_percentage)}%` +
                (at ? ` · resets ${GLib.DateTime.new_from_unix_local(at).format('%H:%M')}` : ''));
        }
        if (lim?.seven_day)
            parts.push(`7d ${Math.round(lim.seven_day.used_percentage)}%`);
        this._usage.text = parts.join('      ');
        this._usage.visible = parts.length > 0;
    }

    _renderPerms() {
        this._permsShown = this._pending;
        this._perms.destroy_all_children();
        for (const p of this._pending)
            this._perms.add_child(isQuestion(p.ev) ? this._questionCard(p) : this._permCard(p));
        this._perms.visible = this._pending.length > 0;
    }

    _wrapped(text, styleClass) {
        const l = new St.Label({text, style_class: styleClass});
        l.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR, ellipsize: Pango.EllipsizeMode.NONE});
        return l;
    }

    _button(buttons, label, cls, onClick) {
        const b = new St.Button({label, style_class: `claude-notch-btn ${cls}`});
        b.connect('clicked', onClick);
        buttons.add_child(b);
        return b;
    }

    _permCard(p) {
        const card = new St.BoxLayout({style_class: 'claude-notch-perm', vertical: true});
        card.add_child(new St.Label({
            text: `${GLib.path_get_basename(p.ev.cwd ?? '')} wants to use ${p.ev.tool_name}`,
            style_class: 'claude-notch-project',
        }));
        card.add_child(this._wrapped(preview(p.ev.tool_name, p.ev.tool_input), 'claude-notch-preview'));
        const buttons = new St.BoxLayout({style_class: 'claude-notch-buttons', x_align: Clutter.ActorAlign.END});
        this._button(buttons, 'Deny', 'claude-notch-deny', () => this._reply(p, decision('deny', p.ev)));
        if (alwaysRules(p.ev).length)
            this._button(buttons, 'Always', '', () => this._reply(p, decision('always', p.ev)));
        this._button(buttons, 'Allow', 'claude-notch-allow', () => this._reply(p, decision('allow', p.ev)));
        card.add_child(buttons);
        return card;
    }

    // AskUserQuestion: one option click answers a lone single-select question; otherwise pick, then Submit.
    // Free-text ("Other") answers stay in the terminal.
    _questionCard(p) {
        const qs = p.ev.tool_input.questions;
        const picks = qs.map(() => new Set());
        const instant = qs.length === 1 && !qs[0].multiSelect;
        const card = new St.BoxLayout({style_class: 'claude-notch-perm', vertical: true});
        card.add_child(new St.Label({
            text: `${GLib.path_get_basename(p.ev.cwd ?? '')} asks`,
            style_class: 'claude-notch-project',
        }));
        const buttons = new St.BoxLayout({style_class: 'claude-notch-buttons', x_align: Clutter.ActorAlign.END});
        let submit = null;
        const sync = () => {
            const ready = picks.every(s => s.size > 0);
            submit.reactive = ready;
            submit.opacity = ready ? 255 : 90;
        };

        qs.forEach((q, i) => {
            card.add_child(this._wrapped(q.multiSelect ? `${q.question} (pick any)` : q.question, 'claude-notch-question'));
            const opts = q.options.map(o => {
                const box = new St.BoxLayout({vertical: true, x_expand: true, x_align: Clutter.ActorAlign.FILL});
                box.add_child(new St.Label({text: o.label, style_class: 'claude-notch-opt-label', x_align: Clutter.ActorAlign.START}));
                if (o.description) {
                    const d = this._wrapped(o.description, 'claude-notch-muted');
                    d.x_align = Clutter.ActorAlign.START;
                    box.add_child(d);
                }
                const b = new St.Button({child: box, style_class: 'claude-notch-opt', x_expand: true});
                b.connect('clicked', () => {
                    if (q.multiSelect && picks[i].has(o.label))
                        picks[i].delete(o.label);
                    else if (q.multiSelect)
                        picks[i].add(o.label);
                    else
                        picks[i] = new Set([o.label]);
                    opts.forEach(([btn, label]) => (btn.checked = picks[i].has(label)));
                    if (instant)
                        this._reply(p, answerDecision(p.ev, picks));
                    else
                        sync();
                });
                card.add_child(b);
                return [b, o.label];
            });
        });

        this._button(buttons, 'Answer in terminal', '', () => this._reply(p, {}));
        if (!instant) {
            submit = this._button(buttons, 'Submit', 'claude-notch-allow', () => this._reply(p, answerDecision(p.ev, picks)));
            sync();
        }
        card.add_child(buttons);
        return card;
    }

    _renderRows() {
        this._rows.destroy_all_children();
        for (const s of this._state.sessions.values()) {
            const box = new St.BoxLayout({style_class: 'claude-notch-row-box', x_expand: true});
            box.add_child(new St.Widget({style_class: `claude-notch-dot claude-notch-${s.status}`, y_align: CENTER}));
            box.add_child(new St.Label({text: GLib.path_get_basename(s.cwd || '?'), style_class: 'claude-notch-project'}));
            const status = new St.Label({text: statusText(s), style_class: 'claude-notch-muted', x_expand: true});
            status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(status);
            if (s.context !== null)
                box.add_child(new St.Label({text: `${Math.round(s.context)}% ctx`, style_class: 'claude-notch-muted'}));
            const row = new St.Button({child: box, style_class: 'claude-notch-row', x_expand: true});
            row.connect('clicked', () => this._focus(s));
            this._rows.add_child(row);
        }
    }
}
