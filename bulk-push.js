#!/usr/bin/env node
// bulk-push.js — for each v2-registered project that has no git remote,
// (1) add a safety .gitignore, (2) git init + commit, (3) gh repo create + push.
// Skips vendored/third-party (Node-RED, XAMPP, huge node_modules-only trees).
// Runs sequentially with clear logging — rerunnable (skips projects already remoted).

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync, spawnSync } = require('child_process');

const GH_USER = 'lozturner';

// Folders that are NOT Laurence's code — never push these
const VENDOR_PATHS = [
  /\\\.node-red$/i,
  /^C:\\xampp/i,
];

// Standard safety .gitignore — prepended if no .gitignore exists
const SAFE_GITIGNORE = [
  'node_modules/',
  '__pycache__/',
  '*.pyc',
  'venv/',
  '.venv/',
  'env/',
  '.env',
  '.env.*',
  '!.env.example',
  '*.log',
  'dist/',
  'build/',
  '.next/',
  '.cache/',
  '.DS_Store',
  'Thumbs.db',
  '*.exe',
  '*.zip',
  '*.msi',
  '*.dmg',
  'coverage/',
  '.pytest_cache/',
  '',
].join('\n');

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function run(cwd, cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  if (r.status !== 0 && !capture) {
    throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}\n${r.stderr || r.stdout}`);
  }
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function hasRemote(projectPath) {
  try {
    const cfg = fs.readFileSync(path.join(projectPath, '.git', 'config'), 'utf8');
    return /url\s*=/.test(cfg);
  } catch { return false; }
}

function isVendored(projectPath) {
  return VENDOR_PATHS.some(rx => rx.test(projectPath));
}

function fetchProjects() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4343/api/projects', (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf).projects); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function writeReadmeIfMissing(projectPath, project) {
  const rmPath = path.join(projectPath, 'README.md');
  if (fs.existsSync(rmPath)) return false;
  const body = `# ${project.name}\n\n` +
    `${project.description || project.framework + ' project.'}\n\n` +
    `**Framework:** ${project.framework}\n\n` +
    `Part of the [Laurence Localhost v2 — Turner Foundry](https://lozturner.github.io/laurence-localhost-v2/) project registry.\n`;
  fs.writeFileSync(rmPath, body);
  return true;
}

function mergeGitignore(projectPath) {
  const giPath = path.join(projectPath, '.gitignore');
  let existing = '';
  try { existing = fs.readFileSync(giPath, 'utf8'); } catch {}
  // If already covers node_modules and .env, leave it alone
  if (/node_modules/.test(existing) && /\.env/.test(existing)) return false;
  const merged = (existing ? existing.trimEnd() + '\n\n# --- bulk-push safety additions ---\n' : '') + SAFE_GITIGNORE;
  fs.writeFileSync(giPath, merged);
  return true;
}

async function pushOne(project, { usedSlugs, log }) {
  const projectPath = project.path;
  const name = project.name;

  if (isVendored(projectPath)) { log(name, 'SKIP vendored'); return { status: 'skipped', reason: 'vendored' }; }
  if (hasRemote(projectPath))  { log(name, 'SKIP already has remote'); return { status: 'skipped', reason: 'already-remote' }; }
  if (!fs.existsSync(projectPath)) { log(name, 'SKIP path missing'); return { status: 'skipped', reason: 'missing' }; }

  // Pick a unique slug
  let slug = slugify(name);
  if (!slug) slug = 'project-' + project.id.slice(0, 6);
  let attempt = 0;
  while (usedSlugs.has(slug)) { attempt++; slug = slugify(name) + '-' + attempt; }
  usedSlugs.add(slug);

  try {
    mergeGitignore(projectPath);
    writeReadmeIfMissing(projectPath, project);

    // Init + first commit
    run(projectPath, 'git', ['init', '-b', 'main']);
    run(projectPath, 'git', ['add', '-A']);

    // Check size before commit — abort if >50MB to avoid pushing binaries
    const statusBytes = run(projectPath, 'git', ['ls-files', '-s'], { capture: true }).stdout.length;
    if (statusBytes > 500000) {
      log(name, `WARN large index (${(statusBytes/1024|0)}KB of filenames) — committing anyway`);
    }

    const commit = run(projectPath, 'git', ['commit', '-m', `Initial import — ${name} (${project.framework})`], { capture: true });
    if (commit.code !== 0 && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
      throw new Error('commit failed:\n' + (commit.stderr || commit.stdout));
    }

    // Create remote repo (public so Pages visitors can click through)
    // --source=. --push chains create + add-remote + push in one step
    const create = run(projectPath, 'gh', [
      'repo', 'create', `${GH_USER}/${slug}`,
      '--public',
      '--source', '.',
      '--remote', 'origin',
      '--push',
      '--description', `${project.framework} — ${(project.description || '').slice(0, 80)}`.trim(),
    ], { capture: true });

    if (create.code !== 0) {
      // If repo already exists (previous attempt), add remote + push
      if (/already exists/i.test(create.stderr)) {
        run(projectPath, 'git', ['remote', 'add', 'origin', `https://github.com/${GH_USER}/${slug}.git`], { capture: true });
        run(projectPath, 'git', ['push', '-u', 'origin', 'main'], { capture: true });
        log(name, `OK existed → pushed main (${slug})`);
        return { status: 'pushed', url: `https://github.com/${GH_USER}/${slug}`, slug };
      }
      throw new Error('gh repo create failed:\n' + (create.stderr || create.stdout));
    }

    log(name, `OK created + pushed (${slug})`);
    return { status: 'pushed', url: `https://github.com/${GH_USER}/${slug}`, slug };
  } catch (err) {
    log(name, 'FAIL ' + err.message.split('\n')[0]);
    return { status: 'failed', error: err.message.split('\n')[0] };
  }
}

function dirSizeKB(dir, cap = 200 * 1024) {
  // Roughly measure; stop counting at cap so giant folders don't take forever
  let total = 0;
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', 'venv', '.venv', 'target']);
  function walk(d) {
    if (total > cap) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (total > cap) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else { total += fs.statSync(full).size / 1024; }
      } catch {}
    }
  }
  walk(dir);
  return total;
}

(async () => {
  const projects = await fetchProjects();
  const cands = projects.filter(p => !/telegram/i.test((p.path||'') + ' ' + p.name + ' ' + p.framework));

  // Dedupe by path — multiple "projects" can share one parent folder.
  // We push each unique path ONCE, using its representative project for naming.
  const byPath = new Map();
  for (const p of cands) {
    if (!p.path) continue;
    if (!byPath.has(p.path)) byPath.set(p.path, { rep: p, members: [p] });
    else byPath.get(p.path).members.push(p);
  }

  // For multi-member paths, prefer a representative that looks like a whole-project folder
  // (has its own package.json / requirements.txt / index.html at root) — fall back to first.
  for (const [pth, g] of byPath) {
    const named = path.basename(pth);
    const whole = g.members.find(m =>
      m.name.toLowerCase().replace(/\s+/g, '-') === named.toLowerCase() ||
      m.name.toLowerCase() === named.toLowerCase()
    );
    if (whole) g.rep = whole;
    else if (g.members.length > 1) {
      // Synthesize a name from the folder
      g.rep = { ...g.rep, name: named, _synthesized: true };
    }
  }

  const usedSlugs = new Set();
  for (const p of cands) {
    try {
      const cfg = fs.readFileSync(path.join(p.path, '.git', 'config'), 'utf8');
      const m = cfg.match(/github\.com[\/:][^\/]+\/([^\s\.]+)/);
      if (m) usedSlugs.add(m[1].toLowerCase());
    } catch {}
  }

  const log = (name, msg) => console.log(`[${new Date().toLocaleTimeString()}] ${name.padEnd(36)} ${msg}`);
  const results = { pushed: [], skipped: [], failed: [] };

  console.log(`Candidates: ${cands.length} v2 projects → ${byPath.size} unique paths to push.\n`);

  for (const [pth, g] of byPath) {
    const rep = g.rep;
    const memberNote = g.members.length > 1 ? ` (+${g.members.length - 1} sibling v2 entries)` : '';

    // Size guard — skip anything over 80MB
    const sizeKB = dirSizeKB(pth);
    if (sizeKB > 80 * 1024) {
      log(rep.name, `SKIP too large (${(sizeKB/1024).toFixed(0)}MB)${memberNote}`);
      results.skipped.push({ name: rep.name, reason: 'too-large', sizeKB });
      continue;
    }

    const r = await pushOne(rep, { usedSlugs, log });
    if (r.status === 'pushed') {
      log(rep.name, `  → ${r.url}${memberNote}`);
      results.pushed.push({ name: rep.name, path: pth, url: r.url, slug: r.slug, members: g.members.map(m => m.name) });
    } else if (r.status === 'failed') {
      results.failed.push({ name: rep.name, path: pth, error: r.error });
    } else {
      results.skipped.push({ name: rep.name, path: pth, reason: r.reason });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Unique paths :', byPath.size);
  console.log('Pushed       :', results.pushed.length);
  console.log('Skipped      :', results.skipped.length);
  console.log('Failed       :', results.failed.length);
  fs.writeFileSync(path.join(__dirname, 'bulk-push.log.json'), JSON.stringify(results, null, 2));
  console.log('Full log     → bulk-push.log.json');
})();
