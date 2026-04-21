const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const THUMBNAILS_DIR = path.join(__dirname, 'public', 'thumbnails');
const CACHE_MAX_AGE = 30 * 60 * 1000; // 30 minutes for static, 5 min for live
const LIVE_CACHE_AGE = 5 * 60 * 1000;

// Ensure thumbnails directory exists
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

let browser = null;
let tempServer = null;
let tempPort = 49500; // High port for temp file serving

// Framework colors for generated placeholders
const FRAMEWORK_COLORS = {
  'Next.js': { bg: '#000000', fg: '#ffffff', accent: '#0070f3' },
  'Vite': { bg: '#1a1a2e', fg: '#ffffff', accent: '#bd93f9' },
  'React': { bg: '#20232a', fg: '#61dafb', accent: '#61dafb' },
  'Create React App': { bg: '#20232a', fg: '#61dafb', accent: '#61dafb' },
  'Express': { bg: '#0d1117', fg: '#22c55e', accent: '#22c55e' },
  'Electron': { bg: '#2b2e3b', fg: '#9feaf9', accent: '#9feaf9' },
  'Python': { bg: '#1a1a2e', fg: '#ffd43b', accent: '#3776ab' },
  'Django': { bg: '#0c4b33', fg: '#ffffff', accent: '#44b78b' },
  'Flask': { bg: '#1a1a2e', fg: '#ffffff', accent: '#97979f' },
  'Docker': { bg: '#0b214a', fg: '#ffffff', accent: '#2496ed' },
  'Node-RED': { bg: '#461a1a', fg: '#ffffff', accent: '#ef4444' },
  'XAMPP': { bg: '#3d1e00', fg: '#ffffff', accent: '#fb923c' },
  'Static HTML': { bg: '#1a1a1a', fg: '#e44d26', accent: '#f06529' },
  'Three.js': { bg: '#0a0a1a', fg: '#ffffff', accent: '#049ef4' },
};

async function getBrowser() {
  if (browser && browser.connected) return browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      timeout: 15000,
    });
    return browser;
  } catch (err) {
    console.error('Puppeteer launch failed:', err.message);
    return null;
  }
}

// Find servable HTML content in a project directory
function findServableContent(projectPath) {
  // Priority order: built output > public dir > root index
  const candidates = [
    { dir: path.join(projectPath, 'out'), type: 'static-export' },
    { dir: path.join(projectPath, 'dist'), type: 'build-output' },
    { dir: path.join(projectPath, 'build'), type: 'build-output' },
    { dir: path.join(projectPath, 'public'), type: 'public-dir' },
    { dir: projectPath, type: 'root', file: 'index.html' },
  ];

  for (const c of candidates) {
    const indexPath = c.file
      ? path.join(c.dir, c.file)
      : path.join(c.dir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return { servePath: c.dir, type: c.type };
    }
  }
  return null;
}

// Start a temporary static file server for screenshots
async function serveTempStatic(dirPath) {
  if (tempServer) {
    try { tempServer.close(); } catch {}
    tempServer = null;
  }

  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      const app = express();
      app.use(express.static(dirPath));
      const srv = http.createServer(app);
      srv.listen(port, '127.0.0.1', () => {
        tempServer = srv;
        tempPort = port;
        resolve(port);
      });
      srv.on('error', () => {
        // Port in use - try next
        const next = port >= 49600 ? 49500 : port + 1;
        tryListen(next);
      });
    };
    tempPort++;
    if (tempPort > 49600) tempPort = 49500;
    tryListen(tempPort);
  });
}

function closeTempServer() {
  if (tempServer) {
    try { tempServer.close(); } catch {}
    tempServer = null;
  }
}

// Take a screenshot of a URL
async function screenshotUrl(url, thumbPath) {
  const b = await getBrowser();
  if (!b) return null;

  let page;
  try {
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    // Try networkidle2 first, fall back to domcontentloaded on timeout
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    } catch {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    }
    // Extra wait for JS-heavy frameworks to render
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: thumbPath, type: 'png' });
    return thumbPath;
  } catch (err) {
    console.error(`Screenshot failed for ${url}:`, err.message);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
}

// Generate a styled placeholder thumbnail using Puppeteer
async function generatePlaceholder(project, thumbPath) {
  const b = await getBrowser();
  if (!b) return null;

  // Find matching color scheme
  let colors = { bg: '#12121a', fg: '#e2e8f0', accent: '#6366f1' };
  for (const [fw, c] of Object.entries(FRAMEWORK_COLORS)) {
    if (project.framework.includes(fw)) { colors = c; break; }
  }

  const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1280px; height: 800px; background: ${colors.bg};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden; position: relative;
  }
  .grid {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
  }
  .glow {
    position: absolute; width: 400px; height: 400px; border-radius: 50%;
    background: ${colors.accent}; opacity: 0.08; filter: blur(100px);
    top: 50%; left: 50%; transform: translate(-50%, -50%);
  }
  .icon {
    font-size: 96px; font-weight: 800; color: ${colors.accent};
    opacity: 0.9; letter-spacing: -4px; margin-bottom: 24px;
    text-shadow: 0 0 60px ${colors.accent}40;
    position: relative; z-index: 1;
  }
  .name {
    font-size: 42px; font-weight: 700; color: ${colors.fg};
    position: relative; z-index: 1; text-align: center; padding: 0 40px;
    text-shadow: 0 2px 20px rgba(0,0,0,0.5);
  }
  .framework {
    font-size: 22px; color: ${colors.accent}; margin-top: 16px;
    font-weight: 500; position: relative; z-index: 1;
    padding: 6px 20px; border: 1px solid ${colors.accent}40;
    border-radius: 8px; background: ${colors.accent}10;
  }
  .ports {
    margin-top: 16px; font-size: 18px; color: ${colors.fg}80;
    font-family: 'Courier New', monospace; position: relative; z-index: 1;
  }
</style></head><body>
  <div class="grid"></div>
  <div class="glow"></div>
  <div class="icon">${getIconText(project.framework)}</div>
  <div class="name">${escapeHtml(project.name)}</div>
  <div class="framework">${escapeHtml(project.framework)}</div>
  ${project.ports.length ? `<div class="ports">${project.ports.map(p => ':' + p).join('  ')}</div>` : ''}
</body></html>`;

  let page;
  try {
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: thumbPath, type: 'png' });
    return thumbPath;
  } catch (err) {
    console.error(`Placeholder generation failed for ${project.name}:`, err.message);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
}

function getIconText(framework) {
  const icons = {
    'Next.js': 'N', 'Vite': '&#9889;', 'React': '&#9883;',
    'Create React App': '&#9883;', 'Express': 'Ex', 'Electron': '&#9889;',
    'Python': 'Py', 'Django': 'Dj', 'Flask': 'Fl', 'Docker': '&#9881;',
    'Node-RED': 'NR', 'XAMPP': 'X', 'Static HTML': '&lt;/&gt;',
    'Three.js': '3D',
  };
  for (const [fw, icon] of Object.entries(icons)) {
    if (framework.includes(fw)) return icon;
  }
  return '{ }';
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Main capture function - tries multiple strategies
async function captureThumbnail(project) {
  const thumbPath = path.join(THUMBNAILS_DIR, `${project.id}.png`);
  const isRunning = project.status === 'running' && project.activePort;

  // Check cache
  try {
    const stat = fs.statSync(thumbPath);
    const maxAge = isRunning ? LIVE_CACHE_AGE : CACHE_MAX_AGE;
    if (Date.now() - stat.mtimeMs < maxAge) {
      return `/thumbnails/${project.id}.png`;
    }
  } catch {} // File doesn't exist

  console.log(`Capturing thumbnail for ${project.name}...`);

  // Strategy 1: Live screenshot if running
  if (isRunning) {
    const result = await screenshotUrl(`http://localhost:${project.activePort}`, thumbPath);
    if (result) return `/thumbnails/${project.id}.png`;
  }

  // Strategy 2: Serve static content and screenshot
  const servable = findServableContent(project.path);
  if (servable) {
    try {
      const port = await serveTempStatic(servable.servePath);
      const result = await screenshotUrl(`http://127.0.0.1:${port}`, thumbPath);
      closeTempServer();
      if (result) return `/thumbnails/${project.id}.png`;
    } catch (err) {
      closeTempServer();
      console.error(`Temp serve failed for ${project.name}:`, err.message);
    }
  }

  // Strategy 3: Generate a styled placeholder
  const result = await generatePlaceholder(project, thumbPath);
  if (result) return `/thumbnails/${project.id}.png`;

  return null;
}

// Batch capture all thumbnails (for initial scan)
async function captureAllThumbnails(projects) {
  console.log(`Generating thumbnails for ${projects.length} projects...`);
  const results = {};
  for (const project of projects) {
    try {
      const url = await captureThumbnail(project);
      if (url) results[project.id] = url;
    } catch (err) {
      console.error(`Thumbnail failed for ${project.name}:`, err.message);
    }
  }
  closeTempServer();
  console.log(`Generated ${Object.keys(results).length} thumbnails`);
  return results;
}

async function closeBrowser() {
  closeTempServer();
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

module.exports = { captureThumbnail, captureAllThumbnails, closeBrowser };
