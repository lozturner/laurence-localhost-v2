#!/usr/bin/env node
// fix-runs.js — honest triage of the audit:
//  (A) Disable GitHub Pages on repos where the Pages URL is just a Jekyll-
//      rendered README (misleading — clicking Run should show the app, not docs)
//  (B) Build & deploy Vite / Next.js projects that CAN render statically
//      and push dist/ to gh-pages branch so Run actually runs them

const fs    = require('fs');
const path  = require('path');
const { spawnSync } = require('child_process');

const GH = 'lozturner';

function run(cwd, cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 50*1024*1024 });
  if (!capture && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exit ${r.status}\n${(r.stderr||r.stdout).split('\n').slice(-15).join('\n')}`);
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function gh(args, o) { return run(process.cwd(), 'gh', args, o); }

// =============================================================
// (A) Disable Pages on repos whose current Pages URL is just Jekyll-on-README.
//     Electron-only apps: can't run in a browser, ZIP download is the honest answer.
// =============================================================
const JEKYLL_ONLY = [
  'binman', 'claude-home-hub', 'claude-v1', 'localhost-phonebook',
  'sandra', 'html-editor', 'org-sim',
  'alexa-puck', 'laurence-windows-chatbot', 'laurence-wispr',
  'wifi-sentinel', 'voice-commander', 'see-ahead-setup', 'laurence-maia',
  'personal-ai-system', 'my-react-app',
];

async function disablePagesWhereNoRealApp() {
  for (const repo of JEKYLL_ONLY) {
    const del = gh(['api', '-X', 'DELETE', `repos/${GH}/${repo}/pages`], { capture: true });
    if (del.code === 0) {
      console.log(`  disabled Pages on ${repo}`);
    } else if (/404|Not Found/.test(del.stderr)) {
      console.log(`  (already no Pages) ${repo}`);
    } else {
      console.log(`  FAIL ${repo}: ${del.stderr.split('\n')[0].slice(0,100)}`);
    }
  }
}

// =============================================================
// (B) For each build-capable repo, clone → install → build → push dist to gh-pages
// =============================================================
const BUILDABLE = [
  // name, builder, src dir (default "."), out dir, base-path flag
  { slug: 'super-canvas-app', kind: 'vite',    outDir: 'dist' },
  { slug: 'laurence-lens',    kind: 'next',    outDir: 'out'  },
  { slug: 'brain-sim',        kind: 'vite',    outDir: 'dist' },
  { slug: 'mere-mortal',      kind: 'static',  outDir: '.'    }, // just a static site; already deployed
];

const WORK = path.join(__dirname, '_build-tmp');

function ensureWork() {
  if (!fs.existsSync(WORK)) fs.mkdirSync(WORK, { recursive: true });
}

async function buildAndDeploy({ slug, kind, outDir }) {
  console.log(`\n── ${slug} (${kind})`);
  const repoDir = path.join(WORK, slug);
  if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });

  // Shallow clone
  let r = run(WORK, 'git', ['clone', '--depth', '1', `https://github.com/${GH}/${slug}.git`, slug], { capture: true });
  if (r.code !== 0) { console.log('  clone FAIL:', r.stderr.split('\n')[0]); return false; }

  // Patch vite config to use the repo base path for gh-pages
  if (kind === 'vite') {
    const cfgPath = ['vite.config.js','vite.config.ts','vite.config.mjs']
      .map(n => path.join(repoDir, n)).find(fs.existsSync);
    if (cfgPath) {
      let cfg = fs.readFileSync(cfgPath, 'utf8');
      if (!/base\s*:/.test(cfg)) {
        cfg = cfg.replace(/export default defineConfig\(\s*\{/,
          `export default defineConfig({\n  base: '/${slug}/',`);
        cfg = cfg.replace(/export default\s*\{/,
          `export default {\n  base: '/${slug}/',`);
        fs.writeFileSync(cfgPath, cfg);
        console.log('  patched vite base path');
      }
    }
  }
  if (kind === 'next') {
    // Emit static export
    const cfg = path.join(repoDir, 'next.config.ts');
    if (fs.existsSync(cfg)) {
      let s = fs.readFileSync(cfg, 'utf8');
      if (!/output:\s*['"]export['"]/.test(s)) {
        s = s.replace(/const nextConfig[^=]*=\s*\{/, m => m + `\n  output: 'export',\n  basePath: '/${slug}',\n  images: { unoptimized: true },`);
        fs.writeFileSync(cfg, s);
        console.log('  patched next.config.ts for static export');
      }
    }
  }

  // Install
  console.log('  npm install (quiet)…');
  r = run(repoDir, 'npm', ['install', '--no-audit', '--no-fund', '--silent'], { capture: true });
  if (r.code !== 0) { console.log('  install FAIL:', r.stderr.split('\n').slice(-5).join(' | ')); return false; }

  // Build
  console.log('  npm run build…');
  const buildScript = kind === 'next' ? 'build' : 'build';
  r = run(repoDir, 'npm', ['run', buildScript], { capture: true });
  if (r.code !== 0) { console.log('  build FAIL:', r.stderr.split('\n').slice(-5).join(' | ')); return false; }

  const distPath = path.join(repoDir, outDir);
  if (!fs.existsSync(distPath)) { console.log('  output dir not found:', distPath); return false; }

  // Push the built output as an orphan gh-pages branch
  const pagesWork = path.join(WORK, slug + '-pages');
  if (fs.existsSync(pagesWork)) fs.rmSync(pagesWork, { recursive: true, force: true });
  fs.mkdirSync(pagesWork, { recursive: true });

  // Copy dist/* into pagesWork
  function copyRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyRecursive(s, d);
      else fs.copyFileSync(s, d);
    }
  }
  copyRecursive(distPath, pagesWork);
  fs.writeFileSync(path.join(pagesWork, '.nojekyll'), '');

  run(pagesWork, 'git', ['init', '-b', 'gh-pages'], { capture: true });
  run(pagesWork, 'git', ['add', '-A'], { capture: true });
  run(pagesWork, 'git', ['commit', '-m', `Built ${kind} output from main`], { capture: true });
  run(pagesWork, 'git', ['remote', 'add', 'origin', `https://github.com/${GH}/${slug}.git`], { capture: true });
  const push = run(pagesWork, 'git', ['push', '--force', '-u', 'origin', 'gh-pages'], { capture: true });
  if (push.code !== 0) { console.log('  push FAIL:', push.stderr.split('\n').slice(-5).join(' | ')); return false; }

  // Switch Pages source to gh-pages
  run(process.cwd(), 'gh', ['api', '-X', 'POST', `repos/${GH}/${slug}/pages`,
    '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'], { capture: true });
  // If Pages already existed, update source
  run(process.cwd(), 'gh', ['api', '-X', 'PUT', `repos/${GH}/${slug}/pages`,
    '-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'], { capture: true });

  console.log(`  OK → https://${GH}.github.io/${slug}/`);
  return true;
}

(async () => {
  ensureWork();
  console.log('(A) Disabling Pages where only Jekyll README is served…');
  await disablePagesWhereNoRealApp();

  console.log('\n(B) Building & deploying buildable projects…');
  for (const b of BUILDABLE) {
    try { await buildAndDeploy(b); }
    catch (e) { console.log(`  ${b.slug} FAIL: ${e.message.split('\n')[0]}`); }
  }

  console.log('\nDone. Re-run audit-runs.js to verify.');
})();
