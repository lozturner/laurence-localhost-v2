const express = require('express');
const path = require('path');
const fs = require('fs');
const { version: APP_VERSION } = require('./package.json');
const { execSync, spawn } = require('child_process');
const { scan } = require('./scanner');
const { enrichProjects, getActivePortsPIDs, detectConflicts } = require('./port-checker');
const { enrichDescriptions } = require('./describer');
const { captureThumbnail, captureAllThumbnails, closeBrowser } = require('./thumbnailer');
const { resolveAllConflicts } = require('./resolver');

const app = express();
const PORT = 4343;
const BIND_HOST = '127.0.0.1'; // v2 security ledger H1: never listen on 0.0.0.0

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// v2 ledger H1: reject cross-origin state-changing requests. Same-origin + tray/curl (no Origin header) are fine.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const u = new URL(origin);
    if (u.host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: 'cross-origin mutation blocked (v2 H1)' });
});

// In-memory cache
let cachedProjects = null;
let cachedConflicts = null;
let cachedThumbnails = {};
let lastScanTime = 0;
let thumbsGenerating = false;

// ── Resource Monitor ──────────────────────────────────────────────────────────
// Samples Windows process CPU + memory every 5s via wmic
let resourceCache = {}; // pid → { memMB, cpuPct, kernelTime, userTime, ts }

function sampleResources() {
  try {
    const out = execSync(
      'wmic process get ProcessId,WorkingSetSize,KernelModeTime,UserModeTime /format:csv 2>nul',
      { encoding: 'utf8', timeout: 6000 }
    );
    const now = Date.now();
    for (const line of out.split('\n')) {
      const cols = line.trim().split(',');
      if (cols.length < 5) continue;
      // CSV columns: Node, KernelModeTime, ProcessId, UserModeTime, WorkingSetSize
      const kernel = parseInt(cols[1]);
      const pid    = parseInt(cols[2]);
      const user   = parseInt(cols[3]);
      const wss    = parseInt(cols[4]);
      if (!pid || isNaN(pid)) continue;

      const prev = resourceCache[pid];
      let cpuPct = prev ? prev.cpuPct : 0;
      if (prev && prev.ts) {
        const dtMs   = now - prev.ts;
        const dtCpu  = (kernel - prev.kernelTime) + (user - prev.userTime); // 100-ns units
        cpuPct = dtMs > 0 ? Math.min(100, Math.round((dtCpu / 10000 / dtMs) * 100)) : 0;
      }
      resourceCache[pid] = { memMB: Math.round(wss / 1024 / 1024), cpuPct, kernelTime: kernel, userTime: user, ts: now };
    }
  } catch {} // wmic absent or timed out — silently skip
}
// Initial + recurring sample
sampleResources();
const resourceTimer = setInterval(sampleResources, 5000);

async function runScan(generateThumbs = false) {
  console.log('Scanning for projects...');
  const start = Date.now();
  const projects = await scan();
  const { projects: enriched, conflicts } = enrichProjects(projects);
  enrichDescriptions(enriched);
  cachedProjects = enriched;
  cachedConflicts = conflicts;
  lastScanTime = Date.now();
  console.log(`Found ${enriched.length} projects in ${Date.now() - start}ms`);

  // Generate thumbnails in background after scan
  if (generateThumbs && !thumbsGenerating) {
    thumbsGenerating = true;
    captureAllThumbnails(enriched).then(thumbs => {
      cachedThumbnails = thumbs;
      // Attach thumbnail URLs to projects
      for (const p of cachedProjects) {
        p.thumbnailUrl = cachedThumbnails[p.id] || null;
      }
      thumbsGenerating = false;
      console.log('All thumbnails ready');
    }).catch(err => {
      console.error('Thumbnail generation error:', err.message);
      thumbsGenerating = false;
    });
  }

  return { projects: enriched, conflicts };
}

// GET /api/projects - Return all scanned projects
app.get('/api/projects', async (req, res) => {
  try {
    if (!cachedProjects) {
      await runScan();
    } else {
      // Refresh status without full re-scan
      const activePorts = getActivePortsPIDs();
      for (const p of cachedProjects) {
        let running = false;
        for (const port of p.ports) {
          if (activePorts[port]) {
            p.status = 'running';
            p.pid = activePorts[port];
            p.activePort = port;
            running = true;
            break;
          }
        }
        if (!running) {
          p.status = 'stopped';
          p.pid = null;
          p.activePort = null;
        }
      }
      cachedConflicts = detectConflicts(cachedProjects);
    }
    res.json({
      projects: cachedProjects,
      conflicts: cachedConflicts,
      lastScanTime,
      totalProjects: cachedProjects.length,
      runningCount: cachedProjects.filter(p => p.status === 'running').length,
      conflictCount: Object.keys(cachedConflicts).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scan - Force re-scan
app.post('/api/scan', async (req, res) => {
  try {
    const result = await runScan();
    res.json({
      projects: result.projects,
      conflicts: result.conflicts,
      lastScanTime,
      totalProjects: result.projects.length,
      runningCount: result.projects.filter(p => p.status === 'running').length,
      conflictCount: Object.keys(result.conflicts).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ports - Lightweight port status check
app.get('/api/ports', (req, res) => {
  const activePorts = getActivePortsPIDs();
  if (cachedProjects) {
    for (const p of cachedProjects) {
      let running = false;
      for (const port of p.ports) {
        if (activePorts[port]) {
          p.status = 'running';
          p.pid = activePorts[port];
          p.activePort = port;
          running = true;
          break;
        }
      }
      if (!running) {
        p.status = 'stopped';
        p.pid = null;
        p.activePort = null;
      }
    }
    cachedConflicts = detectConflicts(cachedProjects);
  }
  res.json({
    activePorts,
    conflicts: cachedConflicts || {},
    projects: (cachedProjects || []).map(p => ({
      id: p.id, status: p.status, pid: p.pid, activePort: p.activePort
    })),
  });
});

// GET /api/thumbnail/:id - Capture or serve thumbnail (works for ALL projects now)
app.get('/api/thumbnail/:id', async (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const url = await captureThumbnail(project);
  if (url) {
    const thumbPath = path.join(__dirname, 'public', url);
    if (fs.existsSync(thumbPath)) {
      res.sendFile(thumbPath);
      return;
    }
  }
  res.status(500).json({ error: 'Failed to capture thumbnail' });
});

// POST /api/thumbnails/generate - Batch generate all thumbnails
app.post('/api/thumbnails/generate', async (req, res) => {
  if (!cachedProjects) return res.status(400).json({ error: 'No projects scanned yet' });
  if (thumbsGenerating) return res.json({ status: 'already_generating' });

  thumbsGenerating = true;
  res.json({ status: 'started', count: cachedProjects.length });

  captureAllThumbnails(cachedProjects).then(thumbs => {
    cachedThumbnails = thumbs;
    for (const p of cachedProjects) {
      p.thumbnailUrl = cachedThumbnails[p.id] || null;
    }
    thumbsGenerating = false;
    console.log('Batch thumbnail generation complete');
  }).catch(err => {
    console.error('Batch thumbnail error:', err.message);
    thumbsGenerating = false;
  });
});

// GET /api/thumbnails/status - Check thumbnail generation progress
app.get('/api/thumbnails/status', (req, res) => {
  const generated = Object.keys(cachedThumbnails).length;
  const total = (cachedProjects || []).length;
  res.json({ generating: thumbsGenerating, generated, total });
});

// GET /api/project/:id - Get single project details
app.get('/api/project/:id', (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json(project);
});

// POST /api/project/:id/start - Start a project
app.post('/api/project/:id/start', (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.startCommand) return res.status(400).json({ error: 'No start command known' });

  try {
    const child = spawn(project.startCommand, [], {
      cwd: project.path,
      detached: true,
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    });
    child.unref();
    res.json({
      success: true,
      message: `Started: ${project.startCommand}`,
      pid: child.pid,
      launchUrl: project.launchUrl || (project.ports[0] ? `http://localhost:${project.ports[0]}` : null),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project/:id/stop - Stop a project by killing PID (Dev Mode)
app.post('/api/project/:id/stop', (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.pid) return res.status(400).json({ error: 'No PID found (project not running?)' });

  try {
    execSync(`taskkill /PID ${project.pid} /T /F`, { encoding: 'utf8' });
    project.status = 'stopped';
    project.pid = null;
    project.activePort = null;
    res.json({ success: true, message: 'Process killed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project/:id/open-terminal - Open terminal at project path (Dev Mode)
app.post('/api/project/:id/open-terminal', (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const titleCmd = `title ${project.name} — ${project.startCommand || project.path}`;
    const cmdStr = `${titleCmd} && cd /d "${project.path}"${project.startCommand ? ' && echo. && echo Start command: ' + project.startCommand + ' && echo.' : ''}`;
    spawn('cmd', ['/K', cmdStr], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    }).unref();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project/:id/delete - Delete project folder (Dev Mode, DANGEROUS)
app.post('/api/project/:id/delete', async (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.body.confirmed) {
    return res.status(400).json({ error: 'Confirmation required', requiresConfirmation: true });
  }

  try {
    fs.rmSync(project.path, { recursive: true, force: true });
    cachedProjects = cachedProjects.filter(p => p.id !== project.id);
    res.json({ success: true, message: `Deleted ${project.path}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/project/:id/move - Move project to new location (Dev Mode)
app.post('/api/project/:id/move', (req, res) => {
  const project = (cachedProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { destination } = req.body;
  if (!destination) return res.status(400).json({ error: 'Destination path required' });

  try {
    fs.renameSync(project.path, destination);
    project.path = destination;
    res.json({ success: true, message: `Moved to ${destination}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resources - CPU + memory for all running projects
app.get('/api/resources', (req, res) => {
  const result = {};
  for (const p of (cachedProjects || [])) {
    if (p.pid && resourceCache[p.pid]) {
      result[p.id] = resourceCache[p.pid];
    }
  }
  res.json(result);
});

// POST /api/conflicts/resolve - auto-patch all conflicting ports
app.post('/api/conflicts/resolve', async (req, res) => {
  if (!cachedProjects) return res.status(400).json({ error: 'No projects scanned yet — run /api/scan first' });
  try {
    const changes = resolveAllConflicts(cachedProjects);
    // Rebuild conflict map after patching
    cachedConflicts = require('./port-checker').detectConflicts(cachedProjects);
    res.json({ changes, remaining: Object.keys(cachedConflicts).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/start-all - start every stopped project that has a start command
app.post('/api/projects/start-all', (req, res) => {
  if (!cachedProjects) return res.status(400).json({ error: 'No projects scanned' });
  const started = [];
  const skipped = [];
  for (const project of cachedProjects) {
    if (project.status === 'running' || !project.startCommand || project.electronApp) {
      skipped.push(project.name);
      continue;
    }
    try {
      const child = spawn(project.startCommand, [], {
        cwd: project.path, detached: true, stdio: 'ignore', shell: true, windowsHide: true,
      });
      child.unref();
      started.push({ name: project.name, pid: child.pid });
    } catch (err) {
      skipped.push(project.name + ' (err: ' + err.message + ')');
    }
  }
  res.json({ started, skipped });
});

// GET /api/status - Health check
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), port: PORT, version: APP_VERSION });
});

// GET /api/migration - System migration notes (useful as context for AI sessions)
app.get('/api/migration', (req, res) => {
  const migrationPath = path.join(__dirname, 'MIGRATION.md');
  if (fs.existsSync(migrationPath)) {
    res.type('text/plain').send(fs.readFileSync(migrationPath, 'utf8'));
  } else {
    res.json({ note: 'No migration log found' });
  }
});

// Export for embedded mode (tray.js) or run standalone
let server = null;

function startServer() {
  return new Promise((resolve) => {
    server = app.listen(PORT, BIND_HOST, async () => {
      console.log(`\n  Laurence Localhost v2 — Turner Foundry running at http://localhost:${PORT}\n`);
      await runScan(true);
      resolve(server);
    });
  });
}

function stopServer() {
  clearInterval(resourceTimer);
  return new Promise((resolve) => {
    closeBrowser().then(() => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });
}

// If run directly (node server.js), start immediately
if (require.main === module) {
  startServer();
  process.on('SIGINT', async () => {
    await stopServer();
    process.exit(0);
  });
}

module.exports = { startServer, stopServer, runScan, PORT };
