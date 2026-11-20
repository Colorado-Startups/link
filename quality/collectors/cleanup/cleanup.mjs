// SPDX-License-Identifier: Apache-2.0
// Clean-up tab: Linken's own collector. It writes the fictional sample export, rates it, and checks the decision
// model's promises on it: core is never removable, nothing goes without live proof, a removal is final, and the answers
// an agent reads stay small. Every row comes from tools/sample-export.mjs: no member data. Targets: targets/cleanup.json.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const area = 'cleanup';

const IDS = ['load_ms', 'core_kept', 'proof_kept', 'check_tokens', 'ledger_agrees', 'summary_tokens'].map((id) => `cleanup.${id}`);
const pct = (n, of) => (of ? Math.round((n / of) * 1000) / 10 : 0);
const tokens = (value) => Math.round(JSON.stringify(value).length / 4);
/** The worst page a core row could show (spam, bare, few mutuals), and a page that proves nothing. */
const SPAM_PAGE = { headline: 'Lead generation | Book a call', company: 'Upwork', mutuals: 0 };
const QUIET_PAGE = { headline: 'Operations lead', company: 'Acme Corp', mutuals: 50 };

/** Rates the sample in a scratch folder and returns the six metrics, or could_not_check for each when anything fails. */
export async function collect({ root }) {
  const read_at = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), 'linken-cleanup-'));
  try {
    const src = (file) => import(pathToFileURL(join(root, 'src', file)).href);
    const [{ archiveLoad }, c, { levelOf, liveVerdict, queueLevels }, { loadRules }, { readConnections }, { configFrom }] = await Promise.all(
      ['archive.ts', 'connections.ts', 'levels.ts', 'rater.ts', 'store.ts', 'core.ts'].map(src),
    );
    execFileSync(process.execPath, [join(root, 'tools/sample-export.mjs'), join(work, 'sample')], { stdio: 'pipe' });
    writeFileSync(join(work, 'rules.json'), JSON.stringify({ mission: ['fusion'], also_remove: ['seller'] }));
    const env = { LINKEN_HOME: join(work, 'home'), LINKEN_RATER: join(work, 'rules.json'), LINKEN_GAP: '0-0' };
    const config = configFrom(env);
    const start = performance.now();
    await archiveLoad({ path: join(work, 'sample') }, config, env);
    const ms = Math.round(performance.now() - start);
    const rules = loadRules(env);
    const rows = readConnections(config).filter((r) => r.url);
    const levelIs = (r, set) => set.includes(levelOf(r, rules)[0]);
    const core = rows.filter((r) => levelIs(r, ['core']));
    const queued = rows.filter((r) => levelIs(r, queueLevels(rules)) && !['override', 'pitch'].includes(r.reason));
    const page = (r) => ({ url: r.url, name: `${r.first} ${r.last}`, headline: r.position, company: r.company, mutuals: 20 });
    const checked = c.connectionsCheckList({ rows: rows.slice(0, 20).map(page) }, config, env);
    const [gone, passed] = queued;
    c.connectionsMark({ url: gone.url, action: 'removed' }, config, env);
    c.connectionsMark({ url: passed.url, action: 'skipped' }, config, env);
    let refused = false;
    try {
      c.connectionsMark({ url: gone.url, action: 'keep' }, config, env);
    } catch {
      refused = true;
    }
    const events = JSON.parse(readFileSync(join(config.home, 'removals.json'), 'utf8'));
    const state = new Map(readConnections(config).map((r) => [r.url, r.state]));
    const agrees = [gone, passed].filter((r) => events.findLast((e) => e.url === r.url)?.action === state.get(r.url)).length + (refused ? 1 : 0);
    const value = (v, source) => ({ value: v, source, read_at });
    return {
      'cleanup.load_ms': value(ms, `latest: archive_load on the ${rows.length}-row fictional sample, wall clock`),
      'cleanup.core_kept': value(pct(core.filter((r) => liveVerdict(r, SPAM_PAGE, rules).verdict === 'SKIP').length, core.length), `state: ${core.length} core rows checked against a spam page`),
      'cleanup.proof_kept': value(pct(queued.filter((r) => liveVerdict(r, QUIET_PAGE, rules).verdict === 'SKIP').length, queued.length), `state: ${queued.length} queued rows checked against a page with no proof`),
      'cleanup.check_tokens': value(Math.round(tokens(checked) / 20), 'state: connections_check_list on 20 sample rows, characters / 4 per row'),
      'cleanup.ledger_agrees': value(pct(agrees, 3), 'state: one removed and one skipped mark agree with the ledger, and a later mark on the removed row is refused'),
      'cleanup.summary_tokens': value(tokens(c.connectionsSummary(config, env)), 'state: one connections_summary answer, characters / 4'),
    };
  } catch (error) {
    return Object.fromEntries(IDS.map((id) => [id, { could_not_check: `the sample run failed: ${error.message}`, source: 'state: sample run' }]));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
