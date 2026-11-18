'use strict';
// A window that shows what reaches it: its TITLE always says what it has seen, so a test can read it from the desktop without
// looking inside anything. Run with `electron target-window.js` (the tests start it).
//
//   title = "T" + $TARGET_ID + " " + JSON:      (TARGET_ID, TARGET_X, TARGET_Y can be set to run several of these side by side)
//
// THE DESKTOP CUTS A WINDOW TITLE AT 512 CHARACTERS (measured), and a cut title is unreadable JSON. So what is reported depends on
// $TARGET_VIEW, and the lists drop their oldest entries when the title would get too long:
//
//   (default)      the mouse, the wheel and the last few keys:
//       c / u      number of mouse presses / releases;        dbl: double clicks;   ctx: right-button menus asked for
//       last       [pageX, pageY, screenX, screenY, button] of the latest press;    lastUp: [pageX, pageY, button] of the latest release
//       moves      how many pointer moves it saw while a button was held (a drag has some, a click has none)
//       keys       the last 8 key names (C- Ctrl, A- Alt, M- Super, S- Shift in front when held; a held Shift is only shown for named keys, a letter's case says it)
//       wheel      the last 4 wheel events [dx, dy];  wn: how many wheel events;  ws: [sum dx, sum dy]
//       ev         the last 24 pointer events as letters: D press, U release, M move, S drag-start, O pointer left the window
//   TARGET_VIEW=keys     what every key press PRODUCED, for the keyboard-layout test (plus c, u and the page position of the last press, so that a click can find its way around):
//       kl         what the latest key presses (modifier keys and Escape not counted) produced as KeyboardEvent.key, one character each: the letter itself,
//                  a tab for any named key ("Dead" for a dead accent key, "Enter", "Tab" ...);  kn: how many presses there have been, so the new ones are the last kn-before of kl
//                  ke: how many Escape key presses (not in kl or kn: after a dead accent key the desktop reports the Escape that cancels it as "Dead", so it could not tell presses apart by what they say)
//   TARGET_VIEW=codes    which PHYSICAL keys were pressed (for finding out what the desktop really presses):
//       keys       as above;  codes: the same for KeyboardEvent.code ("KeyZ", "Comma", "ShiftLeft", "AltRight" ...), same prefixes
//
//   in every view:
//       text       what is in the text box (not in the keys view; a long text is cut to its first and last 80 characters);  tl: its length;  th: its checksum (FNV-1a, textHash below)
//       boxFocus   the text box has the keyboard;  focus: the window has it
//       box        [x, y, w, h] of the text box in the page;  pad: [x, y, w, h] of the plain area under it (the page is made to fit a small window)
//   Colours a picture of the screen can look for: the text box is #fff7d6, the pad under it #335566, the page #223355.
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());

const PAGE = `<!doctype html><title>T${process.env.TARGET_ID || ''} {}</title>
<body style="margin:0;background:#235;color:#fff;font:16px sans-serif">
<input id="t" autofocus style="position:absolute;left:20px;top:10px;width:420px;font-size:18px;background:#fff7d6;color:#000">
<div id="pad" style="position:absolute;left:20px;top:60px;width:420px;height:150px;background:#356"></div>
<script>
  const view = '${process.env.TARGET_VIEW || ''}';
  const state = { ev: '', c: 0, u: 0, dbl: 0, ctx: 0, last: null, lastUp: null, moves: 0, pressed: false, keys: [], codes: [], kl: '', kn: 0, ke: 0, wheel: [], wn: 0, ws: [0, 0] };
  const MODIFIERS = ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'Hyper', 'Super', 'ISO_Level3_Shift', 'ISO_Level5_Shift', 'Compose'];
  const t = document.getElementById('t');
  const box = () => { const r = t.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const pad = () => { const r = document.getElementById('pad').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const clip = (s) => (s.length > 160 ? s.slice(0, 80) + '…' + s.slice(-80) : s);
  const textHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const log = (ch) => { state.ev = (state.ev + ch).slice(-24); };
  const show = () => {
    const common = { pad: pad(), tl: t.value.length, th: textHash(t.value), focus: document.hasFocus(), box: box(), boxFocus: document.activeElement === t };
    let o;
    if (view === 'keys') o = { ...common, c: state.c, u: state.u, last: state.last && state.last.slice(0, 2), kl: state.kl, kn: state.kn, ke: state.ke };
    else if (view === 'codes') o = { ...common, text: clip(t.value), keys: state.keys.slice(-8), codes: state.codes.slice(-8) };
    else o = { ev: state.ev, ...common, text: clip(t.value), c: state.c, u: state.u, dbl: state.dbl, ctx: state.ctx, last: state.last, lastUp: state.lastUp, moves: state.moves,
      keys: state.keys.slice(-8), wheel: state.wheel.slice(-4), wn: state.wn, ws: state.ws };
    let s = JSON.stringify(o);
    while (s.length > 470 && ((o.keys && o.keys.length > 1) || (o.codes && o.codes.length > 1) || (o.wheel && o.wheel.length > 1) || o.kl)) {
      if (o.kl) o.kl = o.kl.slice(Math.max(1, Math.ceil((s.length - 470) / 2))); else if (o.codes && o.codes.length > 1) o.codes.shift(); else if (o.keys && o.keys.length > 1) o.keys.shift(); else o.wheel.shift();
      s = JSON.stringify(o);
    }
    document.title = 'T${process.env.TARGET_ID || ''} ' + s;
  };
  window.addEventListener('mousedown', (e) => { log('D'); state.c++; state.last = [e.pageX, e.pageY, e.screenX, e.screenY, e.button]; state.moves = 0; state.pressed = true; show(); }, true);
  window.addEventListener('mousemove', () => { log('M'); if (state.pressed) { state.moves++; show(); } }, true);
  window.addEventListener('dragstart', () => { log('S'); show(); }, true);
  document.addEventListener('mouseleave', () => { log('O'); show(); }, true);
  window.addEventListener('mouseup', (e) => { log('U'); state.u++; state.lastUp = [e.pageX, e.pageY, e.button]; state.pressed = false; show(); }, true);
  window.addEventListener('dblclick', () => { state.dbl++; show(); }, true);
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); state.ctx++; show(); }, true);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') state.ke++;                                            // (by its place on the keyboard: after a dead accent key the desktop reports the Escape that cancels it as "Dead")
    else if (!MODIFIERS.includes(e.key)) { state.kn++; state.kl = (state.kl + (e.key.length === 1 ? e.key : '\\t')).slice(-60); }
    state.codes.push((e.ctrlKey ? 'C-' : '') + (e.altKey ? 'A-' : '') + (e.metaKey ? 'M-' : '') + (e.shiftKey ? 'S-' : '') + e.code);
    state.keys.push((e.ctrlKey ? 'C-' : '') + (e.altKey ? 'A-' : '') + (e.metaKey ? 'M-' : '') + (e.shiftKey && e.key.length > 1 ? 'S-' : '') + e.key);
    show();
  }, true);
  window.addEventListener('wheel', (e) => { state.wheel.push([Math.round(e.deltaX), Math.round(e.deltaY)]); state.wn++; state.ws = [state.ws[0] + Math.round(e.deltaX), state.ws[1] + Math.round(e.deltaY)]; show(); }, true);
  t.addEventListener('input', show);
  window.addEventListener('focus', show); window.addEventListener('blur', show);
  t.focus(); show();
</script>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({ x: Number(process.env.TARGET_X || 100), y: Number(process.env.TARGET_Y || 120), width: 600, height: 400, show: true, useContentSize: true, backgroundColor: '#223355' });
  win.loadURL('data:text/html,' + encodeURIComponent(PAGE));
});
