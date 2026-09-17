const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

// The web app (index.html) is left completely untouched -- it's the single
// source of truth shared with the GitHub Pages site. To make the Mac app
// fully offline-capable (it otherwise pulls its fonts from Google Fonts
// over the network, same as the web version), we transform a copy of it
// in memory at launch: swap the Google Fonts <link> for @font-face rules
// pointing at font files bundled inside the app, then write that copy to
// this app's own data directory and load it from there. index.html on
// disk is never modified.
const FONT_FILES = [
  { family: 'Rajdhani', weight: 400, file: 'rajdhani-latin-400-normal.woff2' },
  { family: 'Rajdhani', weight: 500, file: 'rajdhani-latin-500-normal.woff2' },
  { family: 'Rajdhani', weight: 600, file: 'rajdhani-latin-600-normal.woff2' },
  { family: 'Rajdhani', weight: 700, file: 'rajdhani-latin-700-normal.woff2' },
  { family: 'Share Tech Mono', weight: 400, file: 'share-tech-mono-latin-400-normal.woff2' },
  { family: 'M PLUS Rounded 1c', weight: 700, file: 'm-plus-rounded-1c-latin-700-normal.woff2' },
  { family: 'M PLUS Rounded 1c', weight: 800, file: 'm-plus-rounded-1c-latin-800-normal.woff2' },
  { family: 'M PLUS Rounded 1c', weight: 900, file: 'm-plus-rounded-1c-latin-900-normal.woff2' }
];

const GOOGLE_FONTS_LINK_RE = /\n?[ \t]*<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*" rel="stylesheet">[ \t]*\n?/;

function buildOfflineHtmlFile() {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  const fontFaceRules = FONT_FILES.map(({ family, weight, file }) => {
    const b64 = fs.readFileSync(path.join(__dirname, 'build', 'fonts', file)).toString('base64');
    return `    @font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  }).join('\n');

  let offlineHtml = html.replace(GOOGLE_FONTS_LINK_RE, '\n');
  offlineHtml = offlineHtml.replace('<style>', `<style>\n${fontFaceRules}\n`);

  const outPath = path.join(app.getPath('userData'), 'offline-index.html');
  fs.writeFileSync(outPath, offlineHtml, 'utf8');
  return outPath;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: '#050605',
    title: 'BG·ProMIDI',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(buildOfflineHtmlFile());
}

app.whenReady().then(() => {
  // Electron does not surface a browser-style permission prompt for MIDI/MIDI
  // SysEx access -- it must be granted explicitly here, or navigator.requestMIDIAccess
  // will silently reject inside the app.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'midi' || permission === 'midiSysex') {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'midi' || permission === 'midiSysex';
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
