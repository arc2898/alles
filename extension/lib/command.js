// A custom "command" widget runs a program and shows the first line it prints. These are the pure rules for that:
// splitting the command into arguments WITHOUT a shell (so ; | $() > and friends are plain characters), and shortening the output.

const MAX_ARGS = 40;

/** 'uptime -p' / 'sh -c "echo hi"' -> argv array. Quotes and backslashes work as in a shell; nothing else does. null = not usable. */
export function splitCommand(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s) || s.includes('\n')) return null;
  const argv = []; let cur = ''; let has = false; let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length && /["\\]/.test(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) { argv.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (quote) return null;                                   // an unclosed quote
  if (has) argv.push(cur);
  return argv.length && argv.length <= MAX_ARGS && argv[0] ? argv : null;
}

/** What to show: the first non-empty line, control characters removed, cut to `max` characters. */
export function firstLine(output, max = 40) {
  const line = String(output == null ? '' : output).split('\n').map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).find((l) => l) || '';
  return line.length > max ? `${line.slice(0, Math.max(1, max - 1))}…` : line;
}
