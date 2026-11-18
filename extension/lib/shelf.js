// The shelf: a folder where the person keeps things for a little while (text snippets, files, folders). The folder is an
// ordinary one that the file manager can also use. These are the pure rules: how entries are named, ordered, shown and expired.

export const MARKER = '.alles-shelf';          // inside a shelf folder: "this folder is a shelf, the app may tidy it"
const DAY = 86_400_000;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** A file name that is safe inside the shelf: no slashes or control characters, not hidden, not too long. */
export function safeName(name, fallback = 'item') {
  let n = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^[.\s]+/, '');                       // never hidden, never ".."
  if (n.length > 120) { const dot = n.lastIndexOf('.'); const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : ''; n = n.slice(0, 120 - ext.length) + ext; }
  return n || fallback;
}

/** Text saved from the clipboard becomes "snippet-20261104-153012.txt". */
export function snippetFileName(date = new Date()) {
  return `snippet-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}

/** The first non-empty line of a snippet, as its title in the list. */
export function snippetTitle(text, max = 48) {
  const line = String(text == null ? '' : text).split('\n').map((l) => l.replace(/[\u0000-\u001f]/g, ' ').trim()).find((l) => l) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A name that does not clash with the names already there: "report.pdf" -> "report (2).pdf". */
export function uniqueName(name, existing) {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; i < 1000; i++) { const c = `${stem} (${i})${ext}`; if (!taken.has(c)) return c; }
  return `${stem} (${Date.now()})${ext}`;
}

/** entries: [{ name, isDir, size, mtimeMs }] -> what to list: hidden items and the marker left out, newest first. */
export function listEntries(entries, { max = 12 } = {}) {
  const shown = (entries || []).filter((e) => e && typeof e.name === 'string' && !e.name.startsWith('.')).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return { items: shown.slice(0, max).map((e) => ({ ...e, kind: e.isDir ? 'folder' : /^snippet-.*\.txt$|\.txt$/i.test(e.name) ? 'text' : 'file' })), more: Math.max(0, shown.length - max), total: shown.length };
}

export function humanAge(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Items older than `keepDays` days (0 = never). Hidden entries are never touched. */
export function expired(entries, keepDays, now = Date.now()) {
  if (!(keepDays > 0)) return [];
  return (entries || []).filter((e) => e && typeof e.name === 'string' && !e.name.startsWith('.') && Number.isFinite(e.mtimeMs) && now - e.mtimeMs > keepDays * DAY);
}

/**
 * Whether tidying is allowed in this folder. Only a folder this app made (the default one) or one it has marked as a shelf:
 * pointing the shelf at Documents must never mean "throw away what is older than a week".
 */
export function mayExpire({ isDefaultFolder, hasMarker }) { return !!(isDefaultFolder || hasMarker); }

/** '/home/me/My Files/a b.txt' -> 'file:///home/me/My%20Files/a%20b.txt' */
export function pathToUri(path) {
  return `file://${String(path).split('/').map((s) => encodeURIComponent(s)).join('/')}`;
}

/** What GNOME's file manager puts on the clipboard for "Copy" (so a paste there copies the file). */
export function copiedFilesPayload(paths) {
  return `copy\n${paths.map(pathToUri).join('\n')}`;
}

/** Folders added to the shelf hold a lot: a count, not a listing. */
export function summarise(listing) {
  const { total } = listing;
  return total === 0 ? 'Empty' : total === 1 ? '1 item' : `${total} items`;
}
