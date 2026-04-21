// bake-pages.js — v4 — honest registry for showing clients.
//
// Every project classifies into ONE category and the Play button does
// the right thing for that category:
//
//   LIVE     → runnable in browser, Play opens the live URL
//   DEMO     → can't run statically, Play opens a full-screen lightbox
//              showing the Puppeteer screenshot of the app running locally
//              + description + how-to-run instructions
//   DOWNLOAD → desktop/Electron app, Play triggers a source ZIP download
//   VENDOR   → third-party vendored (Node-RED, XAMPP), Play → upstream site
//
// Plus: simple login gate (password check), bookmark/favorites star,
// category filter, framework filter, client-side search. All static.
// Ledger M4: telegram-matching projects filtered pre-render.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const GH_USER   = 'lozturner';
const OUT       = path.join(__dirname, 'pages-bake');
const THUMBS_IN = path.join(__dirname, 'public', 'thumbnails');
const THUMBS_OUT= path.join(OUT, 'thumbnails');

// Simple password gate — SHA-256 of the plaintext lives in the emitted HTML.
// Laurence: set LTV2_PASSWORD env var before running the bake, or edit below.
const LOGIN_PASSWORD = process.env.LTV2_PASSWORD || 'foundry';
const PASSWORD_HASH  = crypto.createHash('sha256').update(LOGIN_PASSWORD).digest('hex');

// Vendored upstream URLs for framework-detected third-party tools
const UPSTREAM_URL = {
  'Node-RED': 'https://nodered.org',
  'XAMPP (Apache + MySQL)': 'https://www.apachefriends.org',
};

// Load the pages map (repo-slug → live URL) written by enable-pages.js
let PAGES_MAP = {};
try {
  PAGES_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'pages-map.json'), 'utf8')).pages || {};
} catch {}

// ────────────────────────────────────────────────────────────────
// Fetch + bake
// ────────────────────────────────────────────────────────────────
http.get('http://127.0.0.1:4343/api/projects', (res) => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    const { projects } = JSON.parse(buf);

    const enriched = projects
      .filter(p => !/telegram/i.test((p.path || '') + ' ' + (p.name || '') + ' ' + (p.framework || '')))
      .map(p => enrich(p));

    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(THUMBS_OUT, { recursive: true });

    let copied = 0;
    for (const p of enriched) {
      if (!p.hasThumb) continue;
      try {
        fs.copyFileSync(path.join(THUMBS_IN, `${p.id}.png`), path.join(THUMBS_OUT, `${p.id}.png`));
        copied++;
      } catch {}
    }

    fs.writeFileSync(path.join(OUT, 'index.html'), render(enriched));
    fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
    console.log(`Baked ${enriched.length} cards + ${copied} thumbnails → ${OUT}`);
    console.log(`Login password: "${LOGIN_PASSWORD}"  (hash ${PASSWORD_HASH.slice(0,12)}…)`);
    const cat = {};
    for (const p of enriched) cat[p.category] = (cat[p.category]||0)+1;
    console.log('Categories:', cat);
  });
}).on('error', e => { console.error('bake failed — is v2 running on :4343?', e.message); process.exit(1); });

// ────────────────────────────────────────────────────────────────
// Project enrichment + classification
// ────────────────────────────────────────────────────────────────
function enrich(p) {
  const githubUrl = readGithubRemote(p.path);
  const upstreamUrl = UPSTREAM_URL[p.framework];
  const effectiveRepo = githubUrl || upstreamUrl || null;
  const entryFile = findEntryFile(p.path, p.name, p.startCommand, p.entryFile);
  const slug = githubUrl ? slugFromUrl(githubUrl) : null;
  const pagesBase = slug ? PAGES_MAP[slug] : null;

  // Compute live URL (only if Pages is enabled for this repo)
  let liveUrl = null;
  if (pagesBase) {
    if (entryFile && /\.html?$/i.test(entryFile)) {
      liveUrl = pagesBase.replace(/\/$/, '') + '/' + encodeURI(entryFile.replace(/^\.?\//, ''));
    } else {
      liveUrl = pagesBase;
    }
  }

  // Classify into one category
  let category;
  if (upstreamUrl && !githubUrl) {
    category = 'VENDOR';
  } else if (liveUrl) {
    category = 'LIVE';
  } else if (githubUrl && (p.electronApp || /Electron/i.test(p.framework) || /Express|Node/i.test(p.framework) && !/Static HTML/i.test(p.framework))) {
    category = 'DOWNLOAD'; // Electron + pure Node backends
  } else if (githubUrl && p.hasThumb) {
    // Python / backend apps we can't run live but we have a screenshot
    category = 'DEMO';
  } else if (githubUrl) {
    category = 'DEMO'; // fallback — show a placeholder even without thumb
  } else {
    category = 'DEMO';
  }

  // Primary Play URL per category
  let playUrl;
  switch (category) {
    case 'LIVE':     playUrl = liveUrl; break;
    case 'DOWNLOAD': playUrl = `${githubUrl}/archive/HEAD.zip`; break;
    case 'VENDOR':   playUrl = upstreamUrl; break;
    case 'DEMO':     playUrl = null; break; // lightbox, no URL
  }

  return {
    id: p.id,
    name: p.name || '',
    framework: p.framework || 'Unknown',
    ports: Array.isArray(p.ports) ? p.ports.slice(0, 4) : [],
    description: cleanDesc(p.description),
    hasReadme: !!p.hasReadme,
    hasThumb: fs.existsSync(path.join(THUMBS_IN, `${p.id}.png`)),
    githubUrl,
    effectiveRepo,
    slug,
    liveUrl,
    entryFile,
    category,
    playUrl,
    // Install hint for DEMO/DOWNLOAD lightboxes
    installHint: installHint(p),
  };
}

function installHint(p) {
  const fw = p.framework || '';
  const sc = p.startCommand || '';
  if (/Electron/i.test(fw))            return 'Desktop app — clone, then `npm install && npm start`';
  if (/Flask|Django/i.test(fw))        return `Python server — clone, \`pip install -r requirements.txt\`, then \`${sc || 'python app.py'}\``;
  if (/Python/i.test(fw))              return `Python — clone, then \`${sc || 'python main.py'}\``;
  if (/Next\.js/i.test(fw))            return 'Next.js — clone, `npm install`, `npm run dev`';
  if (/Vite/i.test(fw))                return 'Vite — clone, `npm install`, `npm run dev`';
  if (/React/i.test(fw))               return 'React — clone, `npm install`, `npm start`';
  if (/Express|Node/i.test(fw))        return 'Node server — clone, `npm install`, `npm start`';
  if (/Static HTML/i.test(fw))         return 'Static HTML — clone and open `index.html`';
  return 'Clone the repo and follow its README';
}

// Read .git/config → https URL, or null
function readGithubRemote(projectPath) {
  if (!projectPath) return null;
  try {
    const cfg = fs.readFileSync(path.join(projectPath, '.git', 'config'), 'utf8');
    const m = cfg.match(/url\s*=\s*(\S+)/);
    if (!m) return null;
    let url = m[1].trim()
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/\.git$/, '');
    return /^https?:\/\//.test(url) ? url : null;
  } catch { return null; }
}

function slugFromUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com\/[^\/]+\/([^\/\s#?]+)/);
  return m ? m[1] : null;
}

function findEntryFile(projectPath, name, startCommand, explicitEntry) {
  if (!projectPath) return null;
  const exists = (rel) => { try { return fs.existsSync(path.join(projectPath, rel)); } catch { return false; } };
  if (explicitEntry && exists(explicitEntry)) return explicitEntry.replace(/\\/g, '/');
  if (startCommand) {
    const m = startCommand.match(/([A-Za-z0-9_\-\/\\\.]+\.(?:html|py|pyw|js|mjs))\b/);
    if (m && exists(m[1])) return m[1].replace(/\\/g, '/');
  }
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug) {
    for (const ext of ['.html', '.py', '.pyw', '.js']) if (exists(slug + ext)) return slug + ext;
    if (exists(slug)) return slug;
  }
  return null;
}

function cleanDesc(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/\s*[—–-]?\s*:\d{2,5}\b/g, '')
    .replace(/\bport\s+\d{2,5}\b/gi, '')
    .replace(/\blocalhost:\d{2,5}\b/gi, '');
  s = s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#+\s+/g, '');
  return s.replace(/\s{2,}/g, ' ').replace(/\s+[—–-]\s*$/, '').trim();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ────────────────────────────────────────────────────────────────
// Render
// ────────────────────────────────────────────────────────────────
const BADGE_CLASS = { 'Next.js':'badge-nextjs','Vite':'badge-vite','React':'badge-react','Create React App':'badge-react','Express':'badge-express','Electron':'badge-electron','Python':'badge-python','Django':'badge-django','Flask':'badge-flask','Docker':'badge-docker','Static HTML':'badge-static','Node-RED':'badge-nodered','XAMPP':'badge-xampp' };
const FRAMEWORK_ICON = { 'Next.js':'N','Vite':'V','React':'R','Create React App':'R','Express':'Ex','Electron':'E','Python':'Py','Django':'Dj','Flask':'Fl','Docker':'D','Static HTML':'H','Node-RED':'NR','XAMPP':'X','Three.js':'3D','Tailwind':'Tw' };
const CATEGORY_META = {
  LIVE:     { label: 'LIVE',     color: '#22c55e', icon: '🟢' },
  DEMO:     { label: 'DEMO',     color: '#f59e0b', icon: '🎬' },
  DOWNLOAD: { label: 'DOWNLOAD', color: '#94a3b8', icon: '💾' },
  VENDOR:   { label: 'VENDOR',   color: '#6366f1', icon: '🌐' },
};

function badgeClass(fw) { for (const [k,c] of Object.entries(BADGE_CLASS)) if (fw.includes(k)) return c; return 'badge-framework'; }
function frameworkIcon(fw) { for (const [k,i] of Object.entries(FRAMEWORK_ICON)) if (fw.includes(k)) return i; return '?'; }

function renderCard(p) {
  const cm = CATEGORY_META[p.category];
  const portBadges = p.ports.map(port => `<span class="badge badge-port">:${port}</span>`).join('');
  const thumbSrc = p.hasThumb ? `thumbnails/${p.id}.png` : '';

  // Play button — either a real URL or data-action="demo" to trigger the lightbox
  const playAttrs = p.playUrl
    ? `href="${esc(p.playUrl)}" target="_blank" rel="noopener"`
    : `href="#" data-demo="${esc(p.id)}"`;

  return `
    <article class="card" data-id="${esc(p.id)}" data-name="${esc(p.name.toLowerCase())}" data-framework="${esc(p.framework)}" data-category="${p.category}">
      <div class="card-thumb">
        ${thumbSrc ? `<img src="${thumbSrc}" alt="${esc(p.name)}" loading="lazy">` : `<div class="placeholder">${frameworkIcon(p.framework)}</div>`}
        <div class="framework-icon" title="${esc(p.framework)}">${frameworkIcon(p.framework)}</div>
        <div class="category-badge" style="background:${cm.color}22;border-color:${cm.color}66;color:${cm.color}">${cm.icon} ${cm.label}</div>
        <button class="fav-btn" data-fav="${esc(p.id)}" title="Bookmark">☆</button>
      </div>
      <div class="card-body">
        <div class="card-badges">
          <span class="badge ${badgeClass(p.framework)}">${esc(p.framework)}</span>
          ${portBadges}
        </div>
        <div class="card-name">${esc(p.name)}</div>
        <div class="card-desc">${esc(p.description).slice(0, 220)}</div>
      </div>
      <div class="card-footer">
        <a class="play-btn" ${playAttrs} data-name="${esc(p.name)}" data-framework="${esc(p.framework)}" data-category="${p.category}" data-thumb="${thumbSrc}" data-desc="${esc(p.description)}" data-install="${esc(p.installHint || '')}" data-repo="${esc(p.githubUrl || '')}">▶ Play</a>
        ${p.githubUrl ? `<a class="source-btn" href="${esc(p.githubUrl)}" target="_blank" rel="noopener" title="View source on GitHub">🐙</a>` : ''}
      </div>
    </article>`;
}

function render(projects) {
  projects.sort((a, b) => a.name.localeCompare(b.name));

  const fwSet = [...new Set(projects.flatMap(p => p.framework.split(/\s*\+\s*/).map(f => f.trim()).filter(Boolean)))].sort();
  const counts = {};
  for (const p of projects) counts[p.category] = (counts[p.category]||0) + 1;

  const cards = projects.map(renderCard).join('\n');
  const fwOptions = fwSet.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Laurence Localhost v2 — Turner Foundry</title>
<style>
  :root {
    --bg: #0a0a0f; --bg2: #0f0f17; --card: #12121a; --card-hi: #1a1a25;
    --accent: #6366f1; --accent-glow: rgba(99,102,241,0.15);
    --success: #22c55e; --warning: #f59e0b; --danger: #ef4444;
    --text: #e2e8f0; --dim: #94a3b8; --muted: #64748b;
    --border: #1e293b; --border-hi: #334155;
    --foundry-a: #b45309; --foundry-b: #92400e;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }

  /* ─── Login gate ─────────────────────────────────────────── */
  #login-overlay {
    position:fixed; inset:0; background:var(--bg);
    display:flex; align-items:center; justify-content:center; z-index:1000;
  }
  #login-overlay.hidden { display:none; }
  .login-box {
    background:var(--card); border:1px solid var(--border); border-radius:16px;
    padding:40px 48px; max-width:420px; width:90%; text-align:center;
    box-shadow:0 10px 40px rgba(0,0,0,0.4);
  }
  .login-box h1 { font-size:20px; margin-bottom:6px; display:flex; align-items:center; justify-content:center; gap:8px; }
  .login-box h1 .icon { color:var(--foundry-a); font-size:24px; }
  .login-box h1 .accent { color:var(--accent); }
  .login-box .foundry-badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:700; background:linear-gradient(135deg,var(--foundry-a),var(--foundry-b)); color:#fef3c7; letter-spacing:1px; text-transform:uppercase; margin:8px 0 20px; }
  .login-box p { font-size:13px; color:var(--dim); margin-bottom:24px; }
  .login-box input { width:100%; padding:12px 16px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:14px; outline:none; font-family:inherit; }
  .login-box input:focus { border-color:var(--accent); }
  .login-box button { width:100%; padding:12px; margin-top:12px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
  .login-box button:hover { background:#4f46e5; }
  .login-box .err { color:var(--danger); font-size:12px; margin-top:8px; min-height:16px; }

  /* ─── Header ─────────────────────────────────────────────── */
  header { background:var(--bg2); border-bottom:1px solid var(--border); padding:16px 24px; position:sticky; top:0; z-index:100; }
  .header-top { display:flex; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:12px; }
  h1.logo { font-size:20px; font-weight:700; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  h1.logo .icon { color:var(--foundry-a); font-size:22px; }
  h1.logo .accent { color:var(--accent); }
  .foundry-badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:10px; font-weight:700; background:linear-gradient(135deg,var(--foundry-a),var(--foundry-b)); color:#fef3c7; letter-spacing:1px; text-transform:uppercase; }

  .controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .search-input { flex:1; min-width:200px; padding:8px 14px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:14px; outline:none; }
  .search-input:focus { border-color:var(--accent); }
  select { padding:8px 12px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:14px; cursor:pointer; }
  .btn-pill {
    padding:6px 12px; border-radius:20px; font-size:12px; font-weight:600;
    cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--dim);
    font-family:inherit; transition:all 0.15s;
  }
  .btn-pill:hover { border-color:var(--accent); color:var(--accent); }
  .btn-pill.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .btn-pill.cat-LIVE.active     { background:var(--success); border-color:var(--success); color:#000; }
  .btn-pill.cat-DEMO.active     { background:var(--warning); border-color:var(--warning); color:#000; }
  .btn-pill.cat-DOWNLOAD.active { background:var(--dim); border-color:var(--dim); color:#000; }

  /* ─── Stats strip ────────────────────────────────────────── */
  .stats { display:flex; gap:20px; padding:10px 24px; background:var(--bg2); border-bottom:1px solid var(--border); flex-wrap:wrap; font-size:13px; color:var(--dim); }
  .stat strong { color:var(--text); font-weight:700; margin-right:4px; }
  .stat.live strong { color:var(--success); }
  .stat.demo strong { color:var(--warning); }
  .stat.dl   strong { color:var(--dim); }
  .stat.ven  strong { color:var(--accent); }

  /* ─── Grid ───────────────────────────────────────────────── */
  main { padding:20px 24px; display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
  .card {
    background:var(--card); border:1px solid var(--border); border-radius:12px;
    overflow:hidden; display:flex; flex-direction:column; transition:all 0.2s;
  }
  .card:hover { border-color:var(--border-hi); transform:translateY(-2px); box-shadow:0 6px 24px rgba(0,0,0,0.35); }
  .card.hidden { display:none; }

  .card-thumb { position:relative; height:150px; background:var(--bg); overflow:hidden; }
  .card-thumb img { width:100%; height:100%; object-fit:cover; }
  .card-thumb .placeholder { font-size:48px; color:var(--accent); opacity:0.25; position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-weight:700; }
  .framework-icon { position:absolute; top:8px; left:8px; font-size:12px; font-weight:700; background:rgba(0,0,0,0.7); padding:3px 8px; border-radius:6px; color:var(--text); border:1px solid rgba(255,255,255,0.08); }
  .category-badge { position:absolute; top:8px; right:44px; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:700; letter-spacing:0.5px; border:1px solid; }
  .fav-btn {
    position:absolute; top:8px; right:8px; width:28px; height:28px; border-radius:6px;
    background:rgba(0,0,0,0.7); border:1px solid rgba(255,255,255,0.12); color:#fff;
    font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center;
    transition:all 0.15s;
  }
  .fav-btn:hover { background:rgba(245,158,11,0.2); border-color:var(--warning); color:var(--warning); }
  .fav-btn.on { color:var(--warning); background:rgba(245,158,11,0.2); border-color:var(--warning); }

  .card-body { padding:12px; flex:1; display:flex; flex-direction:column; gap:6px; }
  .card-badges { display:flex; flex-wrap:wrap; gap:5px; }
  .badge { padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; border:1px solid; }
  .badge-framework { background:var(--accent-glow); border-color:rgba(99,102,241,0.3); color:var(--accent); }
  .badge-nextjs { background:rgba(0,0,0,0.3); border-color:#333; color:#fff; }
  .badge-vite { background:rgba(189,147,249,0.15); border-color:rgba(189,147,249,0.3); color:#bd93f9; }
  .badge-react { background:rgba(97,218,251,0.15); border-color:rgba(97,218,251,0.3); color:#61dafb; }
  .badge-express { background:rgba(34,197,94,0.15); border-color:rgba(34,197,94,0.3); color:#22c55e; }
  .badge-electron { background:rgba(148,163,184,0.15); border-color:rgba(148,163,184,0.3); color:#94a3b8; }
  .badge-python { background:rgba(250,204,21,0.15); border-color:rgba(250,204,21,0.3); color:#facc15; }
  .badge-django { background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.3); color:#10b981; }
  .badge-docker { background:rgba(59,130,246,0.15); border-color:rgba(59,130,246,0.3); color:#3b82f6; }
  .badge-static { background:rgba(148,163,184,0.1); border-color:rgba(148,163,184,0.2); color:#94a3b8; }
  .badge-nodered { background:rgba(239,68,68,0.15); border-color:rgba(239,68,68,0.3); color:#ef4444; }
  .badge-xampp { background:rgba(251,146,60,0.15); border-color:rgba(251,146,60,0.3); color:#fb923c; }
  .badge-flask { background:rgba(148,163,184,0.15); border-color:rgba(148,163,184,0.3); color:#cbd5e1; }
  .badge-port { background:rgba(148,163,184,0.1); border-color:var(--border); color:var(--dim); font-family:'Courier New',monospace; }
  .card-name { font-size:15px; font-weight:600; color:var(--text); }
  .card-desc { font-size:12px; color:var(--dim); line-height:1.4; flex:1;
    display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }

  .card-footer { padding:10px 12px; border-top:1px solid rgba(99,102,241,0.1); background:rgba(99,102,241,0.03); display:flex; gap:8px; align-items:center; }
  .play-btn {
    flex:1; padding:9px 14px; border-radius:8px; font-size:13px; font-weight:700;
    text-align:center; text-decoration:none; background:var(--success); color:#000;
    transition:all 0.15s; font-family:inherit;
  }
  .play-btn:hover { background:#16a34a; transform:scale(1.02); box-shadow:0 0 12px rgba(34,197,94,0.4); }
  .card[data-category="DEMO"] .play-btn     { background:var(--warning); }
  .card[data-category="DEMO"] .play-btn:hover { background:#d97706; box-shadow:0 0 12px rgba(245,158,11,0.4); }
  .card[data-category="DOWNLOAD"] .play-btn  { background:var(--dim); }
  .card[data-category="DOWNLOAD"] .play-btn:hover { background:#64748b; }
  .card[data-category="VENDOR"] .play-btn   { background:var(--accent); color:#fff; }
  .card[data-category="VENDOR"] .play-btn:hover { background:#4f46e5; }
  .source-btn {
    padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:transparent;
    color:var(--dim); text-decoration:none; font-size:14px; transition:all 0.15s;
  }
  .source-btn:hover { border-color:var(--accent); color:var(--accent); }

  /* ─── Lightbox for DEMO category ─────────────────────────── */
  .lightbox {
    position:fixed; inset:0; background:rgba(0,0,0,0.9);
    display:none; align-items:center; justify-content:center; z-index:500; padding:24px;
  }
  .lightbox.open { display:flex; }
  .lightbox-inner {
    background:var(--card); border:1px solid var(--border); border-radius:16px;
    max-width:1100px; width:100%; max-height:92vh; overflow:auto;
    display:grid; grid-template-columns:1fr 340px; gap:0;
  }
  @media (max-width:900px) { .lightbox-inner { grid-template-columns:1fr; } }
  .lightbox-img { background:var(--bg); display:flex; align-items:center; justify-content:center; padding:20px; }
  .lightbox-img img { max-width:100%; max-height:80vh; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .lightbox-img .no-thumb { color:var(--muted); font-size:14px; }
  .lightbox-info { padding:24px; display:flex; flex-direction:column; gap:14px; }
  .lightbox-info h2 { font-size:22px; color:var(--text); }
  .lightbox-info .cat-tag { display:inline-block; padding:3px 10px; border-radius:6px; font-size:11px; font-weight:700; align-self:flex-start; }
  .lightbox-info p { font-size:14px; line-height:1.5; color:var(--dim); }
  .lightbox-info code { background:var(--bg); padding:2px 6px; border-radius:4px; font-size:12px; color:var(--text); font-family:'Courier New',monospace; }
  .lightbox-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:auto; }
  .lightbox-actions a { flex:1; min-width:120px; padding:10px; border-radius:8px; text-align:center; text-decoration:none; font-size:13px; font-weight:600; }
  .lightbox-actions .primary { background:var(--accent); color:#fff; }
  .lightbox-actions .ghost { border:1px solid var(--border); color:var(--text); }
  .lightbox-close {
    position:absolute; top:20px; right:20px; width:36px; height:36px;
    border-radius:50%; background:rgba(0,0,0,0.6); border:1px solid rgba(255,255,255,0.15);
    color:#fff; font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center;
  }
  .lightbox-close:hover { background:var(--danger); border-color:var(--danger); }
  .install-hint { background:var(--bg); border:1px solid var(--border); padding:12px; border-radius:8px; font-size:13px; line-height:1.5; color:var(--text); }
  .install-hint strong { color:var(--warning); display:block; margin-bottom:6px; font-size:11px; letter-spacing:1px; text-transform:uppercase; }

  /* ─── Toast ──────────────────────────────────────────────── */
  .toast {
    position:fixed; bottom:20px; right:20px; background:var(--card); border:1px solid var(--success);
    padding:10px 16px; border-radius:8px; font-size:13px; color:var(--text);
    opacity:0; transform:translateY(10px); transition:all 0.2s; pointer-events:none;
  }
  .toast.visible { opacity:1; transform:translateY(0); }

  .empty { grid-column:1/-1; text-align:center; padding:60px; color:var(--muted); font-size:15px; }
  footer { padding:20px 24px; text-align:center; color:var(--muted); font-size:12px; border-top:1px solid var(--border); }
  footer a { color:var(--accent); text-decoration:none; }
</style>
</head>
<body>

<!-- ─── LOGIN GATE ───────────────────────────────────────────── -->
<div id="login-overlay">
  <div class="login-box">
    <h1><span class="icon">⚒</span> Laurence Localhost <span class="accent">v2</span></h1>
    <div class="foundry-badge">Turner Foundry</div>
    <p>Enter the password to view the project registry.</p>
    <input type="password" id="login-pw" placeholder="Password" autocomplete="current-password">
    <button onclick="tryLogin()">Unlock</button>
    <div class="err" id="login-err"></div>
  </div>
</div>

<!-- ─── HEADER ──────────────────────────────────────────────── -->
<header>
  <div class="header-top">
    <h1 class="logo">
      <span class="icon">⚒</span> Laurence Localhost <span class="accent">v2</span>
      <span class="foundry-badge">Turner Foundry</span>
    </h1>
  </div>
  <div class="controls">
    <input type="text" class="search-input" id="search" placeholder="Search projects…">
    <select id="fw-filter">
      <option value="">All frameworks</option>
      ${fwOptions}
    </select>
    <button class="btn-pill cat-ALL active" data-cat="">All · ${projects.length}</button>
    <button class="btn-pill cat-LIVE"     data-cat="LIVE">🟢 LIVE · ${counts.LIVE||0}</button>
    <button class="btn-pill cat-DEMO"     data-cat="DEMO">🎬 DEMO · ${counts.DEMO||0}</button>
    <button class="btn-pill cat-DOWNLOAD" data-cat="DOWNLOAD">💾 DOWNLOAD · ${counts.DOWNLOAD||0}</button>
    <button class="btn-pill cat-VENDOR"   data-cat="VENDOR">🌐 VENDOR · ${counts.VENDOR||0}</button>
    <button class="btn-pill" id="fav-toggle">☆ Favorites</button>
  </div>
</header>

<div class="stats">
  <div class="stat"><strong>${projects.length}</strong>Projects</div>
  <div class="stat live"><strong>${counts.LIVE||0}</strong>Run live</div>
  <div class="stat demo"><strong>${counts.DEMO||0}</strong>Demo via screenshot</div>
  <div class="stat dl"><strong>${counts.DOWNLOAD||0}</strong>Download only</div>
  <div class="stat ven"><strong>${counts.VENDOR||0}</strong>Vendor redirect</div>
</div>

<main id="grid">
${cards}
  <div class="empty" id="empty" style="display:none">No projects match.</div>
</main>

<footer>
  Baked ${new Date().toISOString().split('T')[0]} · ${projects.length} projects ·
  <a href="https://github.com/lozturner/laurence-localhost-v2" target="_blank">source</a>
</footer>

<!-- ─── LIGHTBOX ────────────────────────────────────────────── -->
<div class="lightbox" id="lightbox">
  <div class="lightbox-inner">
    <div class="lightbox-img" id="lb-img"></div>
    <div class="lightbox-info" id="lb-info"></div>
  </div>
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
</div>

<div class="toast" id="toast"></div>

<script>
  // ─── Login gate ─────────────────────────────────────────
  const PW_HASH = '${PASSWORD_HASH}';
  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function tryLogin() {
    const pw = document.getElementById('login-pw').value;
    const h = await sha256(pw);
    if (h === PW_HASH) {
      sessionStorage.setItem('ltv2-auth', h);
      document.getElementById('login-overlay').classList.add('hidden');
    } else {
      document.getElementById('login-err').textContent = 'Wrong password.';
    }
  }
  document.getElementById('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  if (sessionStorage.getItem('ltv2-auth') === PW_HASH) {
    document.getElementById('login-overlay').classList.add('hidden');
  } else {
    setTimeout(() => document.getElementById('login-pw').focus(), 100);
  }

  // ─── Filters ────────────────────────────────────────────
  const cards = Array.from(document.querySelectorAll('.card'));
  const search = document.getElementById('search');
  const fwFilter = document.getElementById('fw-filter');
  const empty = document.getElementById('empty');
  let activeCat = '';
  let favOnly = false;

  function getFavs() { try { return JSON.parse(localStorage.getItem('ltv2-favs')||'[]'); } catch { return []; } }
  function setFavs(a) { localStorage.setItem('ltv2-favs', JSON.stringify(a)); }
  function isFav(id) { return getFavs().includes(id); }

  function apply() {
    const q = search.value.trim().toLowerCase();
    const f = fwFilter.value;
    const favs = getFavs();
    let visible = 0;
    for (const c of cards) {
      const name = c.dataset.name || '';
      const fw   = c.dataset.framework || '';
      const cat  = c.dataset.category || '';
      const id   = c.dataset.id;
      const okQ = !q || name.includes(q) || fw.toLowerCase().includes(q);
      const okF = !f || fw.includes(f);
      const okC = !activeCat || cat === activeCat;
      const okFav = !favOnly || favs.includes(id);
      const show = okQ && okF && okC && okFav;
      c.classList.toggle('hidden', !show);
      if (show) visible++;
    }
    empty.style.display = visible === 0 ? 'block' : 'none';
  }

  search.addEventListener('input', apply);
  fwFilter.addEventListener('change', apply);

  // Category pill filter
  document.querySelectorAll('.btn-pill[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-pill[data-cat]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCat = btn.dataset.cat;
      apply();
    });
  });

  // Favorites toggle
  document.getElementById('fav-toggle').addEventListener('click', (e) => {
    favOnly = !favOnly;
    e.currentTarget.classList.toggle('active', favOnly);
    e.currentTarget.innerHTML = favOnly ? '★ Favorites' : '☆ Favorites';
    apply();
  });

  // Per-card bookmark stars
  function paintFavs() {
    const favs = getFavs();
    document.querySelectorAll('.fav-btn').forEach(b => {
      const id = b.dataset.fav;
      const on = favs.includes(id);
      b.classList.toggle('on', on);
      b.textContent = on ? '★' : '☆';
    });
  }
  document.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      const id = btn.dataset.fav;
      const favs = getFavs();
      const i = favs.indexOf(id);
      if (i >= 0) favs.splice(i, 1); else favs.push(id);
      setFavs(favs);
      paintFavs();
      if (favOnly) apply();
      toast(i >= 0 ? 'Removed from favorites' : '⭐ Added to favorites');
    });
  });
  paintFavs();

  // ─── Lightbox for DEMO category ─────────────────────────
  function openLightbox(btn) {
    const lb = document.getElementById('lightbox');
    const imgBox = document.getElementById('lb-img');
    const info = document.getElementById('lb-info');
    const thumb = btn.dataset.thumb;
    const name  = btn.dataset.name;
    const fw    = btn.dataset.framework;
    const desc  = btn.dataset.desc || '';
    const install = btn.dataset.install || '';
    const repo  = btn.dataset.repo || '';
    imgBox.innerHTML = thumb
      ? '<img src="' + thumb + '" alt="' + name + '">'
      : '<div class="no-thumb">No thumbnail available yet. Run Snap All in the local dashboard.</div>';
    info.innerHTML =
      '<span class="cat-tag" style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#f59e0b">🎬 DEMO — needs local install to run</span>' +
      '<h2>' + name + '</h2>' +
      '<p><strong style="color:var(--text)">' + fw + '</strong></p>' +
      (desc ? '<p>' + desc + '</p>' : '') +
      '<div class="install-hint"><strong>How to run it</strong>' + install + '</div>' +
      '<div class="lightbox-actions">' +
        (repo ? '<a class="primary" href="' + repo + '" target="_blank" rel="noopener">🐙 View source</a>' : '') +
        (repo ? '<a class="ghost" href="' + repo + '/archive/HEAD.zip">⬇ Download ZIP</a>' : '') +
      '</div>';
    lb.classList.add('open');
  }
  function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  // Play button routing
  document.querySelectorAll('.play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (btn.dataset.demo) {
        e.preventDefault();
        openLightbox(btn);
      }
    });
  });

  // Toast helper
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(window._tt);
    window._tt = setTimeout(() => t.classList.remove('visible'), 1800);
  }
</script>
</body>
</html>`;
}
