// The Check tab: what the plan finds wrong with the cut, instantly and without drawing anything (a gap, overlapping clips, a cut
// through a word, a title under the platform buttons, footage that cannot be found). Click one to go there.

import { h, icon } from './dom.js';
import { state } from './state.js';
import { onV, clipsOf, clock, doc, seek, select } from './video-state.js';
import { check, retryProblems, runCheck, sourceProblems } from './video-data.js';

const LEVEL = { error: ['Problem', 'error'], warn: ['Warning', 'warn'], info: ['Note', 'info'] };

export function mountCheck(root) {
  const active = () => state.route.name === 'video' && state.panel === 'check';

  function where(issue) {
    const parts = [];
    const at = issue.time ?? (issue.clip ? clipsOf(doc()).find((c) => c.clip.id === issue.clip)?.clip.at : undefined);
    if (typeof at === 'number') parts.push(clock(at));
    if (issue.clip) parts.push(`clip ${issue.clip}`);
    return parts.join(' · ');
  }

  function go(issue) {
    const at = issue.time ?? (issue.clip ? clipsOf(doc()).find((c) => c.clip.id === issue.clip)?.clip.at : undefined);
    if (issue.clip && clipsOf(doc()).some((c) => c.clip.id === issue.clip)) select('clip', [issue.clip]);
    if (typeof at === 'number') seek(at);
  }

  function build() {
    const issues = [...check.issues].sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1) || (a.time ?? 1e9) - (b.time ?? 1e9));
    const probs = [...sourceProblems.entries()];
    const errors = issues.filter((i) => i.level === 'error').length + probs.length;
    const warns = issues.filter((i) => i.level !== 'error').length;
    const status = check.status === 'running' ? 'Checking…'
      : check.status === 'error' ? `The check could not run: ${check.message}`
        : check.status === 'idle' ? 'Not checked yet.'
          : !errors && !warns ? 'Nothing found. The cut is ready to render.'
            : `${errors ? `${errors} problem${errors === 1 ? '' : 's'}` : ''}${errors && warns ? ' and ' : ''}${warns ? `${warns} warning${warns === 1 ? '' : 's'}` : ''}.${!check.ok ? ' A problem stops the render until it is fixed.' : ''}`;
    root.replaceChildren(
      h('div', { class: 'group' },
        h('h3', {}, 'Check', h('button', { class: 'btn sm', type: 'button', 'data-act': 'run-check', onclick: () => { retryProblems(); runCheck(); } }, icon('sparkle', 14), 'Check again')),
        h('p', { class: `vck-status${check.status === 'ready' && !errors && !warns ? ' ok' : ''}`, role: 'status' }, status),
        h('p', { class: 'muted vck-note' }, 'This reads the cut and the footage and draws nothing, so it is quick. It runs again by itself shortly after each edit.')),
      probs.length ? h('div', { class: 'group' }, h('h3', {}, 'Footage'), probs.map(([id, msg]) => h('div', { class: 'vck-item error', role: 'alert' }, h('span', { class: 'vck-lv' }, 'Problem'), h('div', {}, h('b', {}, `"${id}" cannot be read. `), msg)))) : null,
      issues.length ? h('div', { class: 'group', role: 'list', 'aria-label': 'Problems in the cut' }, issues.map((i) => {
        const [label, cls] = LEVEL[i.level] ?? LEVEL.info;
        const loc = where(i);
        return h('button', { class: `vck-item ${cls}`, type: 'button', role: 'listitem', 'data-code': i.code, onclick: () => go(i), title: loc ? `Go to ${loc}` : '' },
          h('span', { class: 'vck-lv' }, label), h('span', { class: 'vck-msg' }, i.message, loc ? h('span', { class: 'vck-where' }, loc) : null));
      })) : null);
  }

  function refresh() { if (active()) build(); }
  onV('check', refresh);
  onV('data', refresh);
  return { refresh, rebuild: () => { build(); } };
}
