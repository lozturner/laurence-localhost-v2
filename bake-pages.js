// bake-pages.js — generate a static, ledger-safe mirror of v2's project registry.
// Strips: paths, ports, PIDs, launch URLs, telegram exports (ledger M4).
// Output: ./pages-bake/index.html  (+ nothing else — no JS, no API calls, no thumbs from filesystem)
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'pages-bake');

http.get('http://127.0.0.1:4343/api/projects', (res) => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    const { projects } = JSON.parse(buf);

    // Ledger M4: no telegram exports anywhere near a public surface.
    const safe = projects
      .filter(p => !/telegram/i.test((p.path || '') + ' ' + (p.name || '') + ' ' + (p.framework || '')))
      .map(p => ({
        // WHITELIST. Everything else is dropped — paths, ports, pid, launchUrl, portSources, etc.
        name: p.name || '',
        framework: p.framework || 'Unknown',
        description: (p.description || '')
          .replace(/[\r\n]+/g, ' ')
          // Ledger M4/M5: scrub any port-ish token that leaked into auto-descriptions
          // ("Python app — :8771" → "Python app"; "runs on port 3000" → "runs")
          .replace(/\s*[—–-]?\s*:\d{2,5}\b/g, '')
          .replace(/\bport\s+\d{2,5}\b/gi, '')
          .replace(/\blocalhost:\d{2,5}\b/gi, '')
          .replace(/\b127\.0\.0\.1:\d{2,5}\b/g, '')
          .replace(/\s{2,}/g, ' ')
          .replace(/\s+[—–-]\s*$/, '')
          .trim(),
      }));

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'index.html'), render(safe));
    fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // don't let Jekyll mangle anything
    console.log(`Baked ${safe.length} cards → ${OUT}`);
  });
}).on('error', e => { console.error('bake failed — is v2 running on :4343?', e.message); process.exit(1); });

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function render(projects) {
  // Sort alpha so the mirror is deterministic diff-to-diff.
  projects.sort((a, b) => a.name.localeCompare(b.name));
  const cards = projects.map(p => `    <article class="card">
      <div class="badges"><span class="badge">${esc(p.framework)}</span></div>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.description).slice(0, 220)}</p>
    </article>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Laurence Localhost v2 — Turner Foundry (read-only mirror)</title>
<style>
  :root { --bg:#0a0a0f; --card:#12121a; --card-hi:#1a1a25; --text:#e2e8f0; --dim:#94a3b8;
          --muted:#64748b; --accent:#6366f1; --foundry-a:#b45309; --foundry-b:#92400e;
          --border:#1e293b; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
         background:var(--bg); color:var(--text); min-height:100vh; line-height:1.45; }
  header { padding:20px 28px; border-bottom:1px solid var(--border); background:#0f0f17; }
  h1 { font-size:22px; font-weight:700; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  h1 .icon { color:var(--foundry-a); font-size:24px; }
  h1 .accent { color:var(--accent); }
  .foundry-badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:10px;
    font-weight:700; background:linear-gradient(135deg,var(--foundry-a),var(--foundry-b));
    color:#fef3c7; letter-spacing:1px; text-transform:uppercase; border:1px solid #78350f;
    box-shadow:0 0 8px rgba(180,83,9,0.25); }
  .ro-badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:10px;
    font-weight:700; background:rgba(148,163,184,0.12); color:var(--dim);
    letter-spacing:1px; text-transform:uppercase; border:1px solid var(--border); }
  .banner { padding:14px 28px; background:rgba(180,83,9,0.07);
    border-bottom:1px solid rgba(180,83,9,0.2); font-size:13px; color:#fcd34d; }
  .banner strong { color:#fde68a; }
  .banner code { background:rgba(0,0,0,0.35); padding:1px 6px; border-radius:3px; font-size:12px; }
  main { padding:24px 28px; display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px;
    transition:background 0.15s, border-color 0.15s; }
  .card:hover { background:var(--card-hi); border-color:#334155; }
  .badges { margin-bottom:8px; display:flex; flex-wrap:wrap; gap:6px; }
  .badge { padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;
    background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.3); color:var(--accent); }
  .card h3 { font-size:15px; margin-bottom:6px; color:var(--text); }
  .card p { font-size:13px; color:var(--dim);
    display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .card p:empty::before { content:'—'; color:var(--muted); }
  footer { padding:24px 28px; color:var(--muted); font-size:12px; text-align:center; border-top:1px solid var(--border); }
  footer a { color:var(--accent); text-decoration:none; }
  footer a:hover { text-decoration:underline; }
</style>
</head>
<body>
<header>
  <h1>
    <span class="icon">⚒</span> Laurence Localhost <span class="accent">v2</span>
    <span class="foundry-badge">Turner Foundry</span>
    <span class="ro-badge">Read-only mirror</span>
  </h1>
</header>
<div class="banner">
  <strong>This is a static snapshot.</strong> No live state, no paths, no ports, no controls.
  The working registry runs locally on <code>localhost:4343</code>.
</div>
<main>
${cards}
</main>
<footer>Baked ${new Date().toISOString().split('T')[0]} · ${projects.length} projects · <a href="https://github.com/lozturner/laurence-localhost-v2">source on GitHub</a></footer>
</body>
</html>`;
}
