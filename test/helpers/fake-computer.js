'use strict';

/**
 * Stand-ins for the two parts of the computer that a test must never touch for real: the screenshot tool and the mouse/keyboard
 * connection. A test that built a real App and then asked it to "check this computer" would, on a developer's real GNOME desktop,
 * take a real screenshot and open a real screen-sharing session.
 *
 *   const computer = fakeComputer();
 *   const app = new App({ electron, userDataDir, makeInputBackend: computer.makeInputBackend });
 *   app.create();
 *   computer.install(app);                       // the screenshot part is built inside create(), so it is swapped afterwards
 *
 * Everything the app does with them is recorded: computer.screen.calls (number of screenshots), computer.backend.log (what the
 * mouse/keyboard connection was asked: 'resume', ['moveBy', dx, dy], 'close'), so a test can say what was NOT touched.
 */

/** A mouse/keyboard backend that does nothing and says what it was asked. `over` replaces any member (a failing moveBy, say). */
function fakeBackend(over = {}) {
  const b = {
    name: 'gnome',
    log: [],
    infoValue: { name: 'gnome', label: "GNOME's own input", unicode: true, scroll: true, drag: true },
    info() { return this.infoValue; },
    async capabilities() { return this.info(); },
    resume() { this.log.push('resume'); },
    close() { this.log.push('close'); },
    async dispose() { this.log.push('dispose'); },
    async moveBy(dx, dy) { this.log.push(['moveBy', dx, dy]); },
    async moveTo(x, y) { this.log.push(['moveTo', x, y]); },
    ...over,
  };
  return b;
}

/** A screenshot tool that "sees" a 1366x768 screen (the model gets 1280x720). `delayMs` makes it slow, `fail` makes it throw. */
function fakeScreen({ delayMs = 0, fail = null, size = { width: 1366, height: 768, modelWidth: 1280, modelHeight: 720 } } = {}) {
  const s = {
    calls: 0,
    delayMs,
    fail,
    async capture() {
      s.calls++;
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      if (s.fail) throw (s.fail instanceof Error ? s.fail : new Error(String(s.fail)));
      return { png: Buffer.alloc(0), original: Buffer.alloc(0), scale: 1, ...size };
    },
  };
  return s;
}

function fakeComputer({ screen = {}, backend = {} } = {}) {
  const c = { screen: fakeScreen(screen), backend: fakeBackend(backend), made: 0 };
  c.makeInputBackend = () => { c.made++; return c.backend; };
  c.install = (app) => { app.screen = c.screen; return app; };
  return c;
}

module.exports = { fakeComputer, fakeBackend, fakeScreen };
