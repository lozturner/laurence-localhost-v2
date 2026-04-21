// bake-pages.js — generate a full visual mirror of v2's dashboard for GitHub Pages.
// Matches the local layout: task manager header, thumbnails, framework badges,
// port badges, status dots, card bodies. No live controls — buttons are cosmetic.
//
// Ledger M4: telegram exports filtered before render.
// Strips: path, pid, activePort, launchUrl, portSources. Keeps: name, framework,
// ports, description, status→'mirror', electronApp, dockerCompose, thumbnail.

const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT     = path.join(__dirname, 'pages-bake');
const THUMBS_IN  = path.join(__dirname, 'public', 'thumbnails');
const THUMBS_OUT = path.join(OUT, 'thumbnails');

http.get('http://127.0.0.1:4343/api/projects', (res) => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    const { projects } = JSON.parse(buf);

    const safe = projects
      .filter(p => !/telegram/i.test((p.path || '') + ' ' + (p.name || '') + ' ' + (p.framework || '')))
      .map(p => ({
        id: p.id,
        name: p.name || '',
        framework: p.framework || 'Unknown',
        ports: Array.isArray(p.ports) ? p.ports.slice(0, 4) : [],
        description: cleanDesc(p.description),
        electronApp: !!p.electronApp,
        dockerCompose: !!p.dockerCompose,
        pythonProject: !!p.pythonProject,
        hasReadme: !!p.hasReadme,
        hasThumb: fs.existsSync(path.join(THUMBS_IN, `${p.id}.png`)),
        // Probe .git/config for a remote URL so Pages buttons can link out
        githubUrl: readGithubRemote(p.path),
      }));

    // Prep output dir — wipe pages-bake clean each run for deterministic diffs
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(THUMBS_OUT, { recursive: true });

    // Copy thumbnails for surviving (non-telegram) projects only
    let copied = 0;
    for (const p of safe) {
      if (!p.hasThumb) continue;
      try {
        fs.copyFileSync(
          path.join(THUMBS_IN, `${p.id}.png`),
          path.join(THUMBS_OUT, `${p.id}.png`),
        );
        copied++;
      } catch (err) {
        console.warn(`thumb copy failed for ${p.name}: ${err.message}`);
      }
    }

    fs.writeFileSync(path.join(OUT, 'index.html'), render(safe));
    fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
    console.log(`Baked ${safe.length} cards + ${copied} thumbnails → ${OUT}`);
  });
}).on('error', e => {
  console.error('bake failed — is v2 running on :4343?', e.message);
  process.exit(1);
});

// Read a project folder's .git/config → normalised https GitHub URL, or null
function readGithubRemote(projectPath) {
  if (!projectPath) return null;
  try {
    const cfg = fs.readFileSync(path.join(projectPath, '.git', 'config'), 'utf8');
    const m = cfg.match(/url\s*=\s*(\S+)/);
    if (!m) return null;
    let url = m[1].trim();
    // git@github.com:user/repo.git → https://github.com/user/repo
    url = url.replace(/^git@github\.com:/, 'https://github.com/');
    url = url.replace(/\.git$/, '');
    if (!/^https?:\/\//.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

// Clean up auto-generated descriptions so they don't read like debug output
function cleanDesc(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, ' ');
  // Strip HTML tags that leaked from markdown (<p align="center"> etc.)
  s = s.replace(/<[^>]+>/g, ' ');
  // Strip port breadcrumbs ("— :3001", "on port 5000", "localhost:4242")
  s = s
    .replace(/\s*[—–-]?\s*:\d{2,5}\b/g, '')
    .replace(/\bport\s+\d{2,5}\b/gi, '')
    .replace(/\blocalhost:\d{2,5}\b/gi, '')
    .replace(/\b127\.0\.0\.1:\d{2,5}\b/g, '');
  // Strip basic markdown the UI would have stripped client-side
  s = s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/#+\s+/g, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+[—–-]\s*$/, '').trim();
  return s;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Match the local dashboard's framework→badge-class mapping
const BADGE_CLASS = {
  'Next.js': 'badge-nextjs',
  'Vite': 'badge-vite',
  'React': 'badge-react',
  'Create React App': 'badge-react',
  'Express': 'badge-express',
  'Electron': 'badge-electron',
  'Python': 'badge-python',
  'Django': 'badge-django',
  'Flask': 'badge-flask',
  'Docker': 'badge-docker',
  'Static HTML': 'badge-static',
  'Node-RED': 'badge-nodered',
  'XAMPP': 'badge-xampp',
};

const FRAMEWORK_ICON = {
  'Next.js': 'N', 'Vite': 'V', 'React': 'R', 'Create React App': 'R',
  'Express': 'Ex', 'Electron': 'E', 'Python': 'Py', 'Django': 'Dj',
  'Flask': 'Fl', 'Docker': 'D', 'Static HTML': 'H', 'Node-RED': 'NR',
  'XAMPP': 'X', 'Three.js': '3D', 'Tailwind': 'Tw',
};

function badgeClass(fw) {
  for (const [k, cls] of Object.entries(BADGE_CLASS)) {
    if (fw.includes(k)) return cls;
  }
  return 'badge-framework';
}

function frameworkIcon(fw) {
  for (const [k, icon] of Object.entries(FRAMEWORK_ICON)) {
    if (fw.includes(k)) return icon;
  }
  return '?';
}

function renderCard(p) {
  const portBadges = p.ports
    .map(port => `<span class="badge badge-port">:${port}</span>`)
    .join('');

  const thumbSrc = p.hasThumb
    ? `thumbnails/${p.id}.png`
    : '';

  const extraBadges = [];
  if (p.electronApp)   extraBadges.push('<span class="badge badge-electron">Desktop</span>');
  if (p.dockerCompose) extraBadges.push('<span class="badge badge-docker">Docker</span>');
  if (p.hasReadme)     extraBadges.push('<span class="badge badge-readme">README</span>');

  return `
    <article class="card" data-name="${esc(p.name.toLowerCase())}" data-framework="${esc(p.framework)}">
      <div class="card-thumb">
        ${thumbSrc
          ? `<img src="${thumbSrc}" alt="${esc(p.name)}" loading="lazy">`
          : `<div class="placeholder">${frameworkIcon(p.framework)}</div>`}
        <div class="framework-icon" title="${esc(p.framework)}">${frameworkIcon(p.framework)}</div>
        <div class="status-dot" title="Read-only mirror"></div>
      </div>
      <div class="card-body">
        <div class="card-badges">
          <span class="badge ${badgeClass(p.framework)}">${esc(p.framework)}</span>
          ${portBadges}
          ${extraBadges.join('')}
        </div>
        <div class="card-name">${esc(p.name)}</div>
        <div class="card-desc">${esc(p.description).slice(0, 240)}</div>
      </div>
      <div class="recovery-panel">
        <div class="recovery-btns">
          ${p.githubUrl
            ? `<a class="recovery-open" href="${esc(p.githubUrl)}" target="_blank" rel="noopener" title="Open source on GitHub">🐙 View Source</a>
               <a class="recovery-start" href="${esc(p.githubUrl)}/archive/HEAD.zip" title="Download ZIP of default branch">⬇ ZIP</a>
               <button class="recovery-term" onclick="copyClone('${esc(p.githubUrl)}.git', event)" title="Copy git clone command">📋 Clone</button>`
            : `<button class="recovery-open" disabled title="Not yet uploaded to GitHub — lives locally only">⊘ Not on GitHub</button>
               <button class="recovery-term" disabled title="Mirror only">⬜ Terminal</button>`}
        </div>
      </div>
    </article>`;
}

function render(projects) {
  projects.sort((a, b) => a.name.localeCompare(b.name));

  // Count frameworks for filter + stats
  const fwSet = [...new Set(projects.flatMap(p =>
    p.framework.split(/\s*\+\s*/).map(f => f.trim()).filter(Boolean)
  ))].sort();

  const cards = projects.map(renderCard).join('\n');
  const fwOptions = fwSet.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  const withThumbs = projects.filter(p => p.hasThumb).length;
  const withGithub = projects.filter(p => p.githubUrl).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Laurence Localhost v2 — Turner Foundry (read-only mirror)</title>
<style>
  :root {
    --bg-primary: #0a0a0f; --bg-secondary: #0f0f17;
    --bg-card: #12121a; --bg-card-hover: #1a1a25;
    --accent: #6366f1; --accent-dim: #4f46e5;
    --accent-glow: rgba(99, 102, 241, 0.15);
    --danger: #ef4444; --warning: #f59e0b; --success: #22c55e;
    --success-dim: rgba(34, 197, 94, 0.15);
    --text-primary: #e2e8f0; --text-secondary: #94a3b8; --text-muted: #64748b;
    --border: #1e293b; --border-light: #334155;
    --foundry-a: #b45309; --foundry-b: #92400e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg-primary); color: var(--text-primary); min-height: 100vh;
  }

  /* Task Manager (cosmetic in mirror) */
  .task-manager {
    background: #09090e; border-bottom: 2px solid var(--accent);
    position: sticky; top: 0; z-index: 200;
    box-shadow: 0 2px 20px rgba(99,102,241,0.15);
  }
  .tm-header {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; flex-wrap: wrap;
  }
  .tm-title {
    font-size: 12px; font-weight: 700; color: var(--accent);
    letter-spacing: 1px; text-transform: uppercase; white-space: nowrap;
  }
  .tm-summary { display: flex; gap: 6px; flex-shrink: 0; }
  .tm-pill {
    padding: 2px 10px; border-radius: 20px; font-size: 11px;
    font-weight: 700; border: 1px solid; white-space: nowrap;
  }
  .tm-running  { background: var(--success-dim); border-color: rgba(34,197,94,0.3); color: var(--success); }
  .tm-stopped  { background: rgba(148,163,184,0.08); border-color: var(--border); color: var(--text-muted); }
  .tm-conflict { background: var(--success-dim); border-color: rgba(34,197,94,0.3); color: var(--success); }
  .tm-actions { display: flex; gap: 6px; margin-left: auto; }
  .tm-btn {
    padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
    border: 1px solid; white-space: nowrap; opacity: 0.45; cursor: not-allowed;
    background: rgba(148,163,184,0.08); border-color: var(--border); color: var(--text-muted);
  }

  /* Header */
  header { background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 16px 24px; }
  .header-top { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
  .header-top h1 {
    font-size: 20px; font-weight: 700; color: var(--text-primary);
    display: flex; align-items: center; gap: 8px; white-space: nowrap; flex-wrap: wrap;
  }
  .header-top h1 .accent { color: var(--accent); }
  .header-top h1 .icon { color: var(--foundry-a); font-size: 22px; }
  .foundry-badge {
    display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 10px;
    font-weight: 700; background: linear-gradient(135deg, var(--foundry-a), var(--foundry-b));
    color: #fef3c7; letter-spacing: 1px; text-transform: uppercase;
    border: 1px solid #78350f; box-shadow: 0 0 8px rgba(180,83,9,0.25);
  }
  .ro-badge {
    display: inline-block; padding: 3px 10px; border-radius: 4px; font-size: 10px;
    font-weight: 700; background: rgba(148,163,184,0.12); color: var(--text-secondary);
    letter-spacing: 1px; text-transform: uppercase; border: 1px solid var(--border);
  }

  .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%; }
  .search-input {
    flex: 1; min-width: 200px; padding: 8px 14px;
    background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text-primary); font-size: 14px; outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-input::placeholder { color: var(--text-muted); }
  select {
    padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text-primary); font-size: 14px; cursor: pointer;
  }

  /* Banner */
  .banner {
    padding: 10px 24px; background: rgba(180,83,9,0.08);
    border-bottom: 1px solid rgba(180,83,9,0.2); font-size: 13px; color: #fcd34d;
  }
  .banner strong { color: #fde68a; }
  .banner a { color: var(--accent); text-decoration: none; border-bottom: 1px dotted var(--accent); }
  .banner a:hover { color: var(--text-primary); border-color: var(--text-primary); }

  /* Stats */
  .stats-bar {
    display: flex; gap: 20px; padding: 12px 24px;
    background: var(--bg-secondary); border-bottom: 1px solid var(--border);
  }
  .stat { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
  .stat-value { font-weight: 700; color: var(--text-primary); font-size: 16px; }
  .stat-value.mirrored { color: var(--warning); }

  /* Grid */
  main {
    padding: 24px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 16px;
  }

  /* Card */
  .card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 12px; overflow: hidden; transition: all 0.2s;
    display: flex; flex-direction: column;
  }
  .card:hover {
    border-color: var(--border-light); background: var(--bg-card-hover);
    transform: translateY(-1px); box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  }

  .card-thumb {
    height: 160px; background: var(--bg-primary);
    position: relative; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .card-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .card-thumb .placeholder { font-size: 48px; opacity: 0.25; color: var(--accent); font-weight: 700; letter-spacing: -2px; }
  .card-thumb .framework-icon {
    position: absolute; top: 8px; left: 8px;
    font-size: 14px; font-weight: 700; background: rgba(0,0,0,0.7);
    padding: 3px 8px; border-radius: 6px; color: var(--text-primary);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .status-dot {
    position: absolute; top: 10px; right: 10px;
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--text-muted); border: 2px solid var(--bg-card);
    opacity: 0.5;
  }

  .card-body { padding: 14px; flex: 1; display: flex; flex-direction: column; }
  .card-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .badge {
    padding: 2px 8px; border-radius: 4px; font-size: 11px;
    font-weight: 600; border: 1px solid;
  }
  .badge-framework { background: var(--accent-glow); border-color: rgba(99,102,241,0.3); color: var(--accent); }
  .badge-nextjs    { background: rgba(0,0,0,0.3); border-color: #333; color: #fff; }
  .badge-vite      { background: rgba(189,147,249,0.15); border-color: rgba(189,147,249,0.3); color: #bd93f9; }
  .badge-react     { background: rgba(97,218,251,0.15); border-color: rgba(97,218,251,0.3); color: #61dafb; }
  .badge-express   { background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.3); color: #22c55e; }
  .badge-electron  { background: rgba(148,163,184,0.15); border-color: rgba(148,163,184,0.3); color: #94a3b8; }
  .badge-python    { background: rgba(250,204,21,0.15); border-color: rgba(250,204,21,0.3); color: #facc15; }
  .badge-django    { background: rgba(16,185,129,0.15); border-color: rgba(16,185,129,0.3); color: #10b981; }
  .badge-docker    { background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.3); color: #3b82f6; }
  .badge-static    { background: rgba(148,163,184,0.1);  border-color: rgba(148,163,184,0.2); color: #94a3b8; }
  .badge-nodered   { background: rgba(239,68,68,0.15);  border-color: rgba(239,68,68,0.3); color: #ef4444; }
  .badge-xampp     { background: rgba(251,146,60,0.15); border-color: rgba(251,146,60,0.3); color: #fb923c; }
  .badge-flask     { background: rgba(148,163,184,0.15); border-color: rgba(148,163,184,0.3); color: #cbd5e1; }
  .badge-readme    { background: rgba(250,204,21,0.08); border-color: rgba(250,204,21,0.2); color: #facc15; }
  .badge-port {
    background: rgba(148,163,184,0.1); border-color: var(--border);
    color: var(--text-secondary); font-family: 'Courier New', monospace;
  }

  .card-name { font-size: 16px; font-weight: 600; margin-bottom: 4px; color: var(--text-primary); }
  .card-desc {
    font-size: 13px; color: var(--text-secondary); line-height: 1.4; flex: 1;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .card-desc:empty::before { content: '—'; color: var(--text-muted); }

  .recovery-panel {
    padding: 10px 14px; border-top: 1px solid rgba(99,102,241,0.12);
    background: rgba(99,102,241,0.03);
  }
  .recovery-btns { display: flex; gap: 6px; flex-wrap: wrap; }
  .recovery-open, .recovery-start, .recovery-term {
    padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
    border: 1px solid; transition: all 0.2s; white-space: nowrap;
    text-decoration: none; display: inline-flex; align-items: center; justify-content: center;
    font-family: inherit; cursor: pointer;
  }
  a.recovery-open, a.recovery-start { text-decoration: none; }
  .recovery-open  { border-color: var(--accent); background: var(--accent-glow); color: var(--accent); flex: 1; text-align: center; }
  .recovery-open:hover { background: var(--accent); color: #fff; }
  .recovery-start { border-color: var(--success); background: var(--success-dim); color: var(--success); }
  .recovery-start:hover { background: var(--success); color: #000; }
  .recovery-term  { border-color: var(--border); background: transparent; color: var(--text-secondary); }
  .recovery-term:hover { background: var(--bg-card-hover); color: var(--text-primary); }
  .recovery-panel button[disabled] { opacity: 0.4; cursor: not-allowed; }
  .recovery-panel button[disabled]:hover { background: transparent; color: var(--text-secondary); }

  .toast {
    position: fixed; bottom: 24px; right: 24px; z-index: 300;
    padding: 12px 20px; border-radius: 8px; font-size: 13px;
    background: var(--bg-card); border: 1px solid rgba(34,197,94,0.3);
    color: var(--text-primary); box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    opacity: 0; transform: translateY(12px); transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
  }
  .toast.visible { opacity: 1; transform: translateY(0); }

  /* Empty state */
  .empty-state {
    grid-column: 1 / -1; text-align: center; padding: 60px;
    color: var(--text-muted); font-size: 15px;
  }
  .card.hidden { display: none; }

  footer {
    padding: 24px; color: var(--text-muted); font-size: 12px; text-align: center;
    border-top: 1px solid var(--border);
  }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>

<!-- ══ TASK MANAGER (cosmetic mirror) ══════════════════════════════ -->
<div class="task-manager">
  <div class="tm-header">
    <span class="tm-title">⬡ Task Manager</span>
    <div class="tm-summary">
      <span class="tm-pill tm-running">${projects.length} Mirrored</span>
      <span class="tm-pill tm-stopped">Read-only</span>
      <span class="tm-pill tm-conflict">✓ Clean</span>
    </div>
    <div class="tm-actions">
      <button class="tm-btn" disabled title="Mirror only">▶ Start All</button>
      <button class="tm-btn" disabled title="Mirror only">⚡ Fix Conflicts</button>
      <button class="tm-btn" disabled title="Mirror only">↺ Re-scan</button>
    </div>
  </div>
</div>

<header>
  <div class="header-top">
    <h1>
      <span class="icon">⚒</span>
      Laurence Localhost <span class="accent">v2</span>
      <span class="foundry-badge">Turner Foundry</span>
      <span class="ro-badge">Read-only mirror</span>
    </h1>
  </div>
  <div class="controls">
    <input type="text" class="search-input" id="searchInput" placeholder="Search projects by name or framework...">
    <select id="frameworkFilter">
      <option value="">All Frameworks</option>
      ${fwOptions}
    </select>
  </div>
</header>

<div class="banner">
  <strong>This is a static snapshot.</strong>
  Visual mirror of <a href="#" onclick="return false">localhost:4343</a> — the working registry runs locally.
  Source: <a href="https://github.com/lozturner/laurence-localhost-v2" target="_blank" rel="noopener">github.com/lozturner/laurence-localhost-v2</a>.
</div>

<div class="stats-bar">
  <div class="stat"><span class="stat-value">${projects.length}</span> Projects</div>
  <div class="stat"><span class="stat-value">${fwSet.length}</span> Frameworks</div>
  <div class="stat"><span class="stat-value mirrored">${withThumbs}</span> With Thumbnails</div>
  <div class="stat"><span class="stat-value" style="color:var(--success)">${withGithub}</span> On GitHub</div>
</div>

<main id="grid">
${cards}
  <div class="empty-state" id="emptyState" style="display:none">No projects match your search.</div>
</main>

<footer>
  Baked ${new Date().toISOString().split('T')[0]} · ${projects.length} projects ·
  <a href="https://github.com/lozturner/laurence-localhost-v2">source on GitHub</a>
</footer>

<div class="toast" id="toast"></div>
<script>
  // Copy-to-clipboard helper for the "Clone" button on each card
  async function copyClone(url, evt) {
    if (evt) evt.stopPropagation();
    const cmd = 'git clone ' + url;
    try { await navigator.clipboard.writeText(cmd); } catch {
      const ta = document.createElement('textarea');
      ta.value = cmd; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    const t = document.getElementById('toast');
    t.textContent = 'Copied: ' + cmd;
    t.classList.add('visible');
    clearTimeout(window._tt);
    window._tt = setTimeout(() => t.classList.remove('visible'), 2200);
  }

  // Client-side search + framework filter. No network calls — pure DOM work.
  const cards = Array.from(document.querySelectorAll('.card'));
  const search = document.getElementById('searchInput');
  const filter = document.getElementById('frameworkFilter');
  const empty  = document.getElementById('emptyState');
  function apply() {
    const q = search.value.trim().toLowerCase();
    const f = filter.value;
    let visible = 0;
    for (const c of cards) {
      const name = c.dataset.name || '';
      const fw   = c.dataset.framework || '';
      const okQ = !q || name.includes(q) || fw.toLowerCase().includes(q);
      const okF = !f || fw.includes(f);
      const show = okQ && okF;
      c.classList.toggle('hidden', !show);
      if (show) visible++;
    }
    empty.style.display = visible === 0 ? 'block' : 'none';
  }
  search.addEventListener('input', apply);
  filter.addEventListener('change', apply);
</script>
</body>
</html>`;
}
