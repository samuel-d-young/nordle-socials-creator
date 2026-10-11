// Video tools: render a reel, look at it without rendering, check the cut, find footage. Names start with nordle_.

const SIZE = { type: 'string', description: 'Size id (for example ig-reel-9x16). Default: the first video size of the post.' };

const secs = (n) => `${Number(n.toFixed(2))}s`;

function describeIssues(issues = []) {
  if (!issues.length) return 'Nothing to fix.';
  return issues.map((i) => `[${i.level}] ${i.code}: ${i.message}`).join('\n');
}

function describeJob(job) {
  const lines = [];
  if (job.kind && job.kind !== 'render') return `${job.status.toUpperCase()}: ${job.kind} job ${job.id}, ${job.percent}%${job.error ? ` (${job.error})` : ''}. This tool follows renders; a ${job.kind} job is not one.`;
  if (job.status === 'running') {
    lines.push(`RUNNING: job ${job.id}, ${job.percent}% (${job.stage}: ${job.message}), ${job.seconds}s so far.`);
    lines.push('Ask again with nordle_video_status (it can wait up to a minute for news).');
    return lines.join('\n');
  }
  if (job.status === 'cancelled') return `CANCELLED: job ${job.id}.`;
  if (job.status === 'failed') {
    lines.push(`FAILED: job ${job.id}.`);
    lines.push(job.error ?? 'The video could not be rendered.');
    if (job.result?.issues?.length) lines.push(describeIssues(job.result.issues));
    return lines.join('\n');
  }
  const r = job.result;
  const format = r.format ?? job.options.format ?? 'mp4';
  lines.push(`DONE in ${job.seconds}s${job.options.preview ? ' (quick preview, half size and half the frames)' : ''}.`);
  lines.push(`Video: ${r.files.video} (${format}${format === 'mp4' ? '' : ' export'}, ${r.output.width}x${r.output.height}, ${r.output.fps} fps, ${r.output.duration}s, ${r.output.audio ?? 'no audio'}, ${(r.output.bytes / 1e6).toFixed(1)} MB).`);
  if (r.files.cover) lines.push(`Cover: ${r.files.cover}`);
  if (r.files.sheet) lines.push(`Contact sheet: ${r.files.sheet} (attached): a few frames per scene with what is said in it.`);
  if (r.audio?.loudness) lines.push(`Sound: set to ${r.audio.loudness.target} LUFS (was ${r.audio.loudness.measuredBefore}).${r.audio.ducking?.length ? ` Music lowered under ${r.audio.ducking.map((d) => `"${d.under}" by ${Math.abs(d.amountDb)} dB`).join(', ')}.` : ''}`);
  if (r.captions) lines.push(`Captions: ${r.captions.lines} lines.`);
  lines.push('Problems found while planning and drawing:', describeIssues(r.issues));
  lines.push(r.files.sheet
    ? 'Next: look at the contact sheet and nordle_video_stills at the moments that matter (cuts, titles, the first and last second) before saying it is finished.'
    : 'Next: use nordle_video_stills (the plan\'s frames) or nordle_video_sheet to check the moments that matter (cuts, titles, the first and last second) before saying it is finished.');
  return lines.join('\n');
}

export default (client, h) => {
  const { P, D, READ, EDIT, enc, NordleError } = h;
  const path = (a, tail) => `/projects/${enc(a.project)}/video/${tail}`;
  return [
    {
      name: 'nordle_render_video',
      description: 'Render a video post to a file (picture from the timeline, titles and captions drawn on, sound mixed and set to -14 LUFS). It starts a job and returns a job id straight away; poll it with nordle_video_status. Use preview:true while you are still changing things (half size, half the frames, several times faster) and a full render once at the end. format: mp4 (default; H.264, what the platforms take), webm (VP9 and Opus), gif (15 fps, at most 540 px wide, no sound, at most 30 s: use from/to for a short clip) or prores (ProRes 422 HQ .mov for editing). Writes out/<post>/<post>.<mp4|webm|gif|mov>, and for everything but a GIF a cover image and sheet.png (a few frames per scene with the words said in them). Use from/to to render only part of the timeline. If this computer\'s ffmpeg lacks an encoder the format needs, the answer says which; mp4 always works.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, preview: { type: 'boolean', description: 'Quick, small render for checking.' }, from: { type: 'number', minimum: 0, description: 'Start second.' }, to: { type: 'number', minimum: 0, description: 'End second.' }, size: SIZE,
          format: { type: 'string', enum: ['mp4', 'webm', 'gif', 'prores'], description: 'File type. Default mp4.' },
          max_width: { type: 'number', minimum: 64, maximum: 4320, description: 'GIF only: widest the picture may be, in pixels (default 540).' },
        },
        required: ['project', 'doc'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(path(a, 'render'), { doc: a.doc, preview: a.preview, from: a.from, to: a.to, size: a.size, format: a.format, maxWidth: a.max_width });
        return { text: `${describeJob(r.job)}${r.job.status === 'running' ? `\nJob id: ${r.job.id}` : ''}` };
      },
    },
    {
      name: 'nordle_video_status',
      description: 'How a video render is going. Give the job id from nordle_render_video. It waits up to wait_seconds (default 30, at most 55) for the job to finish, so you can call it again straight away instead of guessing. When the job is done it attaches the contact sheet picture and lists the problems found (a speaker cut off, text under the platform buttons, a gap, a clip past the end of its footage).',
      inputSchema: { type: 'object', properties: { project: P, job: { type: 'string', description: 'Job id.' }, wait_seconds: { type: 'number', minimum: 0, maximum: 55 } }, required: ['project', 'job'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.get(`${path(a, `jobs/${enc(a.job)}`)}?wait=${Math.min(55, Math.max(0, a.wait_seconds ?? 30))}`);
        const out = { text: describeJob(r.job) };
        if (r.job.status === 'done' && r.job.result?.files?.sheet) {
          const sheet = await client.post(path(a, 'image'), { path: r.job.result.files.sheet }).catch(() => null);
          if (sheet?.base64) out.images = [{ base64: sheet.base64, mime: sheet.mime }];
        }
        return out;
      },
    },
    {
      name: 'nordle_video_stills',
      description: 'LOOK at your video without rendering it: real frames (the footage with titles and captions on top) at exactly the times you give, in seconds. Fast, so use it after every edit: check the first second (the hook), each cut (one frame just before and one just after), every title and caption position, and the last frame. Half size by default; pass scale 1 for full size. Up to 24 times per call. The text says which clip is on screen at each time.',
      inputSchema: {
        type: 'object',
        properties: { project: P, doc: D, times: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 1, maxItems: 24, description: 'Seconds on the timeline.' }, scale: { type: 'number', enum: [0.25, 0.35, 0.5, 0.75, 1], description: 'Default 0.5.' }, overlay: { type: 'boolean', description: 'false = the picture alone, without titles and captions.' }, size: SIZE },
        required: ['project', 'doc', 'times'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const r = await client.post(path(a, 'stills'), { doc: a.doc, times: a.times, scale: a.scale ?? 0.5, preview: false, overlay: a.overlay, size: a.size, format: 'jpg' });
        const lines = r.files.map((f, i) => `Image ${i + 1}: ${secs(f.time)} (frame ${f.frame}) shows "${f.shows}", ${f.w}x${f.h}.`);
        const problems = (r.issues ?? []).filter((i) => i.level !== 'info');
        return { text: `${lines.join('\n')}${problems.length ? `\nProblems in the plan:\n${describeIssues(problems)}` : ''}`, images: r.files.map((f) => ({ base64: f.base64, mime: f.mime })) };
      },
    },
    {
      name: 'nordle_video_sheet',
      description: 'A contact sheet of the whole video without rendering it: a few frames from every scene, the scene name and time, the clips it uses and the words said in it. Use it to judge the whole cut at a glance and to check that each cutaway makes sense for what is being said. Written to out/<post>/sheet.png.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, size: SIZE }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.post(path(a, 'sheet'), { doc: a.doc, size: a.size });
        const scenes = r.scenes.map((s) => `- ${s.title} ${secs(s.start)}-${secs(s.end)}: ${s.clips.join(', ')}${s.speech ? ` | says: "${s.speech}"` : ' | no speech'}`);
        return { text: `Contact sheet saved as ${r.path}.\n${scenes.join('\n')}\n${(r.issues ?? []).length ? `Problems:\n${describeIssues(r.issues.filter((i) => i.level !== 'info'))}` : 'No problems found in the plan.'}`, images: [{ base64: r.base64, mime: r.mime }] };
      },
    },
    {
      name: 'nordle_video_check',
      description: 'Check the cut without drawing anything (instant): clips past the end of their footage, overlapping clips, gaps that would be black, speakers cut off in the middle of a word or a sentence, titles under the platform buttons. Returns the segments the picture is made of. Run it after every change to the timeline.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, size: SIZE }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.post(path(a, 'check'), { doc: a.doc, size: a.size });
        if (!r.summary) return { text: `The document has errors:\n${describeIssues(r.issues)}` };
        const s = r.summary;
        const segs = s.segments.map((g) => `${secs(g.from)}-${secs(g.to)} ${g.shows}${g.source ? ` (${g.source})` : ''}${g.transition ? `, ${g.transition} in` : ''}`);
        return { text: `${r.ok ? 'Can be rendered.' : 'CANNOT be rendered yet.'} ${s.size}, ${s.seconds}s.\nPicture:\n${segs.join('\n')}\n${describeIssues(s.issues)}` };
      },
    },
    {
      name: 'nordle_probe_media',
      description: 'Find out what a footage, photo or music file really contains (size, length, frame rate, rotation, audio) or list the files in a folder of a mount. Footage stays where it is on the computer: the project\'s nordle.local.json maps a mount name to a folder, and documents refer to files as mount:<name>/<path>. Give "path" to probe a file (a project path or mount:name/path). Give "mount" (and optionally "dir") to list a folder. Give neither to see which mounts exist.',
      inputSchema: {
        type: 'object',
        properties: { project: P, path: { type: 'string', description: 'A file: assets/photo.jpg or mount:footage/Clips/A001.mp4.' }, mount: { type: 'string', description: 'A mount name, to list its files.' }, dir: { type: 'string', description: 'A folder inside the mount.' } },
        required: ['project'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        if (a.path) {
          const r = await client.post(path(a, 'probe'), { path: a.path });
          return { text: `${a.path}: ${r.summary}`, json: r.probe };
        }
        if (a.mount) {
          const r = await client.post(path(a, 'ls'), { mount: a.mount, dir: a.dir ?? '' });
          const rows = r.entries.map((e) => `${e.type === 'folder' ? '[folder] ' : ''}${e.name}${e.size !== null ? `  (${(e.size / 1e6).toFixed(1)} MB)` : ''}`);
          return { text: `mount:${a.mount}/${a.dir ?? ''}\n${rows.join('\n') || '(empty)'}${r.truncated ? '\n(more files not shown)' : ''}` };
        }
        const r = await client.get(path(a, 'mounts'));
        if (!r.mounts.length) throw new NordleError('This project has no mounts. Add one to nordle.local.json in the project folder: {"mounts": {"footage": "<full folder path>"}}.', 0);
        return { text: `Mounts: ${r.mounts.map((m) => `${m.name}${m.available ? '' : ' (folder not available now)'}`).join(', ')}. Use paths like mount:${r.mounts[0].name}/<file>.` };
      },
    },
  ];
};
