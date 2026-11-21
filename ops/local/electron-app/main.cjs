const { app, BrowserWindow, Menu, shell } = require('electron');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const home = join(__dirname, '..');
const profile = join(home, 'electron-profile');
const origin = 'http://127.0.0.1:44100';
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setName('Vercel Board');
console.log('Vercel Board desktop starting');

const dragStyle = `
  /* There is no painted title bar: only the first 8 pixels can drag. */
  html::before {
    content: ''; position: fixed; top: 0; left: 0; right: 0; height: 8px;
    z-index: 2147483647; app-region: drag; -webkit-app-region: drag;
  }
`;

function inside(value) {
  try { return new URL(value).origin === origin; }
  catch { return false; }
}

function external(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      shell.openExternal(url.href).catch(() => console.error('Could not open HTTPS link'));
    }
  } catch {}
}

let win;
function open() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    title: 'Vercel Board', frame: false, width: 1280, height: 840,
    minWidth: 650, minHeight: 450, backgroundColor: '#080808',
    autoHideMenuBar: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;
  wc.session.setPermissionRequestHandler((_contents, _permission, cb) => cb(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (details, cb) => cb({ cancel: !inside(details.url) }));
  wc.setWindowOpenHandler(({ url }) => {
    if (inside(url)) wc.loadURL(url).catch(() => {});
    else external(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!inside(url)) {
      event.preventDefault();
      external(url);
    }
  });
  wc.on('will-redirect', (event, url) => {
    if (!inside(url)) event.preventDefault();
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.control || input.meta) && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      win.close();
    } else if (input.key === 'F11') {
      event.preventDefault();
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });
  win.on('page-title-updated', event => event.preventDefault());
  wc.on('did-finish-load', () => {
    if (!inside(wc.getURL())) return;
    wc.insertCSS(dragStyle).then(() => {
      if (!win || win.isDestroyed()) return;
      win.show();
      console.log('Vercel Board Inspector loaded in frameless Electron');
    }).catch(() => {
      console.error('Could not configure the frameless Board window');
      app.exit(1);
    });
  });
  win.on('closed', () => { win = null; });
  win.loadURL(origin + '/tasks').catch(() => {
    console.error('Could not load the local Vercel Board Inspector');
    app.exit(1);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(open).catch(error => {
    console.error('Vercel Board desktop failed to start:', error.message);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
}
