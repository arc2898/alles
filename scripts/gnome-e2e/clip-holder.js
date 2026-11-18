'use strict';
// Puts text on the clipboard and keeps it there (the program that "owns" a clipboard must stay alive for others to paste it).
// Harness only: the text comes from the CLIP_TEXT environment variable; it prints READY once the clipboard holds it.
const { app, clipboard } = require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  clipboard.writeText(process.env.CLIP_TEXT || '');
  console.log('READY');
  setTimeout(() => app.quit(), 120000);
});
