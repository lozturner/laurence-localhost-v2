/**
 * resolver.js — Auto-resolves port conflicts by patching project config files.
 * Strategy priority: launch.json → .env → vite.config → entry file → package.json scripts
 */
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Rewrite a port number in a project's config files.
// Returns the filename that was patched, or null if nothing could be written.
function writePortToProject(project, oldPort, newPort) {
  const p = project.path;

  // ── 1. Per-project .claude/launch.json ─────────────────────────────
  const launchPath = path.join(p, '.claude', 'launch.json');
  try {
    if (fs.existsSync(launchPath)) {
      const data = readJson(launchPath);
      let changed = false;
      for (const cfg of data.configurations || []) {
        if (cfg.port === oldPort) {
          cfg.port = newPort;
          // patch port number inside runtimeArgs too
          cfg.runtimeArgs = (cfg.runtimeArgs || []).map(a =>
            a === String(oldPort) ? String(newPort) : a
          );
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(launchPath, JSON.stringify(data, null, 2));
        return '.claude/launch.json';
      }
    }
  } catch {}

  // ── 2. .env / .env.local ────────────────────────────────────────────
  for (const ef of ['.env', '.env.local', '.env.development']) {
    const envPath = path.join(p, ef);
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const re = new RegExp(`^(PORT\\s*=\\s*)${oldPort}\\s*$`, 'm');
        if (re.test(content)) {
          fs.writeFileSync(envPath, content.replace(re, `$1${newPort}`));
          return ef;
        }
      }
    } catch {}
  }

  // ── 3. vite.config.{js,ts,mjs} ─────────────────────────────────────
  for (const vc of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    const vcPath = path.join(p, vc);
    try {
      if (fs.existsSync(vcPath)) {
        let content = fs.readFileSync(vcPath, 'utf8');
        if (/port\s*:\s*\d+/.test(content)) {
          // Replace existing port
          content = content.replace(/port\s*:\s*\d+/, `port: ${newPort}`);
          fs.writeFileSync(vcPath, content);
          return vc;
        }
        // Inject server block if it's a bare defineConfig
        if (/defineConfig\s*\(/.test(content)) {
          content = content.replace(
            /(defineConfig\s*\(\s*\{)/,
            `$1\n  server: { port: ${newPort}, strictPort: true },`
          );
          fs.writeFileSync(vcPath, content);
          return vc;
        }
      }
    } catch {}
  }

  // ── 4. Entry file (server.js / app.js etc.) ─────────────────────────
  if (project.entryFile) {
    const entryPath = path.join(p, project.entryFile);
    try {
      if (fs.existsSync(entryPath)) {
        let content = fs.readFileSync(entryPath, 'utf8');
        const patterns = [
          new RegExp(`((?:const|let|var)\\s+PORT\\s*=\\s*)${oldPort}\\b`),
          new RegExp(`(PORT\\s*=\\s*)${oldPort}\\b`),
          new RegExp(`(\\.listen\\s*\\(\\s*)${oldPort}\\b`),
          new RegExp(`(port\\s*=\\s*)${oldPort}\\b`),
        ];
        for (const pat of patterns) {
          if (pat.test(content)) {
            content = content.replace(pat, `$1${newPort}`);
            fs.writeFileSync(entryPath, content);
            return project.entryFile;
          }
        }
      }
    } catch {}
  }

  // ── 5. package.json scripts (framework default fallback) ────────────
  const pkgPath = path.join(p, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      const scripts = pkg.scripts || {};
      let changed = false;

      if (project.framework.includes('Next.js')) {
        // next dev → next dev -p NEW
        const s = scripts.dev || scripts.start || '';
        if (s.includes('next dev') && !s.includes('-p ')) {
          const key = scripts.dev ? 'dev' : 'start';
          pkg.scripts[key] = s.replace('next dev', `next dev -p ${newPort}`);
          changed = true;
        }
      } else if (project.framework.includes('Vite')) {
        if (scripts.dev && !scripts.dev.includes('--port')) {
          pkg.scripts.dev = `${scripts.dev} --port ${newPort} --strictPort`;
          changed = true;
        }
      } else if (project.framework.includes('Create React App')) {
        const s = scripts.start || '';
        if (s.includes('react-scripts start') && !s.includes('PORT=')) {
          pkg.scripts.start = `PORT=${newPort} ${s}`;
          changed = true;
        }
      } else if (project.framework.includes('Express') || project.framework.includes('Node')) {
        if (scripts.start && !scripts.start.includes('PORT=')) {
          pkg.scripts.start = `PORT=${newPort} ${scripts.start}`;
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
        return 'package.json';
      }
    }
  } catch {}

  return null; // Nothing we could patch
}

// Find next available port not already in use by any project
function nextFreePort(startFrom, usedPorts) {
  let p = startFrom;
  while (usedPorts.has(p)) p++;
  return p;
}

/**
 * Resolve all port conflicts across the project list.
 * Mutates project.ports / project.portSources in-place.
 * Returns array of { project, oldPort, newPort, file } change records.
 */
function resolveAllConflicts(projects) {
  const changes = [];

  // Build port → [projects] map
  const portMap = {};
  for (const proj of projects) {
    for (const port of proj.ports) {
      if (!portMap[port]) portMap[port] = [];
      portMap[port].push(proj);
    }
  }

  // Collect all ports currently in use (to avoid collisions when reassigning)
  const usedPorts = new Set(projects.flatMap(p => p.ports));

  // Process each conflicting port
  for (const [portStr, conflictingProjs] of Object.entries(portMap)) {
    if (conflictingProjs.length <= 1) continue;
    const port = parseInt(portStr);

    // Determine winner — prefer project with explicit launch.json config over default
    const priority = proj => {
      const src = proj.portSources[port] || '';
      if (src.includes('launch.json')) return 0;
      if (src.includes('.env')) return 1;
      if (src.includes('vite.config')) return 2;
      if (src.includes('.js') || src.includes('.py')) return 3;
      return 4; // framework default — lowest priority, gets reassigned
    };

    const sorted = [...conflictingProjs].sort((a, b) => priority(a) - priority(b));
    const winner = sorted[0]; // keeps the port
    const losers = sorted.slice(1);

    for (const loser of losers) {
      const newPort = nextFreePort(port + 1, usedPorts);
      usedPorts.add(newPort);

      const file = writePortToProject(loser, port, newPort);

      // Patch in-memory state regardless of whether file write succeeded
      loser.ports = loser.ports.map(p => p === port ? newPort : p);
      loser.portSources[newPort] = loser.portSources[port] || 'resolved';
      delete loser.portSources[port];

      changes.push({
        project: loser.name,
        projectId: loser.id,
        keptBy: winner.name,
        oldPort: port,
        newPort,
        file: file || '(config not writable)',
        written: !!file,
      });
    }
  }

  return changes;
}

module.exports = { resolveAllConflicts, writePortToProject };
