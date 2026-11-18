'use strict';
// A plain window, to click on: the tests need "some other app" to move the keyboard to. Run with `electron other-window.js`.
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  const win = new BrowserWindow({ x: 100, y: 120, width: 320, height: 240, show: true, backgroundColor: '#aa3333' });
  win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>OTHER</title><body style="margin:0;background:#a33"></body>'));
});
