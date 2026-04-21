#!/usr/bin/env node
// enable-pages.js — for every pushed Laurence project repo, try to enable
// GitHub Pages on the default branch root so each project gets its own
// github.io subdomain. Reports which ones succeeded so bake-pages.js
// can point Run buttons at live URLs.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GH_USER = 'lozturner';

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', shell: false });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Fetch Laurence's repos, narrow to ones likely to belong to this project
function listOwnRepos() {
  const all = JSON.parse(gh(['repo', 'list', GH_USER, '--limit', '200', '--json', 'name,defaultBranchRef,visibility']).stdout);
  return all
    .filter(r => r.visibility === 'PUBLIC')
    .map(r => ({ name: r.name, branch: r.defaultBranchRef?.name || 'main' }));
}

function getPagesInfo(repo) {
  const r = gh(['api', `repos/${GH_USER}/${repo}/pages`]);
  if (r.code === 0) {
    try { return JSON.parse(r.stdout); } catch { return null; }
  }
  return null;
}

function enablePages(repo, branch) {
  // Uses the "Create a GitHub Pages site" REST endpoint
  return gh(['api', '-X', 'POST', `repos/${GH_USER}/${repo}/pages`,
    '-f', `source[branch]=${branch}`,
    '-f', 'source[path]=/',
  ]);
}

// Quick repo content probe — does it have an index.html or common html at root?
function hasHtml(repo, branch) {
  const r = gh(['api', `repos/${GH_USER}/${repo}/git/trees/${branch}?recursive=0`]);
  if (r.code !== 0) return false;
  try {
    const j = JSON.parse(r.stdout);
    return (j.tree || []).some(e => e.type === 'blob' && /\.html?$/i.test(e.path));
  } catch { return false; }
}

(async () => {
  const repos = listOwnRepos();
  console.log(`${repos.length} public repos under ${GH_USER}. Probing each for HTML and Pages status…\n`);

  const results = { enabled: [], already: [], skipped_no_html: [], failed: [] };
  // Only act on repos that look like they came from this registry OR have html content.
  // Avoid disturbing unrelated older repos (awesome-*, turnerworks, etc.)
  const REGISTRY_SLUGS = new Set([
    'ai-whack', 'alexa-puck', 'beatyourselfup', 'binman', 'brain-sim', 'claude-home-hub',
    'claude-v1', 'donner-pad', 'fos', 'html-editor', 'laurence-bring', 'laurence-lens',
    'laurence-lenz', 'laurence-maia', 'laurence-see-ahead', 'laurence-voice-control',
    'laurence-watchers', 'laurence-windows-chatbot', 'laurence-wispr', 'lawrence-move-in',
    'lawrence-niggly', 'localhost-phonebook', 'mere-mortal', 'movie-magic', 'my-react-app',
    'org-sim', 'personal-ai-system', 'sandra', 'sentinel-bar', 'super-canvas-app',
    'task-manager-game', 'voice-commander', 'wait-buddy', 'wifi-sentinel',
  ]);

  for (const { name, branch } of repos) {
    if (!REGISTRY_SLUGS.has(name)) continue;

    const info = getPagesInfo(name);
    if (info && info.html_url) {
      results.already.push({ name, url: info.html_url });
      console.log(`  EXISTS  ${name.padEnd(28)} → ${info.html_url}`);
      continue;
    }

    if (!hasHtml(name, branch)) {
      results.skipped_no_html.push({ name });
      console.log(`  SKIP    ${name.padEnd(28)} (no HTML at root)`);
      continue;
    }

    const r = enablePages(name, branch);
    if (r.code === 0) {
      const url = `https://${GH_USER}.github.io/${name}/`;
      results.enabled.push({ name, url, branch });
      console.log(`  ENABLED ${name.padEnd(28)} → ${url}`);
    } else {
      const msg = (r.stderr || r.stdout).split('\n')[0].slice(0, 120);
      results.failed.push({ name, error: msg });
      console.log(`  FAIL    ${name.padEnd(28)} ${msg}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Already on Pages :', results.already.length);
  console.log('Enabled now      :', results.enabled.length);
  console.log('Skipped (no HTML):', results.skipped_no_html.length);
  console.log('Failed           :', results.failed.length);

  fs.writeFileSync(path.join(__dirname, 'pages-map.json'), JSON.stringify({
    pages: Object.fromEntries([...results.already, ...results.enabled].map(r => [r.name, r.url])),
    skipped: results.skipped_no_html.map(r => r.name),
    failed: results.failed,
  }, null, 2));
  console.log('Wrote pages-map.json');
})();
