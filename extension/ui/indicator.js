// The pill in the top bar and the popup that opens from it. This file only builds and updates GNOME Shell widgets; WHAT they say comes
// from the tested libraries (lib/state.js, lib/widgets.js, lib/shelf.js).
//
// Everything the person can switch off is switched off by leaving its widget out, so nothing optional costs anything when unused.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { describeState } from '../lib/state.js';
import { barItems, menuRows } from '../lib/widgets.js';
import { summarise, snippetTitle, humanAge } from '../lib/shelf.js';

const TRACK_W = 150;

function safe(fn) {
  return (...args) => { try { return fn(...args); } catch (e) { console.error(`ALLES: ${e.message}\n${e.stack || ''}`); return undefined; } };
}

function button(label, onClick, styleClass = '') {
  const b = new St.Button({ label, style_class: `button alles-button ${styleClass}`.trim(), can_focus: true, reactive: true, x_expand: false });
  b.connect('clicked', safe(onClick));
  return b;
}

function wrappedLabel(text, styleClass = '') {
  const l = new St.Label({ text, style_class: styleClass, x_expand: true });
  l.clutter_text.line_wrap = true;
  l.clutter_text.ellipsize = 0;                  // Pango.EllipsizeMode.NONE
  return l;
}

function section(menu, title) {
  const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
  const box = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'alles-section' });
  if (title) box.add_child(new St.Label({ text: title, style_class: 'alles-section-title' }));
  item.add_child(box);
  menu.addMenuItem(item);
  return { item, box };
}

export const AllesIndicator = GObject.registerClass(
class AllesIndicator extends PanelMenu.Button {
  /**
   * @param {object} host  { config, link, shelf, launchApp(), refreshShelf() }
   */
  _init(host) {
    super._init(0.0, 'ALLES', false);
    this._host = host;
    this._state = null; this._samples = {}; this._rows = new Map(); this._commandResults = {};
    this._wakeUpdating = false;
    this._sources = new Set();                  // every timer this button starts, so none can outlive it
    this.connect('destroy', () => { for (const id of this._sources) GLib.Source.remove(id); this._sources.clear(); });

    // ---- the pill in the bar
    this._bar = new St.BoxLayout({ style_class: 'alles-bar', y_align: Clutter.ActorAlign.CENTER });
    this._orb = new St.Widget({ style_class: 'alles-orb', y_align: Clutter.ActorAlign.CENTER });
    this._armed = new St.Widget({ style_class: 'alles-armed', y_align: Clutter.ActorAlign.CENTER, visible: false });
    this._label = new St.Label({ style_class: 'alles-label', y_align: Clutter.ActorAlign.CENTER });
    this._widgets = new St.BoxLayout({ style_class: 'alles-widgets', y_align: Clutter.ActorAlign.CENTER });
    this._bar.add_child(this._orb); this._bar.add_child(this._armed); this._bar.add_child(this._label); this._bar.add_child(this._widgets);
    this.add_child(this._bar);

    this._buildMenu();
    this.menu.connect('open-state-changed', safe((_m, open) => {
      if (!open) return;
      this._host.refreshShelf();
      this._later(GLib.idle_add, [GLib.PRIORITY_DEFAULT_IDLE], () => { if (this._entry) this._entry.grab_key_focus(); });
    }));
    this.setConfig(host.config);
    this.setState(null);
  }

  // ------------------------------------------------------------------ the popup

  _buildMenu() {
    const menu = this.menu;
    menu.box.add_style_class_name('alles-menu');

    // status + stop
    const head = section(menu, '');
    this._status = new St.Label({ text: 'ALLES', style_class: 'alles-status', x_expand: true });
    this._reply = wrappedLabel('', 'alles-reply');
    this._stopBtn = button('Stop', () => this._host.link.stop(), 'alles-danger');
    this._startBtn = button('Start ALLES', () => { this._host.launchApp(); }, 'alles-primary');
    const headRow = new St.BoxLayout({ x_expand: true });
    headRow.add_child(this._status); headRow.add_child(this._stopBtn); headRow.add_child(this._startBtn);
    head.box.add_child(headRow); head.box.add_child(this._reply);

    // a question from ALLES
    const ap = section(menu, '');
    this._approvalSection = ap;
    this._apTitle = wrappedLabel('', 'alles-ap-title');
    this._apTarget = wrappedLabel('', 'alles-ap-target');
    this._apBody = wrappedLabel('', 'alles-ap-body');
    this._apRisks = wrappedLabel('', 'alles-ap-risks');
    const apButtons = new St.BoxLayout({ x_align: Clutter.ActorAlign.END, style_class: 'alles-row' });
    this._apDeny = button('Don’t', () => this._answer(false));
    this._apAllow = button('Allow', () => this._answer(true), 'alles-primary');
    apButtons.add_child(this._apDeny); apButtons.add_child(this._apAllow);
    for (const w of [this._apTitle, this._apTarget, this._apBody, this._apRisks, apButtons]) ap.box.add_child(w);
    ap.item.visible = false;

    // ask
    const ask = section(menu, '');
    this._askSection = ask;
    const askRow = new St.BoxLayout({ x_expand: true, style_class: 'alles-row' });
    this._entry = new St.Entry({ hint_text: 'Ask ALLES to do something…', can_focus: true, x_expand: true, style_class: 'alles-entry' });
    this._entry.clutter_text.connect('activate', safe(() => this._submit()));
    this._micBtn = button('🎤', () => this._mic(), 'alles-mic');
    this._sendBtn = button('Send', () => this._submit(), 'alles-primary');
    askRow.add_child(this._entry); askRow.add_child(this._micBtn); askRow.add_child(this._sendBtn);
    ask.box.add_child(askRow);

    // wake word
    this._wakeItem = new PopupMenu.PopupSwitchMenuItem('Wake word', false);
    this._wakeItem.connect('toggled', safe((_i, on) => { if (!this._wakeUpdating) this._host.link.setWake(on); }));
    menu.addMenuItem(this._wakeItem);

    // resources
    this._resSection = section(menu, 'System');
    // shelf
    this._shelfSection = section(menu, 'Shelf');
    const shelfActions = new St.BoxLayout({ style_class: 'alles-row' });
    shelfActions.add_child(button('Paste', () => this._shelfPaste()));
    shelfActions.add_child(button('Open folder', () => this._shelfOpenFolder()));
    shelfActions.add_child(button('Empty', () => this._shelfEmpty(), 'alles-danger'));
    this._shelfSummary = new St.Label({ text: '', style_class: 'alles-note', x_expand: true });
    const shelfHead = new St.BoxLayout({ x_expand: true });
    shelfHead.add_child(this._shelfSummary); shelfHead.add_child(shelfActions);
    this._shelfSection.box.add_child(shelfHead);
    this._shelfList = new St.BoxLayout({ vertical: true, x_expand: true });
    this._shelfSection.box.add_child(this._shelfList);
    this._shelfNote = wrappedLabel('', 'alles-note');
    this._shelfSection.box.add_child(this._shelfNote);

    // footer
    const foot = section(menu, '');
    const footRow = new St.BoxLayout({ style_class: 'alles-row', x_expand: true });
    footRow.add_child(button('Workspace', () => { this.menu.close(); this._host.link.running ? this._host.link.openWorkspace('') : this._host.launchApp(''); }));
    footRow.add_child(button('Customize', () => { this.menu.close(); this._host.link.running ? this._host.link.openWorkspace('topbar') : this._host.launchApp('topbar'); }));
    footRow.add_child(button('Settings', () => { this.menu.close(); this._host.link.running ? this._host.link.openSettings() : this._host.launchApp(''); }));
    foot.box.add_child(footRow);
  }

  /** Run `fn` once later. The timer is remembered and removed if the button is destroyed first. */
  _later(adder, leading, fn) {
    let id = 0;
    id = adder(...leading, () => { this._sources.delete(id); try { fn(); } catch (e) { console.error(`ALLES: ${e.message}`); } return GLib.SOURCE_REMOVE; });
    this._sources.add(id);
  }

  // ------------------------------------------------------------------ actions

  _submit() {
    const text = this._entry.get_text().trim();
    if (!text) return;
    if (!this._host.link.running) { this._host.launchApp(); Main.notify('ALLES', 'Starting ALLES… ask again in a moment.'); return; }
    this._host.link.submit(text, (error) => {
      if (error) Main.notify('ALLES', `Could not send that: ${error.message}`);
      else { this._entry.set_text(''); this.menu.close(); }
    });
  }

  _mic() {
    if (!this._host.link.running) { this._host.launchApp(); return; }
    const listening = this._state && this._state.voice && this._state.voice.state === 'listening';
    if (listening) { this._host.link.stopListening(); return; }
    this._host.link.listen(true, (heard, error) => { if (error) Main.notify('ALLES', error.message.replace(/^.*?: /, '')); else if (heard) this._entry.set_text(''); });
  }

  _answer(allow) {
    const ap = this._state && this._state.approval;
    if (ap) this._host.link.answerApproval(ap.id, allow);
  }

  _shelfPaste() {
    const shelf = this._host.shelf; if (!shelf) return;
    const clip = St.Clipboard.get_default();
    const types = clip.get_mimetypes(St.ClipboardType.CLIPBOARD) || [];
    const fileType = ['x-special/gnome-copied-files', 'text/uri-list'].find((t) => types.includes(t));
    if (fileType) {
      clip.get_content(St.ClipboardType.CLIPBOARD, fileType, safe((_c, bytes) => {
        const lines = new TextDecoder().decode(bytes.get_data()).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('file://'));
        const paths = lines.map((u) => Gio.File.new_for_uri(u).get_path()).filter(Boolean);
        const n = shelf.addPaths(paths);
        Main.notify('ALLES', n ? `Added ${n} item${n > 1 ? 's' : ''} to the shelf.` : 'Nothing could be added.');
        this._host.refreshShelf();
      }));
      return;
    }
    clip.get_text(St.ClipboardType.CLIPBOARD, safe((_c, text) => {
      const name = shelf.addText(text);
      Main.notify('ALLES', name ? 'Text saved to the shelf.' : 'The clipboard has no text to save.');
      this._host.refreshShelf();
    }));
  }

  _shelfOpenFolder() {
    const shelf = this._host.shelf; if (!shelf) return;
    shelf.ensure();
    this.menu.close();
    try { Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(shelf.path).get_uri(), null); } catch (e) { Main.notify('ALLES', `Could not open the folder: ${e.message}`); }
  }

  _shelfEmpty() {
    const shelf = this._host.shelf; if (!shelf) return;
    // Two clicks: the first arms the button, the second does it; anything else disarms it.
    if (!this._emptyArmed) {
      this._emptyArmed = true;
      Main.notify('ALLES', 'Press “Empty” again within 5 seconds to move everything on the shelf to the Trash.');
      this._later(GLib.timeout_add_seconds, [GLib.PRIORITY_DEFAULT, 5], () => { this._emptyArmed = false; });
      return;
    }
    this._emptyArmed = false;
    const n = shelf.trashAll();
    Main.notify('ALLES', `Moved ${n} item${n === 1 ? '' : 's'} to the Trash.`);
    this._host.refreshShelf();
  }

  _shelfCopy(entry) {
    const shelf = this._host.shelf; if (!shelf) return;
    const clip = St.Clipboard.get_default();
    if (entry.kind === 'text') {
      const text = shelf.readText(entry.name);
      if (text == null) { Main.notify('ALLES', 'That snippet could not be read.'); return; }
      clip.set_text(St.ClipboardType.CLIPBOARD, text);
      Main.notify('ALLES', 'Text copied. Paste it where you want it.');
    } else {
      clip.set_content(St.ClipboardType.CLIPBOARD, 'x-special/gnome-copied-files', new GLib.Bytes(new TextEncoder().encode(shelf.filePayload(entry.name))));
      Main.notify('ALLES', `${entry.kind === 'folder' ? 'Folder' : 'File'} copied. Paste it in the file manager.`);
    }
  }

  // ------------------------------------------------------------------ what the host tells us

  setConfig(config) {
    this._config = config;
    const c = config.colors;
    const bits = [];
    if (c.text) bits.push(`color: ${c.text};`);
    if (c.background) bits.push(`background-color: ${c.background}; border-radius: 14px;`);
    this.style = bits.join(' ');
    this._label.visible = config.showLabel;
    this._bar.style_class = config.compact ? 'alles-bar alles-compact' : 'alles-bar';
    this._micBtn.visible = config.micButton;
    this._shelfSection.item.visible = config.shelf.enabled;
    this._render();
  }

  setState(state) {
    this._state = state;
    this._render();
  }

  setSamples(samples) { this._samples = samples; this._renderWidgets(); }
  setCommandResults(results) { this._commandResults = results; this._renderWidgets(); }

  setShelf(listing, note) {
    this._shelfListing = listing;
    this._shelfSummary.text = summarise(listing);
    this._shelfNote.text = note || '';
    this._shelfNote.visible = !!note;
    this._shelfList.destroy_all_children();
    for (const e of listing.items) {
      const icon = e.kind === 'folder' ? '📁' : e.kind === 'text' ? '📝' : '📄';
      const body = e.kind === 'text' && this._host.shelf ? this._host.shelf.readText(e.name) : null;
      const title = body ? snippetTitle(body) || e.name : e.name;
      const row = new St.BoxLayout({ style_class: 'alles-shelf-row', x_expand: true });
      const main = new St.Button({ label: `${icon}  ${title}`, style_class: 'alles-shelf-item', x_expand: true, x_align: Clutter.ActorAlign.START, can_focus: true });
      main.connect('clicked', safe(() => this._shelfCopy(e)));
      row.add_child(main);
      row.add_child(new St.Label({ text: humanAge(e.mtimeMs), style_class: 'alles-note', y_align: Clutter.ActorAlign.CENTER }));
      row.add_child(button('✕', () => { this._host.shelf.trash(e.name); this._host.refreshShelf(); }, 'alles-icon'));
      this._shelfList.add_child(row);
    }
    if (listing.more > 0) this._shelfList.add_child(new St.Label({ text: `…and ${listing.more} more (open the folder to see them)`, style_class: 'alles-note' }));
  }

  // ------------------------------------------------------------------ drawing

  _render() {
    const cfg = this._config; if (!cfg) return;
    const running = !!this._state;
    const d = describeState({ running, state: this._state }, cfg);
    this._orb.style = `background-color: ${cfg.colors[d.orb] || cfg.colors.idle};`;
    this._armed.visible = d.armed; this._armed.style = `background-color: ${cfg.colors.listening};`;
    const quiet = d.orb === 'idle' || d.orb === 'ready';
    this._label.text = d.label;
    this._label.visible = cfg.showLabel && !(cfg.compact && quiet);
    this.accessible_name = `ALLES: ${d.label}`;

    this._status.text = running ? d.label : 'ALLES is not running';
    const reply = running && this._state.status && this._state.status.reply ? this._state.status.reply : '';
    this._reply.text = running ? reply : 'The widgets and the shelf below work without it.';
    this._reply.visible = !!this._reply.text;
    this._stopBtn.visible = running && !!this._state.busy;
    this._startBtn.visible = !running;
    this._askSection.item.visible = true;
    this._sendBtn.reactive = running; this._micBtn.reactive = running;

    const ap = d.approval;
    this._approvalSection.item.visible = !!ap;
    if (ap) {
      this._apTitle.text = ap.title || 'Allow this?';
      this._apTarget.text = ap.target ? String(ap.target) : ''; this._apTarget.visible = !!ap.target;
      this._apBody.text = ap.body ? String(ap.body).slice(0, 800) : ''; this._apBody.visible = !!ap.body;
      const risks = Array.isArray(ap.risks) ? ap.risks.map((r) => `• ${r}`).join('\n') : '';
      this._apRisks.text = risks; this._apRisks.visible = !!risks;
      this._apAllow.label = ap.allowLabel || 'Allow';
      if (!this.menu.isOpen) this.menu.open(false);               // a question must not wait unseen
    }

    const listening = running && this._state.voice && this._state.voice.state === 'listening';
    this._micBtn.label = listening ? '⏹' : '🎤';
    const voice = (running && this._state.voice) || {};
    this._wakeItem.visible = running && voice.available !== false;
    this._wakeUpdating = true;
    this._wakeItem.setToggleState(!!voice.wake);
    this._wakeItem.label.text = `Wake word: “${voice.wakePhrase || 'hey alles'}”`;
    this._wakeUpdating = false;
    this._renderWidgets();
  }

  _renderWidgets() {
    const cfg = this._config; if (!cfg) return;
    const s = { ...this._samples, commands: this._commandResults };
    // bar
    this._widgets.destroy_all_children();
    for (const it of barItems(cfg.widgets, s, { compact: cfg.compact })) {
      this._widgets.add_child(new St.Label({ text: it.text, style_class: `alles-widget alles-tone-${it.tone}`, y_align: Clutter.ActorAlign.CENTER }));
    }
    // menu
    const rows = menuRows(cfg.widgets, s);
    this._resSection.item.visible = rows.length > 0;
    const sameRows = rows.length === this._rows.size && rows.every((r) => this._rows.has(r.id));
    if (!sameRows) {
      this._resSection.box.get_children().slice(1).forEach((c) => c.destroy());
      this._rows.clear();
      for (const r of rows) {
        const line = new St.BoxLayout({ x_expand: true, style_class: 'alles-res-row' });
        const title = new St.Label({ text: r.title, style_class: 'alles-res-title' });
        const value = new St.Label({ text: '', style_class: 'alles-res-value', x_expand: true, x_align: Clutter.ActorAlign.END });
        line.add_child(title); line.add_child(value);
        const track = new St.Widget({ style_class: 'alles-track', style: `width: ${TRACK_W}px;` });
        const fill = new St.Widget({ style_class: 'alles-fill' });
        track.add_child(fill);
        const box = new St.BoxLayout({ vertical: true, x_expand: true });
        box.add_child(line); box.add_child(track);
        this._resSection.box.add_child(box);
        this._rows.set(r.id, { title, value, track, fill });
      }
    }
    for (const r of rows) {
      const ui = this._rows.get(r.id); if (!ui) continue;
      ui.title.text = r.title;
      ui.value.text = r.detail && r.fraction == null ? `${r.value}  ${r.detail}` : r.value;
      ui.value.style_class = `alles-res-value alles-tone-${r.tone}`;
      ui.track.visible = r.fraction != null;
      if (r.fraction != null) { ui.fill.set_width(Math.round(Math.min(1, Math.max(0, r.fraction)) * TRACK_W)); ui.fill.style_class = `alles-fill alles-fill-${r.tone}`; }
    }
  }
});
