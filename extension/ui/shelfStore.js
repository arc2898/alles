// The shelf's files. Only the Gio calls are here; what to list, how to name things and when something has expired is lib/shelf.js.
//
// The shelf is an ordinary folder (by default ~/ALLES Shelf) so the file manager works on it too. Items only ever leave it by going to
// the Trash, never by being deleted outright, and nothing is tidied up unless the folder is the default one or carries the marker
// file that says "this is a shelf" (so pointing the shelf at Documents can never mean "trash what is older than a week").
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { MARKER, safeName, snippetFileName, uniqueName, listEntries, expired, mayExpire, copiedFilesPayload } from '../lib/shelf.js';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SCAN = 500;
const COPY_LIMITS = { files: 2000, bytes: 1024 * 1024 * 1024, depth: 12 };
const ATTRS = 'standard::name,standard::type,standard::size,time::modified';

export class ShelfStore {
  /** @param {{folder:string, keepDays:number}} cfg  config.shelf */
  constructor(cfg) { this.setConfig(cfg); }

  setConfig(cfg) {
    this._cfg = cfg;
    this._isDefault = !cfg.folder;
    this.path = cfg.folder || GLib.build_filenamev([GLib.get_home_dir(), 'ALLES Shelf']);
  }

  _file(name) { return Gio.File.new_for_path(GLib.build_filenamev([this.path, name])); }

  /** Create the folder if needed. A folder that did not exist, or is empty, becomes a marked shelf. */
  ensure() {
    try {
      const existed = GLib.file_test(this.path, GLib.FileTest.IS_DIR);
      if (!existed) GLib.mkdir_with_parents(this.path, 0o700);
      const marker = GLib.build_filenamev([this.path, MARKER]);
      if (!GLib.file_test(marker, GLib.FileTest.EXISTS) && (this._isDefault || !existed || this._isEmptyFolder())) GLib.file_set_contents(marker, 'This folder is an ALLES shelf. ALLES may move items older than the chosen number of days to the Trash.\n');
      return true;
    } catch (e) { console.error(`ALLES shelf: ${e.message}`); return false; }
  }

  _isEmptyFolder() { try { const d = GLib.Dir.open(this.path, 0); const n = d.read_name(); d.close(); return n === null; } catch (_e) { return false; } }
  _hasMarker() { return GLib.file_test(GLib.build_filenamev([this.path, MARKER]), GLib.FileTest.EXISTS); }

  /** All entries (capped), as lib/shelf.js wants them. */
  entries() {
    const out = [];
    try {
      const en = Gio.File.new_for_path(this.path).enumerate_children(ATTRS, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
      let info;
      while ((info = en.next_file(null)) !== null && out.length < MAX_SCAN) {
        out.push({ name: info.get_name(), isDir: info.get_file_type() === Gio.FileType.DIRECTORY, size: info.get_size(), mtimeMs: info.get_attribute_uint64('time::modified') * 1000 });
      }
      en.close(null);
    } catch (_e) { /* no folder yet: an empty shelf */ }
    return out;
  }

  list(max) { return listEntries(this.entries(), { max }); }

  /** Save text as a new snippet file. Returns the file name or null. */
  addText(text) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return null;
    if (!this.ensure()) return null;
    const bytes = new TextEncoder().encode(t);
    if (bytes.length > MAX_TEXT_BYTES) return null;
    const name = uniqueName(snippetFileName(new Date()), this.entries().map((e) => e.name));
    try { GLib.file_set_contents(GLib.build_filenamev([this.path, name]), t); GLib.chmod(GLib.build_filenamev([this.path, name]), 0o600); return name; } catch (e) { console.error(`ALLES shelf: ${e.message}`); return null; }
  }

  /** Copy files or folders (given by path) into the shelf. Symbolic links are skipped, not followed. Returns how many were added. */
  addPaths(paths) {
    if (!this.ensure()) return 0;
    let added = 0;
    const budget = { files: 0, bytes: 0 };
    for (const src of paths) {
      try {
        const from = Gio.File.new_for_path(src);
        const base = safeName(from.get_basename(), 'item');
        const name = uniqueName(base, this.entries().map((e) => e.name));
        if (this._copyTree(from, this._file(name), budget, 0)) added++;
      } catch (e) { console.error(`ALLES shelf: ${e.message}`); }
    }
    return added;
  }

  _copyTree(from, to, budget, depth) {
    const info = from.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    const type = info.get_file_type();
    if (type === Gio.FileType.SYMBOLIC_LINK) return false;
    if (type === Gio.FileType.DIRECTORY) {
      if (depth > COPY_LIMITS.depth) return false;
      to.make_directory_with_parents(null);
      const en = from.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
      let child;
      while ((child = en.next_file(null)) !== null) this._copyTree(from.get_child(child.get_name()), to.get_child(child.get_name()), budget, depth + 1);
      en.close(null);
      return true;
    }
    if (type !== Gio.FileType.REGULAR) return false;
    budget.files++; budget.bytes += info.get_size();
    if (budget.files > COPY_LIMITS.files || budget.bytes > COPY_LIMITS.bytes) return false;
    from.copy(to, Gio.FileCopyFlags.NONE, null, null);
    return true;
  }

  /** Move one item to the Trash. */
  trash(name) {
    try { return this._file(safeName(name)).trash(null); } catch (e) { console.error(`ALLES shelf: ${e.message}`); return false; }
  }

  trashAll() {
    let n = 0;
    for (const e of this.entries()) if (!e.name.startsWith('.') && this.trash(e.name)) n++;
    return n;
  }

  /** The text of a snippet (for copying it back). */
  readText(name) {
    try {
      const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([this.path, safeName(name)]));
      return ok && bytes.length <= MAX_TEXT_BYTES ? new TextDecoder().decode(bytes) : null;
    } catch (_e) { return null; }
  }

  /** The clipboard payload that makes a paste in the file manager copy this item. */
  filePayload(name) { return copiedFilesPayload([GLib.build_filenamev([this.path, safeName(name)])]); }
  itemPath(name) { return GLib.build_filenamev([this.path, safeName(name)]); }

  /** Move expired items to the Trash. Returns how many. Does nothing unless the folder is allowed to be tidied. */
  tidy() {
    if (!(this._cfg.keepDays > 0) || !mayExpire({ isDefaultFolder: this._isDefault, hasMarker: this._hasMarker() })) return 0;
    let n = 0;
    for (const e of expired(this.entries(), this._cfg.keepDays)) if (this.trash(e.name)) n++;
    return n;
  }

  /** Whether tidying is switched on but not allowed here (so the menu can say why nothing is being tidied). */
  tidyBlocked() { return this._cfg.keepDays > 0 && !mayExpire({ isDefaultFolder: this._isDefault, hasMarker: this._hasMarker() }); }

  /** Watch the folder; `callback` is called (without detail) when anything in it changes. Returns an object with destroy(). */
  watch(callback) {
    let monitor = null; let id = 0;
    try {
      this.ensure();
      monitor = Gio.File.new_for_path(this.path).monitor_directory(Gio.FileMonitorFlags.NONE, null);
      id = monitor.connect('changed', () => callback());
    } catch (e) { console.error(`ALLES shelf: cannot watch ${this.path}: ${e.message}`); }
    return { destroy: () => { if (monitor) { if (id) monitor.disconnect(id); monitor.cancel(); monitor = null; } } };
  }
}
