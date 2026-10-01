import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {newState, apply, prune, summary, statusText, effectiveStatus, resolves, isQuestion, pendingLabel} from './state.js';
import {dot, paintDot, permCard, questionCard, agentRows, chatPanel} from './ui.js';

// The shell already promisifies DataInputStream.read_line_async (resolves to [bytes, length]).
const SOUNDS = {done: 'complete', attention: 'message-new-instant'};
const CENTER = Clutter.ActorAlign.CENTER;
const STATUSES = ['working', 'waiting', 'done', 'error', 'idle'];

export default class ClaudeNotch extends Extension {
    enable() {
        this._state = newState();
        this._pending = []; // [{ev, conn, card}]: PermissionRequest hooks blocked on our answer
        this._expanded = false;
        this._chatFor = null; // session id whose chat panel is open
        this._chat = null; // {key, actor}: built panel, reused until the history changes
        this._settings = this.getSettings();
        this._settingsId = this._settings.connect('changed', () => this._render());
        this._buildUi();
        // Owner must contain the entry: key focus outside the grab owner gets no keys.
        this._grab = new GrabHelper.GrabHelper(this._card, {actionMode: Shell.ActionMode.POPUP});
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
        if (this._grab.grabbed)
            this._grab.ungrab({actor: this._card});
        const pending = this._pending;
        this._pending = null;
        pending.forEach(p => p.conn.close(null)); // hooks see EOF and leave it to the terminal dialog
        this._service.stop();
        this._service.close();
        this._removeSocket();
        this._settings.disconnect(this._settingsId);
        this._pill.destroy();
        this._card.destroy();
        this._state = this._pill = this._card = this._service = this._settings = this._grab = this._chat = null;
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
        this._usage = new St.Label({style_class: 'claude-notch-usage', y_align: CENTER});
        // The gear is always there, so the header stays even when the usage line is hidden.
        const header = new St.BoxLayout({style_class: 'claude-notch-header'});
        const gear = new St.Button({
            style_class: 'claude-notch-chip', accessible_name: 'Settings', x_expand: true, x_align: Clutter.ActorAlign.END,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', style_class: 'claude-notch-gear'}),
        });
        gear.connect('clicked', () => {
            this._expanded = false;
            this._render();
            this.openPreferences();
        });
        header.add_child(this._usage);
        header.add_child(gear);
        this._perms = new St.BoxLayout({style_class: 'claude-notch-section', vertical: true});
        this._rows = new St.BoxLayout({style_class: 'claude-notch-section', vertical: true});
        [header, this._perms, this._rows].forEach(a => this._card.add_child(a));
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
        const p = {ev, conn, card: null};
        this._pending = [...this._pending, p];
        if (this._settings.get_boolean('auto-expand'))
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
        if (s && payload.behavior) {
            s.status = 'working';
            s.tool = null; // else the row keeps showing the answered request until the next event
        }
        this._drop(p);
    }

    _drop(p) {
        if (!this._pending?.includes(p))
            return;
        this._pending = this._pending.filter(x => x !== p);
        p.conn.close(null);
        p.card?.destroy();
        if (!this._pending.length)
            this._expanded = false;
        this._render();
    }

    // The card is a chrome actor, so it only gets the keyboard while we hold a grab (like a popup menu).
    _focusEntry(entry) {
        if (!this._grab.grabbed)
            this._grab.grab({actor: this._card, focus: entry});
        else
            entry.grab_key_focus();
    }

    _releaseFocus() {
        if (this._grab.grabbed)
            this._grab.ungrab({actor: this._card});
    }

    _alert(kind) {
        if (this._settings.get_boolean('sound'))
            global.display.get_sound_player().play_from_theme(SOUNDS[kind], 'Claude Notch', null);
        if (!this._settings.get_boolean('pulse'))
            return;
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

    _colors() {
        return Object.fromEntries(STATUSES.map(k => [k, this._settings.get_string(`color-${k}`)]));
    }

    _render() {
        if (!this._state)
            return;
        const colors = this._colors();
        const sum = summary(this._state);
        this._pill.container.visible = !!sum;
        if (sum) {
            paintDot(this._dot, sum.status, colors);
            this._label.text = this._pending.length ? pendingLabel(this._pending[0].ev) : sum.text;
        }

        const show = !!sum && this._expanded;
        if (show && !this._card.visible) {
            this._card.set({visible: true, opacity: 0, scale_y: 0.7});
            this._card.ease({opacity: 255, scale_y: 1, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._card.visible = show;
        if (!show) {
            if (this._grab.grabbed)
                this._grab.ungrab({actor: this._card});
            return;
        }

        this._renderUsage();
        // Permission cards are built once per request and kept, so typed text and picks survive other events.
        if (this._permsShown !== this._pending)
            this._renderPerms();
        this._renderRows(colors);

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
        this._usage.visible = parts.length > 0 && this._settings.get_boolean('show-usage');
    }

    _renderPerms() {
        this._permsShown = this._pending;
        this._perms.get_children().forEach(c => this._perms.remove_child(c)); // unparent only: cards live on in p.card
        for (const p of this._pending) {
            p.card ??= isQuestion(p.ev)
                ? questionCard(p, payload => this._reply(p, payload), entry => this._focusEntry(entry), () => this._releaseFocus())
                : permCard(p, payload => this._reply(p, payload));
            this._perms.add_child(p.card);
        }
        this._perms.visible = this._pending.length > 0;
    }

    _chatPanel(s) {
        const key = `${s.id}:${s.history.length}`;
        if (this._chat?.key !== key) {
            this._chat?.actor.destroy();
            this._chat = {key, actor: chatPanel(s)};
        }
        return this._chat.actor;
    }

    _renderRows(colors) {
        // The cached chat panel must survive the rebuild (and keep its scroll position).
        for (const c of this._rows.get_children()) {
            if (c === this._chat?.actor)
                this._rows.remove_child(c);
            else
                c.destroy();
        }
        if (!this._state.sessions.has(this._chatFor)) {
            this._chatFor = null;
            this._chat?.actor.destroy();
            this._chat = null;
        }

        for (const s of this._state.sessions.values()) {
            const line = new St.BoxLayout({style_class: 'claude-notch-row-line', x_expand: true});
            const box = new St.BoxLayout({style_class: 'claude-notch-row-box', x_expand: true});
            box.add_child(dot(effectiveStatus(s), colors));
            box.add_child(new St.Label({text: GLib.path_get_basename(s.cwd || '?'), style_class: 'claude-notch-project'}));
            const status = new St.Label({text: statusText(s), style_class: 'claude-notch-muted', x_expand: true});
            status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(status);
            if (s.context !== null)
                box.add_child(new St.Label({text: `${Math.round(s.context)}% ctx`, style_class: 'claude-notch-muted'}));
            const row = new St.Button({child: box, style_class: 'claude-notch-row', x_expand: true});
            row.connect('clicked', () => this._focus(s));
            line.add_child(row);

            const chat = new St.Button({label: 'Chat', style_class: 'claude-notch-chip', y_align: CENTER});
            chat.checked = this._chatFor === s.id;
            chat.connect('clicked', () => {
                this._chatFor = this._chatFor === s.id ? null : s.id;
                if (!this._chatFor) {
                    this._chat?.actor.destroy();
                    this._chat = null;
                }
                this._render();
            });
            line.add_child(chat);
            this._rows.add_child(line);

            const agents = agentRows(s);
            if (agents)
                this._rows.add_child(agents);
            if (this._chatFor === s.id)
                this._rows.add_child(this._chatPanel(s));
        }
    }
}
