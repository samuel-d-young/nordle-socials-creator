// node nordle.mjs update [--now] [--off | --on]
// Says whether Nordle has been updated on GitHub since this copy, what changed, and the two commands that bring it up to date. It never installs anything.

import { checkForUpdate, setUpdateChecks } from '../update/check.mjs';

export default {
  name: 'update',
  usage: 'update [--now] [--off|--on]',
  summary: 'has Nordle been updated on GitHub? (it only tells you; nothing is installed)',
  async run(args) {
    if (args.includes('--off')) { setUpdateChecks(false); console.log('Update checks are off. Turn them on again with: node nordle.mjs update --on'); return 0; }
    if (args.includes('--on')) { setUpdateChecks(true); console.log('Update checks are on.'); return 0; }
    const r = await checkForUpdate({ force: args.includes('--now') });
    if (!r.enabled) { console.log('Update checks are off (node nordle.mjs update --on turns them on).'); return 0; }
    console.log(`Nordle ${r.current.version ?? ''}${r.current.sha ? ` (${r.current.sha.slice(0, 7)})` : ''}, created by Samuel Young, CC BY 4.0`);
    if (r.error) { console.log(`Could not check: ${r.error}`); return 0; }
    if (!r.updateAvailable) { console.log(r.note ?? 'You have the latest.'); return 0; }
    console.log(`There is an update: ${r.behindBy || 'new'} change${r.behindBy === 1 ? '' : 's'} on GitHub since your copy.`);
    for (const c of r.changes.slice(0, 10)) console.log(`  ${c.sha}  ${c.message}`);
    console.log(`\nTo update, run:\n  ${r.command}\nthen restart the Studio. Everything: ${r.url}/commits/main`);
    return 0;
  },
};
