// What the pill looks like for a given state of the app: which colour the orb takes, what the label says, what the tooltip says.
// The app sends the state as JSON (src/main/pill-state.js); the extension only has to show it. Pure.

/** orb: one of idle | ready | working | attention | problem | listening (the keys of config.colors). */
export function describeState({ running, state }, config) {
  const max = config && config.labelMaxChars ? config.labelMaxChars : 28;
  const cut = (t) => { const s = String(t || ''); return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s; };
  if (!running || !state) return { orb: 'idle', label: 'ALLES', tooltip: 'ALLES is not running. Click to start it.', armed: false, approval: null, running: false };
  const voice = state.voice || {};
  const st = state.status || { state: 'idle', label: '' };
  const base = { armed: !!voice.wake, approval: state.approval || null, running: true };
  if (state.approval) return { ...base, orb: 'attention', label: cut(state.approval.title || 'Needs your OK'), tooltip: 'ALLES is waiting for your answer.' };
  if (voice.state === 'listening') return { ...base, orb: 'listening', label: cut('Listening…'), tooltip: 'Listening - speak now.' };
  if (voice.state === 'transcribing') return { ...base, orb: 'working', label: cut('Understanding…'), tooltip: 'Understanding what you said.' };
  if (voice.state === 'speaking') return { ...base, orb: 'working', label: cut('Speaking…'), tooltip: 'ALLES is speaking.' };
  switch (st.state) {
    case 'thinking': case 'acting': return { ...base, orb: 'working', label: cut(st.label || 'Working…'), tooltip: st.label || 'Working…' };
    case 'waiting': return { ...base, orb: 'attention', label: cut(st.label || 'Needs your OK'), tooltip: 'ALLES is waiting for your answer.' };
    case 'error': return { ...base, orb: 'problem', label: cut(st.label || 'Something went wrong'), tooltip: st.reply || 'Something went wrong.' };
    case 'done': return { ...base, orb: 'ready', label: cut(st.label || 'Done'), tooltip: st.reply || 'Done.' };
    case 'stopped': return { ...base, orb: 'idle', label: cut(st.label || 'Stopped'), tooltip: 'Stopped.' };
    default: return { ...base, orb: 'ready', label: cut('ALLES'), tooltip: voice.wake ? `Say “${voice.wakePhrase || 'hey alles'}” or click to ask.` : 'Click to ask ALLES.' };
  }
}

/** The CSS for the pill's colours from the settings. Only validated #rrggbb values ever get here (config.js). */
export function orbStyle(config, orb) {
  const c = (config && config.colors) || {};
  return `background-color: ${c[orb] || c.idle};`;
}
