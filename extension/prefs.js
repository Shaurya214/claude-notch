import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const COLORS = [['working', 'Working'], ['waiting', 'Needs you'], ['done', 'Done'], ['error', 'Error'], ['idle', 'Idle']];
const hex = c => `#${[c.red, c.green, c.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

export default class ClaudeNotchPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Claude Notch', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const group = (title, description = '') => {
            const g = new Adw.PreferencesGroup({title, description});
            page.add(g);
            return g;
        };
        const toggle = (g, key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            g.add(row);
        };

        const alerts = group('Alerts', 'When Claude finishes or needs you.');
        toggle(alerts, 'sound', 'Sound', 'Play a short sound.');
        toggle(alerts, 'pulse', 'Pulse', 'Briefly enlarge the pill.');

        const card = group('Card');
        toggle(card, 'auto-expand', 'Open automatically', 'Drop the card down for permission requests and questions. When off, click the pill.');
        toggle(card, 'show-usage', 'Show usage limits', 'The 5-hour and 7-day line at the top of the card.');

        const colors = group('Status colors');
        const buttons = [];
        for (const [name, title] of COLORS) {
            const key = `color-${name}`;
            const row = new Adw.ActionRow({title});
            const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), valign: Gtk.Align.CENTER});
            const load = () => {
                const rgba = new Gdk.RGBA();
                rgba.parse(settings.get_string(key));
                button.rgba = rgba;
            };
            load();
            button.connect('notify::rgba', () => {
                if (hex(button.rgba) !== settings.get_string(key))
                    settings.set_string(key, hex(button.rgba));
            });
            row.add_suffix(button);
            colors.add(row);
            buttons.push([key, load]);
        }

        const reset = new Adw.ActionRow({title: 'Reset colors'});
        const resetButton = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        resetButton.connect('clicked', () => buttons.forEach(([key, load]) => {
            settings.reset(key);
            load();
        }));
        reset.add_suffix(resetButton);
        colors.add(reset);
    }
}
