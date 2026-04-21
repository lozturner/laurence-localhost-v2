const { app, Tray, Menu, nativeImage, shell, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }

const APP_PORT = 4343;
const APP_URL = `http://localhost:${APP_PORT}`;
const V1_URL = 'http://localhost:4242';
const PROJECT_DIR = __dirname;

let tray = null;
let logWindow = null;
let serverModule = null;
let serverLogs = [];

// ── Tray Icon ─────────────────────────────────────────────────────
function createTrayIcon() {
  // Turner Foundry: anvil on molten-amber background — visually distinct from v1's indigo "://"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <defs>
      <linearGradient id="forge" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f59e0b"/>
        <stop offset="100%" stop-color="#78350f"/>
      </linearGradient>
    </defs>
    <rect width="16" height="16" rx="3" fill="url(#forge)"/>
    <path d="M3 10 h10 v1.5 h-2 v1 h-6 v-1 h-2 z M6 10 v-3 h4 v3 M5 7 h6 v-1 h-6 z" fill="#1c1917" stroke="none"/>
  </svg>`;
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return nativeImage.createFromDataURL(dataUrl);
}

// ── Server Lifecycle ──────────────────────────────────────────────
function captureLog(msg) {
  const ts = new Date().toLocaleTimeString();
  serverLogs.push(`[${ts}] ${msg}`);
  if (serverLogs.length > 500) serverLogs.shift();
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('log', `[${ts}] ${msg}`);
  }
}

// Intercept console.log from server
const origLog = console.log;
const origError = console.error;
console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  captureLog(msg);
  origLog.apply(console, args);
};
console.error = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  captureLog('[ERROR] ' + msg);
  origError.apply(console, args);
};

async function startExpressServer() {
  try {
    // Clear require cache so we can restart cleanly
    const serverPath = require.resolve('./server');
    delete require.cache[serverPath];

    serverModule = require('./server');
    await serverModule.startServer();
    captureLog('Express server started on port ' + APP_PORT);
    updateTrayTooltip('running');
  } catch (err) {
    captureLog('Server start failed: ' + err.message);
    updateTrayTooltip('error');
  }
}

async function stopExpressServer() {
  if (serverModule) {
    try {
      await serverModule.stopServer();
      captureLog('Express server stopped');
    } catch (err) {
      captureLog('Server stop error: ' + err.message);
    }
    serverModule = null;
  }
  updateTrayTooltip('stopped');
}

async function restartExpressServer() {
  captureLog('Restarting server...');
  updateTrayTooltip('restarting');
  await stopExpressServer();
  // Small delay before restart
  await new Promise(r => setTimeout(r, 500));
  await startExpressServer();
}

function updateTrayTooltip(status) {
  if (!tray) return;
  const statusText = {
    running: `Laurence Localhost v2 — Turner Foundry · running on :${APP_PORT}`,
    stopped: 'Laurence Localhost v2 — Turner Foundry · stopped',
    restarting: 'Laurence Localhost v2 — Turner Foundry · restarting…',
    error: 'Laurence Localhost v2 — Turner Foundry · error',
  };
  tray.setToolTip(statusText[status] || 'Laurence Localhost v2 — Turner Foundry');
}

// ── API Calls (from tray menu) ────────────────────────────────────
function apiCall(endpoint, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${APP_URL}${endpoint}`, { method }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Log Window ────────────────────────────────────────────────────
function showLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show();
    logWindow.focus();
    return;
  }

  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  logWindow = new BrowserWindow({
    width: 700,
    height: 500,
    x: width - 720,
    y: height - 520,
    title: 'Turner Foundry — Server Logs',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const logHtml = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 12px; background: #0a0a0f; color: #94a3b8; font-family: 'Courier New', monospace; font-size: 12px; }
  h3 { color: #6366f1; margin: 0 0 8px 0; font-size: 14px; }
  #logs { white-space: pre-wrap; line-height: 1.6; }
  .error { color: #ef4444; }
  .btn { padding: 4px 12px; background: #1e293b; border: 1px solid #334155; color: #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 12px; margin-right: 8px; }
  .btn:hover { background: #334155; }
  .toolbar { margin-bottom: 12px; display: flex; gap: 8px; }
</style></head><body>
  <h3>⚒ Turner Foundry — Server Logs</h3>
  <div class="toolbar">
    <button class="btn" onclick="document.getElementById('logs').textContent=''">Clear</button>
    <button class="btn" onclick="window.scrollTo(0,document.body.scrollHeight)">Scroll to Bottom</button>
  </div>
  <div id="logs"></div>
  <script>
    const logsEl = document.getElementById('logs');
    const { ipcRenderer } = require('electron');
    // Load existing logs
    const existing = ${JSON.stringify(serverLogs)};
    logsEl.textContent = existing.join('\\n');

    ipcRenderer.on('log', (e, msg) => {
      const line = document.createElement('div');
      line.textContent = msg;
      if (msg.includes('[ERROR]')) line.className = 'error';
      logsEl.appendChild(line);
      window.scrollTo(0, document.body.scrollHeight);
    });
  </script>
</body></html>`;

  logWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(logHtml));
  logWindow.on('closed', () => { logWindow = null; });
}

// ── Tray Menu ─────────────────────────────────────────────────────
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '⚒ Laurence Localhost v2 — Turner Foundry', enabled: false },
    { type: 'separator' },
    {
      label: 'Open v2 Dashboard (:4343)',
      click: () => shell.openExternal(APP_URL),
    },
    {
      label: 'Open v1 Phonebook (:4242)',
      click: () => shell.openExternal(V1_URL),
    },
    { type: 'separator' },
    {
      label: 'Re-scan Projects',
      click: async () => {
        try {
          const result = await apiCall('/api/scan');
          captureLog(`Re-scan complete: ${result.totalProjects} projects`);
        } catch (err) {
          captureLog('Re-scan failed: ' + err.message);
        }
      },
    },
    {
      label: 'Snap All Thumbnails',
      click: async () => {
        try {
          await apiCall('/api/thumbnails/generate');
          captureLog('Thumbnail generation started');
        } catch (err) {
          captureLog('Thumbnail generation failed: ' + err.message);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Dev Tools',
      submenu: [
        {
          label: 'Server Logs',
          click: () => showLogWindow(),
        },
        {
          label: 'Open Project Folder',
          click: () => shell.openPath(PROJECT_DIR),
        },
        {
          label: 'Open in Browser (DevTools)',
          click: () => shell.openExternal(APP_URL),
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Restart Server',
      click: () => restartExpressServer(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

// ── App Lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Create tray icon
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setContextMenu(buildTrayMenu());
  updateTrayTooltip('stopped');

  // Single click opens dashboard
  tray.on('click', () => shell.openExternal(APP_URL));

  // Start the Express server
  await startExpressServer();
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  await stopExpressServer();
  if (logWindow && !logWindow.isDestroyed()) logWindow.destroy();
});

// Stay running when all windows close (tray-only mode)
app.on('window-all-closed', (e) => {
  if (!app.isQuitting) e.preventDefault();
});

// Second instance: just open the dashboard
app.on('second-instance', () => {
  shell.openExternal(APP_URL);
});
