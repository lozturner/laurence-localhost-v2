const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FRAMEWORK_DEFAULT_PORTS = {
  'Next.js': 3000,
  'Create React App': 3000,
  'Vite': 5173,
  'Express': 3000,
  'Django': 8000,
  'Flask': 5000,
  'FastAPI': 8000,
  'Node-RED': 1880,
};

// Read a .claude/launch.json inside a project dir and return port configs
function readLaunchJson(projectPath) {
  const launchPath = path.join(projectPath, '.claude', 'launch.json');
  try {
    if (fs.existsSync(launchPath)) {
      const data = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
      return data.configurations || [];
    }
  } catch {}
  return [];
}

function extractPortsFromProject(project) {
  const ports = [...(project.ports || [])];
  const portSources = { ...project.portSources };

  // ── Sub-config projects: port already set by scanner, skip re-reading ──
  if (project.isSubConfig) {
    return { ports, portSources };
  }

  // ── Priority 1: Per-project .claude/launch.json ────────────────────
  const launchConfigs = readLaunchJson(project.path);
  // For single-config projects, use that config's port
  // For multi-config (global launcher), only use a config that matches project name or path
  const matchingConfigs = launchConfigs.length === 1
    ? launchConfigs
    : launchConfigs.filter(cfg => {
        const nm = (cfg.name || '').toLowerCase();
        const pnm = project.name.toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
        return nm.replace(/\s+/g, '').replace(/-/g, '') === pnm ||
          (cfg.runtimeArgs || []).some(a => a.includes(path.basename(project.path)));
      });

  if (matchingConfigs.length > 0) {
    for (const cfg of matchingConfigs) {
      if (cfg.port && !ports.includes(cfg.port)) {
        ports.push(cfg.port);
        portSources[cfg.port] = `.claude/launch.json (${cfg.name || 'config'})`;
      }
    }
    if (ports.length > 0) {
      return { ports, portSources };
    }
  }

  // ── Priority 2: package.json scripts ───────────────────────────────
  if (project.packageJson && project.packageJson.scripts) {
    for (const [scriptName, cmd] of Object.entries(project.packageJson.scripts)) {
      const portMatch = cmd.match(/(?:--port|-p)\s+(\d+)/);
      if (portMatch) {
        const p = parseInt(portMatch[1]);
        if (!ports.includes(p)) {
          ports.push(p);
          portSources[p] = `${scriptName} script`;
        }
      }
      // PORT=XXXX prefix pattern
      const envPortMatch = cmd.match(/\bPORT=(\d+)/);
      if (envPortMatch) {
        const p = parseInt(envPortMatch[1]);
        if (!ports.includes(p)) {
          ports.push(p);
          portSources[p] = `${scriptName} PORT env`;
        }
      }
    }
  }

  // ── Priority 3: .env files ─────────────────────────────────────────
  const envFiles = ['.env', '.env.local', '.env.development'];
  for (const envFile of envFiles) {
    const envPath = path.join(project.path, envFile);
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const portMatch = content.match(/^PORT\s*=\s*(\d+)/m);
        if (portMatch) {
          const p = parseInt(portMatch[1]);
          if (!ports.includes(p)) {
            ports.push(p);
            portSources[p] = envFile;
          }
        }
      }
    } catch {}
  }

  // ── Priority 4: vite.config ────────────────────────────────────────
  if (project.framework.includes('Vite')) {
    const viteConfigs = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'];
    for (const vc of viteConfigs) {
      const vcPath = path.join(project.path, vc);
      try {
        if (fs.existsSync(vcPath)) {
          const content = fs.readFileSync(vcPath, 'utf8');
          const portMatch = content.match(/port\s*:\s*(\d+)/);
          if (portMatch) {
            const p = parseInt(portMatch[1]);
            if (!ports.includes(p)) {
              ports.push(p);
              portSources[p] = vc;
            }
          }
        }
      } catch {}
    }
  }

  // ── Priority 5: Main entry file for listen() ──────────────────────
  if (project.entryFile) {
    try {
      const entryPath = path.join(project.path, project.entryFile);
      if (fs.existsSync(entryPath)) {
        const content = fs.readFileSync(entryPath, 'utf8');
        // const PORT = XXXX or PORT = XXXX or app.listen(XXXX)
        const patterns = [
          /const\s+PORT\s*=\s*(\d+)/,
          /let\s+PORT\s*=\s*(\d+)/,
          /var\s+PORT\s*=\s*(\d+)/,
          /PORT\s*=\s*(\d+)/,
          /\.listen\s*\(\s*(\d+)/,
          /app\.run\s*\([^)]*port\s*=\s*(\d+)/,
        ];
        for (const pat of patterns) {
          const m = content.match(pat);
          if (m) {
            const p = parseInt(m[1]);
            if (p > 1000 && p < 65535 && !ports.includes(p)) {
              ports.push(p);
              portSources[p] = project.entryFile;
              break;
            }
          }
        }
      }
    } catch {}
  }

  // ── Priority 6: Python files ───────────────────────────────────────
  if (project.pythonProject) {
    try {
      const pyFiles = fs.readdirSync(project.path).filter(f => f.endsWith('.py') || f.endsWith('.pyw'));
      for (const pyFile of pyFiles.slice(0, 5)) {
        const content = fs.readFileSync(path.join(project.path, pyFile), 'utf8');
        const portMatch = content.match(/port\s*=\s*(\d+)/i);
        if (portMatch) {
          const p = parseInt(portMatch[1]);
          if (p > 1000 && p < 65535 && !ports.includes(p)) {
            ports.push(p);
            portSources[p] = pyFile;
          }
        }
      }
    } catch {}
  }

  // ── Fallback: framework defaults (only if no port found yet) ───────
  if (ports.length === 0 && !project.electronApp) {
    for (const [fw, defaultPort] of Object.entries(FRAMEWORK_DEFAULT_PORTS)) {
      if (project.framework.includes(fw)) {
        ports.push(defaultPort);
        portSources[defaultPort] = `${fw} default`;
        break;
      }
    }
  }

  return { ports, portSources };
}

let cachedActivePorts = null;
let cacheTime = 0;

function getActivePortsPIDs() {
  const now = Date.now();
  if (cachedActivePorts && (now - cacheTime) < 5000) {
    return cachedActivePorts;
  }

  const listening = {};
  try {
    const output = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 });
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (match) {
        const port = parseInt(match[1]);
        const pid = parseInt(match[2]);
        listening[port] = pid;
      }
    }
  } catch (err) {
    console.error('netstat failed:', err.message);
  }

  cachedActivePorts = listening;
  cacheTime = now;
  return listening;
}

function checkProjectStatus(project) {
  const activePorts = getActivePortsPIDs();
  for (const port of project.ports) {
    if (activePorts[port]) {
      return { status: 'running', pid: activePorts[port], activePort: port };
    }
  }
  return { status: 'stopped', pid: null, activePort: null };
}

function detectConflicts(projects) {
  const portMap = {};
  for (const project of projects) {
    for (const port of project.ports) {
      if (!portMap[port]) portMap[port] = [];
      portMap[port].push(project.name);
    }
  }

  const conflicts = {};
  for (const [port, names] of Object.entries(portMap)) {
    if (names.length > 1) {
      conflicts[port] = names;
    }
  }

  return conflicts;
}

function enrichProjects(projects) {
  for (const project of projects) {
    const { ports, portSources } = extractPortsFromProject(project);
    project.ports = ports;
    project.portSources = portSources;

    const statusInfo = checkProjectStatus(project);
    project.status = statusInfo.status;
    project.pid = statusInfo.pid;
    project.activePort = statusInfo.activePort;
  }

  const conflicts = detectConflicts(projects);
  return { projects, conflicts };
}

module.exports = { enrichProjects, getActivePortsPIDs, detectConflicts };
