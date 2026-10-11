// Cut tools: see the transcript of a recording with what is kept and what is cut, and cut words out of the video (or bring them back).
// The edit is an ordinary patch (baseVersion, Claude as the actor), so the owner's autonomy setting and locks apply as for any edit.

import { applyOps } from '../../shared/ops.mjs';
import { CutError, removeWordsInfo, restoreWordsInfo, totalDuration } from '../../shared/cutlist.mjs';
import { cutOverview, clock, formatOverview } from '../../video/cutwords.mjs';

export default (client, h) => {
  const { P, D, READ, EDIT, enc, load, patch, NordleError } = h;
  const route = (a) => client.post(`/projects/${enc(a.project)}/cut/words`, { doc: a.doc, source: a.source, track: a.track });
  const SOURCE = { type: 'string', description: 'The source to cut (its id in the document). Default: the source the captions follow, else the first source with a transcript.' };
  const TRACK = { type: 'string', description: 'The track that plays it. Default: the first video track that plays the source.' };
  return [
    {
      name: 'nordle_cut_list',
      description: 'The transcript of a recording as a numbered list with what the video keeps and what it cuts, and how long the video is. Read it before cutting: each line starts with its word numbers (first-last), then where it starts in the video, then the words; [cut] lines are cut out. Use the word numbers with nordle_cut_words.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, source: SOURCE, track: TRACK, all: { type: 'boolean', description: 'List every word as index:word instead of a line per sentence (to cut part of a sentence).' } }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await route(a);
        const ov = cutOverview((await load(client, a)).doc, { track: r.track, source: r.source }, r.words);
        return { text: formatOverview(ov, { all: a.all }) };
      },
    },
    {
      name: 'nordle_cut_words',
      description: 'Cut words out of the video, or bring them back. "from" and "to" are word numbers from nordle_cut_list (inclusive; one word: the same number twice). The cut never lands inside a word: it starts in the quiet after the word before and ends in the quiet before the word after, on whole frames. By default the video closes up (ripple): later clips, titles and scenes move earlier, and sound that plays the same recording is cut the same way so picture and sound stay together. With restore:true the words are put back where they were. Read the result: it says how long the video is now. Then look at the cut with nordle_video_check and nordle_video_stills.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, source: SOURCE, track: TRACK,
          from: { type: 'integer', minimum: 0, description: 'First word number.' },
          to: { type: 'integer', minimum: 0, description: 'Last word number (inclusive).' },
          restore: { type: 'boolean', description: 'true = bring these words back instead of cutting them.' },
          ripple: { type: 'boolean', description: 'Close up the gap (default true). false leaves a gap where the words were.' },
          note: { type: 'string', description: 'A few words on why, shown to the owner.' },
        },
        required: ['project', 'doc', 'from', 'to'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const r = await route(a);
        const run = a.restore ? restoreWordsInfo : removeWordsInfo;
        let info;
        try { info = run(d.doc, { track: r.track, source: r.source }, r.words, a.from, a.to, { ripple: a.ripple !== false }); } catch (e) {
          if (e instanceof CutError) throw new NordleError(e.message, 0);
          throw e;
        }
        const said = r.words.slice(a.from, a.to + 1).map((w) => w.text).join(' ');
        const quote = said.length > 80 ? `${said.slice(0, 77)}...` : said;
        if (!info.ops.length) return { text: `Nothing to change: words ${a.from}-${a.to} ("${quote}") ${a.restore ? 'are already in the video' : 'are already cut out'}.` };
        const before = totalDuration(d.doc);
        const after = totalDuration(applyOps(d.doc, info.ops).doc);
        const res = await patch(client, a, d, info.ops, a.note ?? `${a.restore ? 'Bring back' : 'Cut'} words ${a.from}-${a.to}`);
        const moved = a.restore ? info.restored : info.removed;
        const lines = [
          `${a.restore ? 'Brought back' : 'Cut'} words ${a.from}-${a.to} ("${quote}"): ${moved.toFixed(2)} s ${a.restore ? 'put back' : 'taken out'} (source ${clock(info.from)} to ${clock(info.to)}).`,
          `The video is ${after.toFixed(2)} s long${after === before ? '' : ` (was ${before.toFixed(2)} s)`} once this is applied.`,
          ...info.notes,
          res.text,
        ];
        return { text: lines.join('\n') };
      },
    },
  ];
};
