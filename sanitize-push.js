#!/usr/bin/env node
// sanitize-push.js — for projects blocked by GitHub secret-scanning, create a
// sanitized branch where hardcoded API keys are replaced with placeholders,
// push THAT branch only, and set it as the default. Local master stays intact.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TARGETS = [
  { dir: 'K:/Projects/alexa-puck',            slug: 'alexa-puck' },
  { dir: 'K:/Projects/laurence windows chatbot', slug: 'laurence-windows-chatbot' },
];

const SECRET_PATTERNS = [
  { re: /sk-ant-api\d{2}-[A-Za-z0-9_\-]{60,}/g, placeholder: 'YOUR_ANTHROPIC_API_KEY' },
  { re: /sk-ant-[A-Za-z0-9_\-]{40,}/g,          placeholder: 'YOUR_ANTHROPIC_API_KEY' },
  { re: /sk-[A-Za-z0-9]{30,}/g,                 placeholder: 'YOUR_OPENAI_API_KEY' },
  { re: /AIza[0-9A-Za-z_\-]{35}/g,              placeholder: 'YOUR_GOOGLE_API_KEY' },
];

const SCAN_EXTENSIONS = new Set(['.html','.htm','.py','.pyw','.js','.mjs','.ts','.json','.env','.md','.txt','.sh','.ps1','.bat']);

function run(cwd, cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  if (!capture && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exit ${r.status}\n${r.stderr || r.stdout}`);
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function walkFiles(dir, out = []) {
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', 'venv', '.venv', 'target']);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (SCAN_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

async function sanitizeAndPush({ dir, slug }) {
  console.log(`\n=== ${slug} @ ${dir} ===`);
  if (!fs.existsSync(dir)) { console.log('  SKIP path missing'); return; }

  // Pre-check: how many secrets are there, where
  const files = walkFiles(dir);
  const hits = [];
  for (const f of files) {
    let body;
    try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const { re } of SECRET_PATTERNS) {
      const matches = body.match(re);
      if (matches) hits.push({ file: path.relative(dir, f), count: matches.length, sample: matches[0].slice(0, 12) + '...' });
    }
  }
  if (hits.length === 0) { console.log('  no secrets detected — nothing to sanitize'); return; }
  console.log(`  found ${hits.length} secret-containing files:`);
  hits.forEach(h => console.log(`    - ${h.file} (${h.count}× ${h.sample})`));

  // Commit current state on master first if dirty (snapshots working tree)
  run(dir, 'git', ['add', '-A'], { capture: true });
  const dirty = run(dir, 'git', ['status', '--porcelain'], { capture: true });
  if (dirty.stdout.trim()) {
    run(dir, 'git', ['commit', '-m', 'local working state (contains secrets — not for push)'], { capture: true });
  }

  // Remember master HEAD so we can restore working tree after
  const masterHead = run(dir, 'git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();

  // Create an ORPHAN branch (no shared history with master — GitHub's secret
  // scanner refuses to push any branch whose ancestors still contain the secret)
  run(dir, 'git', ['checkout', '--orphan', 'public'], { capture: true });
  // Clear the index — working tree still has master's files visible
  run(dir, 'git', ['rm', '-rf', '--cached', '.'], { capture: true });

  // Sanitize in-place on disk
  let replacedCount = 0;
  for (const f of files) {
    let body;
    try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let changed = body;
    for (const { re, placeholder } of SECRET_PATTERNS) {
      changed = changed.replace(re, placeholder);
    }
    if (changed !== body) {
      fs.writeFileSync(f, changed);
      replacedCount++;
    }
  }
  console.log(`  sanitized ${replacedCount} files → orphan 'public' branch`);

  // Write a NOTICE at the repo root
  fs.writeFileSync(path.join(dir, 'PUBLIC_NOTICE.md'),
    `# Public Mirror\n\nThis branch is a public-sanitized mirror. Hardcoded API keys have been replaced with placeholder strings (e.g. \`YOUR_ANTHROPIC_API_KEY\`).\n\nTo run locally, set the key in a \`.env\` file or environment variable.\n`);

  run(dir, 'git', ['add', '-A']);
  run(dir, 'git', ['commit', '-m', 'Sanitized public branch — API keys replaced with placeholders']);

  // Ensure origin points at the GitHub repo
  const hasOrigin = run(dir, 'git', ['remote'], { capture: true }).stdout.includes('origin');
  if (!hasOrigin) {
    run(dir, 'git', ['remote', 'add', 'origin', `https://github.com/lozturner/${slug}.git`]);
  }

  // Push the sanitized public branch
  const push = run(dir, 'git', ['push', '-u', '--force', 'origin', 'public'], { capture: true });
  if (push.code !== 0) {
    console.log('  PUSH FAILED:\n' + push.stderr.split('\n').slice(0, 10).join('\n'));
    // Restore master and bail
    run(dir, 'git', ['checkout', 'master'], { capture: true });
    run(dir, 'git', ['branch', '-D', 'public'], { capture: true });
    return;
  }

  // Set 'public' as the default branch on GitHub so HEAD and ZIP resolve there
  run(dir, 'gh', ['repo', 'edit', `lozturner/${slug}`, '--default-branch', 'public'], { capture: true });

  // Restore master locally (so working copy still has real secrets for Laurence)
  run(dir, 'git', ['checkout', '-f', 'master'], { capture: true });
  run(dir, 'git', ['reset', '--hard', masterHead], { capture: true });
  // Clean any leftover NOTICE file that doesn't belong on master
  try { fs.unlinkSync(path.join(dir, 'PUBLIC_NOTICE.md')); } catch {}

  console.log(`  OK pushed public branch → https://github.com/lozturner/${slug} (default=public)`);
}

(async () => {
  for (const t of TARGETS) {
    try { await sanitizeAndPush(t); }
    catch (e) { console.log(`  FAIL ${t.slug}: ${e.message.split('\n')[0]}`); }
  }
})();
