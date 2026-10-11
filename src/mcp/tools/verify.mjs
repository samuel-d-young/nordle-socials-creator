// Tools for checking your own work before the owner sees it: run the scripts, look at the pictures against the words, record your
// judgement, get the independent reviewer's packet, and ask what is still missing.

const CHECK_NAMES = ['technical', 'design', 'copy', 'compliance', 'facts', 'media-match', 'uniqueness', 'brief', 'speech-cuts', 'broll', 'audio'];
const MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skipped: 'SKIPPED' };

function findingLines(findings, max = 30) {
  const lines = [];
  for (const f of findings.slice(0, max)) {
    const where = [f.page && `page ${f.page}`, f.layer, f.media, Number.isFinite(f.time) && `${Number(f.time).toFixed(1)}s`].filter(Boolean).join(' / ');
    lines.push(`  - ${f.level}${f.rule ? ` ${f.rule}` : ''}${where ? ` [${where}]` : ''}: ${f.message}`);
    if (f.fix) lines.push(`      fix: ${f.fix}`);
  }
  if (findings.length > max) lines.push(`  ... and ${findings.length - max} more`);
  return lines;
}

function gateLines(g) {
  const lines = [];
  lines.push(g.verified ? 'VERIFIED: every required check has passed at this version, by the people it needs.' : 'NOT VERIFIED yet. Do not tell the owner this post is ready.');
  for (const m of g.failed ?? []) lines.push(`  failed:  ${m}`);
  for (const m of g.missing ?? []) lines.push(`  missing: ${m}`);
  if (g.stale?.length) lines.push(`  stale (made on an older version of the post, so they do not count): ${g.stale.join(', ')}`);
  for (const n of g.next ?? []) lines.push(`  next:    ${n}`);
  return lines;
}

export default function verifyTools(client, { P, D, READ, EDIT, enc }) {
  const base = (a) => `/projects/${enc(a.project)}/checks/${enc(a.doc)}`;
  return [
    {
      name: 'nordle_verify_post',
      description: 'Run the automatic checks on a post, the first of three layers of checking: technical (cut-off text, contrast, safe zones), design score, copy (hook, one call to action, hashtags, alt text, cut-off sentences), compliance (the project’s wording packs, for example AHPRA rules for a dental practice, over EVERY text: caption, hashtags, alt text, each text layer, spoken words), facts (every phone, web address, price, name and title must come from facts.json), media-match (each picture has a catalog entry and the words fit it), uniqueness (no repeated photo, hook or caption in the month), and for video speech cuts, B-roll and sound. Every finding says exactly what to fix. Results are recorded as the "auto" checks. Run it after every change and fix errors before you say a post is done.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, only: { type: 'array', items: { type: 'string', enum: CHECK_NAMES }, description: 'Run only these checks (default: all that apply).' } }, required: ['project', 'doc'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(base(a), { only: a.only });
        const lines = [`CHECKED "${r.doc.id}" at version ${r.version}: ${r.counts.pass} passed, ${r.counts.warn} warned, ${r.counts.fail} failed${r.counts.skipped ? `, ${r.counts.skipped} skipped` : ''}.`];
        for (const c of r.checks) {
          lines.push(`${MARK[c.status] ?? c.status} ${c.check}: ${c.summary}`);
          lines.push(...findingLines(c.findings.filter((f) => f.level !== 'info' || c.status === 'fail')));
        }
        if (r.packs?.length) lines.push('', `Wording packs used: ${r.packs.map((p) => `${p.name} ${p.version}`).join('; ')}. ${r.packs.map((p) => p.disclaimer).filter(Boolean)[0] ?? ''}`);
        lines.push('', ...gateLines(r.gate));
        lines.push('', 'Next: fix every error, run this again, then look at the pictures against the words (nordle_verify_media) and record your judgement (nordle_record_check).');
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'nordle_verify_media',
      description: 'Check that what the post SAYS is true of what it SHOWS. Returns a table with, for each picture or clip, the words attached to it (headline, body, alt text, the caption sentence that names it) beside what the catalog says it shows, with the script’s verdict (match, mismatch, unsure), AND the actual pictures so you can look at them. Look at each image yourself before you trust the table: you are the designer and must say what you really see. Mismatches mean the words or the picture must change. Then record your judgement with nordle_record_check (check media-match, by designer) with a verdict for every picture.',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: ['project', 'doc'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${base(a)}/media`, {});
        const lines = [`Pictures and words for "${r.doc}" (version ${r.version}). ${r.images.length} image${r.images.length === 1 ? '' : 's'} follow. Look at each one.`, ''];
        for (const p of r.pairs) {
          lines.push(`- ${p.page ? `page/clip "${p.page}"` : 'picture'}${p.time !== undefined ? ` at ${p.time}s` : ''}  ${p.media}`);
          lines.push(`    words: ${p.words}`);
          lines.push(`    catalog says it shows: ${p.shows}`);
          lines.push(`    script verdict: ${p.verdict.toUpperCase()}${p.note ? ` — ${p.note}` : ''}`);
        }
        if (!r.pairs.length) lines.push('(no picture has words to compare with)');
        if (r.skipped?.length) lines.push('', `Not compared: ${r.skipped.join('; ')}`);
        if (r.findings.length) lines.push('', 'Problems found:', ...findingLines(r.findings));
        lines.push('', 'The script is careful: "match" needs words in common with the catalog and "mismatch" only a clear contradiction, so most pairs are "unsure". The judgement is yours. For each picture say what you see and whether the words tell the truth about it.');
        return { text: lines.join('\n'), images: r.images.map((i) => ({ base64: i.base64, mime: i.mime })) };
      },
    },
    {
      name: 'nordle_record_check',
      description: 'Record an explicit judgement about a check, as the designer (you, who built the post, after looking at the pictures) or as the independent reviewer (a different Claude working only from the reviewer packet). A bare "pass" is refused: say in the summary what you looked at and found. For media-match and broll give a pair for every picture with what you actually see in "shows" and a verdict (match, mismatch, unsure); a pass needs every verdict to be "match". A mismatch means status fail. The reviewer’s record is only accepted once the packet for this version of the post exists (nordle_review_packet).',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D,
          check: { type: 'string', enum: CHECK_NAMES, description: 'Which check you are judging.' },
          by: { type: 'string', enum: ['designer', 'reviewer'], description: 'designer = you, who built it; reviewer = an independent Claude using the packet.' },
          status: { type: 'string', enum: ['pass', 'warn', 'fail'] },
          summary: { type: 'string', description: 'What you looked at and what you found, in a sentence or two.' },
          pairs: {
            type: 'array', description: 'media-match / broll: one entry per picture or cutaway.',
            items: { type: 'object', properties: { page: { type: 'string' }, time: { type: 'number' }, media: { type: 'string' }, words: { type: 'string' }, shows: { type: 'string', description: 'What you actually see, in your own words.' }, verdict: { type: 'string', enum: ['match', 'mismatch', 'unsure'] }, note: { type: 'string' } }, required: ['media', 'verdict'], additionalProperties: false },
          },
          findings: { type: 'array', items: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warn', 'info'] }, message: { type: 'string' }, fix: { type: 'string' }, page: { type: 'string' }, media: { type: 'string' }, time: { type: 'number' } }, required: ['message'], additionalProperties: false } },
        },
        required: ['project', 'doc', 'check', 'by', 'status', 'summary'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        try {
          const r = await client.post(`${base(a)}/record`, { check: a.check, by: a.by, status: a.status, summary: a.summary, pairs: a.pairs, findings: a.findings });
          return { text: [`RECORDED ${r.entry.check} by ${r.entry.by}: ${r.entry.status} (version ${r.entry.v}).`, ...gateLines(r.gate)].join('\n') };
        } catch (e) {
          return { isError: true, text: `NOT RECORDED.\n${e.message}` };
        }
      },
    },
    {
      name: 'nordle_review_packet',
      description: 'Build the reviewer packet for a post: a self-contained document with the rendered pages (or stills from the video at each cut and B-roll moment), the words on each, the caption, what the catalog says each picture shows, the facts list, the brief, other posts this month, and an exact list of questions. Give its path to a DIFFERENT Claude (one that did not build the post and has no memory of it) so it can open the images and judge from scratch, then record its answers with nordle_record_check (by reviewer). Returns the packet text and the images.',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: ['project', 'doc'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${base(a)}/packet`, {});
        const lines = [`Reviewer packet written to ${r.path} (version ${r.version}, ${r.imagePaths.length} image${r.imagePaths.length === 1 ? '' : 's'}).`, 'Image files to open:', ...r.imagePaths.map((i) => `  ${i.path}   (${i.label})`), '',
          'Hand the packet to a fresh Claude that did not build this post (for example a new session or a subagent that has not seen your work), and tell it: "Read the packet, open every image, answer every question, and record your answers with nordle_record_check, by reviewer." Do not answer it yourself.', '', '--- PACKET ---', r.markdown];
        return { text: lines.join('\n'), images: r.images.map((i) => ({ base64: i.base64, mime: i.mime })) };
      },
    },
    {
      name: 'nordle_finish',
      description: 'Ask whether a post is verified and what is still missing: the three layers are the automatic scripts, your own recorded judgement as designer, and the independent reviewer. Lists each required check that has not been done or has failed at the post’s current version, and what to do next. Give no doc to see every post in the project. A post is only ready to show the owner when this says VERIFIED.',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: ['project'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        if (!a.doc) {
          const r = await client.get(`/projects/${enc(a.project)}/checks`);
          const lines = r.docs.map((d) => `${d.verified ? 'VERIFIED    ' : 'NOT VERIFIED'} ${d.id}${d.failed.length ? `  failed: ${d.failed.join(', ')}` : ''}${d.missing.length ? `  missing: ${d.missing.slice(0, 6).join(', ')}${d.missing.length > 6 ? ', ...' : ''}` : ''}`);
          return { text: `${r.docs.filter((d) => d.verified).length} of ${r.docs.length} posts verified.\n${lines.join('\n')}` };
        }
        const r = await client.get(base(a));
        const lines = [`"${a.doc}" at version ${r.gate.v}:`, ...gateLines(r.gate)];
        if (r.gate.entries?.length) { lines.push('', 'Recorded so far:'); for (const e of r.gate.entries) lines.push(`  ${e.check} by ${e.by}: ${e.status}${e.summary ? ` — ${e.summary.slice(0, 120)}` : ''}`); }
        return { text: lines.join('\n') };
      },
    },
  ];
}
