// The extension's own preferences window (gear in the Extensions app). All the settings live in the ALLES window (the "Top bar" page),
// so there is one place to change them; this page just says so and opens it.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AllesPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const page = new Adw.PreferencesPage({ title: 'ALLES', icon_name: 'preferences-system-symbolic' });
    const group = new Adw.PreferencesGroup({
      title: 'Top bar settings',
      description: 'Colours, widgets, position, the shelf and voice are all set in the ALLES window, on the “Top bar” page. They change here at once.',
    });
    const row = new Adw.ActionRow({ title: 'Open the ALLES settings', subtitle: 'Needs the ALLES app (it is started if it is not running)' });
    const button = new Gtk.Button({ label: 'Open', valign: Gtk.Align.CENTER });
    button.connect('clicked', () => {
      try { Gio.Subprocess.new(['alles', '--window', 'topbar'], Gio.SubprocessFlags.NONE); } catch (e) { console.error(`ALLES: ${e.message}`); }
    });
    row.add_suffix(button); row.activatable_widget = button;
    group.add(row); page.add(group); window.add(page);
  }
}
