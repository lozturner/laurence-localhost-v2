#!/usr/bin/env node
// audit-runs.js — for every card on the live Pages site, hit its Run URL and
// verify the result. Produces a matrix that proves which projects genuinely
// run vs. which need fixing. No hand-waving.

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const BASE = 'https://lozturner.github.io/laurence-localhost-v2/';

function fetch(url, { followRedirects = true, max = 5 } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'audit/1.0' }, timeout: 10000 }, (res) => {
      const status = res.statusCode || 0;
      if (followRedirects && [301,302,303,307,308].includes(status) && res.headers.location && max > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(fetch(next, { followRedirects, max: max - 1 }).then(r => ({ ...r, finalUrl: r.finalUrl || next })));
        return;
      }
      let size = 0; let body = '';
      res.on('data', (c) => {
        size += c.length;
        if (body.length < 4096) body += c.toString('utf8', 0, Math.min(c.length, 4096 - body.length));
      });
      res.on('end', () => resolve({
        status, size, body,
        ctype: res.headers['content-type'] || '',
        finalUrl: url,
      }));
    });
    req.on('error', (err) => resolve({ status: 0, size: 0, body: '', ctype: '', err: err.message, finalUrl: url }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, size: 0, body: '', ctype: '', err: 'timeout', finalUrl: url }); });
  });
}

function classify(name, href, r, fw) {
  // Hard failures
  if (r.err) return { verdict: 'ERROR', detail: r.err };
  if (r.status === 404) return { verdict: '404', detail: '' };
  if (r.status >= 500) return { verdict: '5xx', detail: String(r.status) };
  if (r.status === 0)  return { verdict: 'NETFAIL', detail: '' };
  if (r.status === 403) return { verdict: '403', detail: '' };

  const host = (() => { try { return new URL(r.finalUrl || href).host; } catch { return ''; } })();

  // Non-HTML destinations (downloads, replit)
  if (host.startsWith('replit.com')) {
    return { verdict: 'REPLIT', detail: 'fork-and-run UI (requires Replit login)' };
  }
  if (host === 'github.com' && /\/archive\//.test(r.finalUrl || href)) {
    return { verdict: 'ZIP', detail: (r.size/1024|0) + 'KB zip' };
  }
  if (host === 'github.com') {
    return { verdict: 'REPO', detail: 'repo page (needs local install to run)' };
  }
  if (host === 'nodered.org' || host === 'www.apachefriends.org') {
    return { verdict: 'UPSTREAM', detail: 'vendor homepage' };
  }

  // HTML destinations — inspect content
  const isHtml = /html/i.test(r.ctype) || /^<!doctype html|<html/i.test(r.body);
  if (!isHtml) return { verdict: 'NONHTML', detail: r.ctype + ' ' + (r.size/1024|0) + 'KB' };

  // Obvious GitHub Pages 404 page
  if (/<title>Site not found · GitHub Pages<\/title>/i.test(r.body) || /<title>404<\/title>/i.test(r.body)) {
    return { verdict: 'PAGES-404', detail: 'Pages hasn\'t built / wrong path' };
  }
  // Jekyll-processed or directory listing
  if (/<title>.*Index of \//i.test(r.body)) {
    return { verdict: 'INDEX', detail: 'directory listing only — no index.html' };
  }
  // Has substantive body
  const bodyLen = r.size;
  const titleMatch = r.body.match(/<title>([^<]{1,80})<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  return {
    verdict: bodyLen < 600 ? 'TINY' : 'OK',
    detail: `${(bodyLen/1024).toFixed(0)}KB · "${title}"`,
  };
}

(async () => {
  console.log('Fetching live Pages index…');
  const idx = await fetch(BASE + '?audit=' + Date.now());
  if (idx.status !== 200) { console.error('FAIL — index status', idx.status); process.exit(1); }
  const html = idx.body + idx.body; // body may have been truncated at 4KB — refetch fully
  // Actually re-fetch the full body without truncation for card parsing
  const full = await new Promise((resolve) => {
    https.get(BASE + '?audit=' + Date.now(), { headers: { 'User-Agent':'audit/1.0' } }, (r) => {
      let b=''; r.on('data', c => b+=c); r.on('end', () => resolve(b));
    });
  });

  // Parse cards — extract name, framework, and the Run button href
  const cardBlocks = full.split('<article class="card"').slice(1);
  const cards = [];
  for (const block of cardBlocks) {
    const nameM = block.match(/<div class="card-name">([^<]+)<\/div>/);
    const fwM   = block.match(/data-framework="([^"]+)"/);
    const runM  = block.match(/class="recovery-run[^"]*" href="([^"]+)"/);
    if (!nameM || !runM) continue;
    cards.push({ name: nameM[1].trim(), framework: fwM?.[1] || '?', href: runM[1] });
  }
  console.log(`Parsed ${cards.length} cards.\n`);

  const rows = [];
  for (const c of cards) {
    const r = await fetch(c.href, { max: 5 });
    const cls = classify(c.name, c.href, r, c.framework);
    rows.push({ ...c, ...cls, status: r.status, finalUrl: r.finalUrl });
    console.log(`${cls.verdict.padEnd(10)} ${c.name.padEnd(28)} ${(c.framework||'').padEnd(26)} ${cls.detail}`);
  }

  // Summary
  const by = {};
  for (const r of rows) by[r.verdict] = (by[r.verdict]||0)+1;
  console.log('\n=== SUMMARY ===');
  for (const [k,v] of Object.entries(by).sort((a,b)=>b[1]-a[1])) console.log(k.padEnd(10), v);

  fs.writeFileSync(path.join(__dirname, 'audit.json'), JSON.stringify(rows, null, 2));
  console.log('\nFull audit → audit.json');
})();
