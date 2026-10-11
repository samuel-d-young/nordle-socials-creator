// Checking a post's work before the owner sees it.
//   node nordle.mjs check  <project> <doc|--all> [--json] [--only a,b] [--no-render]   run the automatic checks (layer 1)
//   node nordle.mjs packet <project> <doc>                                              build the reviewer's packet (layer 3)
//   node nordle.mjs record <project> <doc> --check media-match --by designer --status pass --summary "..." [--pairs file.json]
//   node nordle.mjs finish <project> <doc|--all>                                       what is missing or failing; exit 1 if not verified

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';

const VALUE_FLAGS = new Set(['check', 'by', 'status', 'summary', 'pairs', 'findings', 'only']);

function parse(args) {
  const o = { _: [], flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (VALUE_FLAGS.has(k)) o[k] = args[++i]; else o.flags.add(k);
  }
  return o;
}

function projectDirOf(arg) {
  if (!arg) return null;
  for (const p of [resolve(arg), join(ROOT, 'projects', arg)]) if (existsSync(join(p, 'brand.json'))) return p;
  return null;
}

const readJsonFile = (f) => JSON.parse(readFileSync(resolve(f), 'utf8'));
const MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' };

function printResult(r, { verbose = true } = {}) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.doc.id} (${r.doc.kind}) version ${r.v}: ${r.counts.pass} passed, ${r.counts.warn} warned, ${r.counts.fail} failed${r.counts.skipped ? `, ${r.counts.skipped} skipped` : ''}`);
  for (const c of Object.values(r.results)) {
    console.log(`     ${MARK[c.status] ?? c.status} ${c.check.padEnd(12)} ${c.summary}`);
    if (!verbose) continue;
    const shown = c.findings.filter((f) => f.level !== 'info' || c.status === 'fail');
    for (const f of shown.slice(0, 25)) {
      const where = [f.page && `page ${f.page}`, f.layer, f.media, Number.isFinite(f.time) && `${f.time.toFixed(1)}s`].filter(Boolean).join(' / ');
      console.log(`           ${f.level.padEnd(5)} ${f.rule ?? ''}${where ? ` [${where}]` : ''}: ${f.message}`);
      if (f.fix) console.log(`                 fix: ${f.fix}`);
    }
    if (shown.length > 25) console.log(`           ... and ${shown.length - 25} more`);
    if (c.pairs?.length && (c.check === 'media-match' || c.check === 'broll')) {
      for (const p of c.pairs.slice(0, 12)) console.log(`           pair ${p.verdict.padEnd(8)} ${p.page ?? ''}${p.time !== undefined ? ` ${p.time}s` : ''} ${p.media}`);
    }
  }
}

const usage = (u) => { console.error(`Usage: node nordle.mjs ${u}`); return 2; };

export default [
  {
    name: 'check',
    usage: 'check <project> <doc|--all> [--json] [--only a,b]',
    summary: 'run the automatic checks on a post (wording, facts, pictures, speech cuts, B-roll, sound)',
    async run(args) {
      const o = parse(args);
      const dir = projectDirOf(o._[0]);
      if (!dir) return usage('check <project folder> <doc id | --all> [--json] [--only technical,copy,...] [--no-render]');
      const { checkPost, docIds } = await import('../verify/run.mjs');
      const ids = o.flags.has('all') ? docIds(dir) : o._.slice(1);
      if (!ids.length) return usage('check <project folder> <doc id | --all>');
      const needsBrowser = !o.flags.has('no-render');
      const browser = needsBrowser ? await (await import('../render/browser.mjs')).openBrowser().catch(() => null) : null;
      const out = [];
      let failed = false;
      try {
        for (const id of ids) {
          let r;
          try { r = await checkPost(dir, id, { browser: browser ?? undefined, only: o.only?.split(','), skipRender: !browser }); } catch (e) { console.error(`${id}: ${e.message}`); failed = true; continue; }
          out.push(r);
          if (!r.ok) failed = true;
          if (!o.flags.has('json')) printResult(r);
        }
      } finally { await browser?.close(); }
      if (o.flags.has('json')) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
      return failed ? 1 : 0;
    },
  },
  {
    name: 'packet',
    usage: 'packet <project> <doc>',
    summary: 'write the packet an independent reviewer uses to re-judge a post from scratch',
    async run(args) {
      const o = parse(args);
      const dir = projectDirOf(o._[0]);
      if (!dir || !o._[1]) return usage('packet <project folder> <doc id>');
      const { reviewerPacket } = await import('../verify/run.mjs');
      const browser = await (await import('../render/browser.mjs')).openBrowser().catch(() => null);
      try {
        const p = await reviewerPacket(dir, o._[1], { browser: browser ?? undefined });
        console.log(`WROTE ${p.path}`);
        console.log(`     ${p.images.length} image${p.images.length === 1 ? '' : 's'} to open:`);
        for (const i of p.images) console.log(`     ${i.path}`);
        console.log('Give this file to a fresh Claude (one that did not build the post) and ask it to read the packet, open every image, and record its answers with --by reviewer.');
        return 0;
      } finally { await browser?.close(); }
    },
  },
  {
    name: 'record',
    usage: 'record <project> <doc> --check <c> --by designer|reviewer --status pass|warn|fail --summary "..." [--pairs file.json]',
    summary: 'record the designer’s or the reviewer’s explicit judgement of a check',
    async run(args) {
      const o = parse(args);
      const dir = projectDirOf(o._[0]);
      if (!dir || !o._[1] || !o.check || !o.by || !o.status) return usage('record <project folder> <doc id> --check media-match --by designer --status pass --summary "what you saw" [--pairs file.json] [--findings file.json]');
      const { recordManual } = await import('../verify/run.mjs');
      let pairs; let findings;
      try {
        if (o.pairs) pairs = readJsonFile(o.pairs);
        if (o.findings) findings = readJsonFile(o.findings);
      } catch (e) { console.error(`Could not read the file: ${e.message}`); return 2; }
      if (pairs && !Array.isArray(pairs)) pairs = pairs.pairs;
      const r = recordManual(dir, o._[1], { check: o.check, by: o.by, status: o.status, summary: o.summary, pairs, findings });
      if (!r.ok) { console.log('NOT RECORDED'); for (const e of r.errors) console.log(`     ${e}`); return 1; }
      console.log(`RECORDED ${r.entry.check} by ${r.entry.by}: ${r.entry.status} (version ${r.entry.v})`);
      console.log(r.gate.verified ? '     This post is now verified.' : `     Still to do: ${[...r.gate.missing, ...r.gate.failed.map((f) => `${f} FAILED`)].join('; ')}`);
      return r.entry.status === 'fail' ? 1 : 0;
    },
  },
  {
    name: 'finish',
    usage: 'finish <project> <doc|--all>',
    summary: 'say what is still missing or failing before a post can be shown to the owner',
    async run(args) {
      const o = parse(args);
      const dir = projectDirOf(o._[0]);
      if (!dir) return usage('finish <project folder> <doc id | --all>');
      const { finishGate, docIds } = await import('../verify/run.mjs');
      const ids = o.flags.has('all') ? docIds(dir) : o._.slice(1);
      if (!ids.length) return usage('finish <project folder> <doc id | --all>');
      let bad = false;
      const all = [];
      for (const id of ids) {
        let g;
        try { g = finishGate(dir, id); } catch (e) { console.error(`${id}: ${e.message}`); bad = true; continue; }
        all.push(g);
        if (!g.verified) bad = true;
        if (o.flags.has('json')) continue;
        console.log(`${g.verified ? 'VERIFIED    ' : 'NOT VERIFIED'} ${id} (version ${g.v})`);
        for (const m of g.failed) console.log(`     failed:  ${m}`);
        for (const m of g.missing) console.log(`     missing: ${m}`);
        for (const m of g.warned ?? []) console.log(`     NOTE:    ${m}`);
        if (g.stale.length) console.log(`     stale (made on an older version of the post, so they do not count): ${g.stale.join(', ')}`);
        for (const n of g.next) console.log(`     next:    ${n}`);
      }
      if (o.flags.has('json')) console.log(JSON.stringify(all.length === 1 ? all[0] : all, null, 2));
      else if (ids.length > 1) console.log(`\n${all.filter((g) => g.verified).length} of ${ids.length} posts verified.`);
      return bad ? 1 : 0;
    },
  },
];
