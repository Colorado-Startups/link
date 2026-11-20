// SPDX-License-Identifier: Apache-2.0
// Writes a fictional LinkedIn data export, so you can try Linken without your own data. Every person is made up
// and every profile slug starts with "example-". Usage: node tools/sample-export.mjs [folder] (default ~/.linken-sample).
// Mission rows are rated KEEP only when a LINKEN_RATER overlay lists "fusion" as a mission word.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = resolve((process.argv[2] ?? join(homedir(), '.linken-sample')).replace(/^~(?=\/|$)/, homedir()));
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ago = (days) => {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const q = (s) => `"${s.replaceAll('"', '""')}"`;
const slug = (first, last) => `https://www.linkedin.com/in/example-${first}-${last}`.toLowerCase();

// [reason it rates as, position, company, days since connected, first names]; the last name is the reason.
const GROUPS = [
  ['thread', 'Analyst', 'Acme Corp', 800, ['Ada', 'Ben', 'Cy', 'Dee']],
  ['endorsed', 'Designer', 'Northwind', 800, ['Eli', 'Fay', 'Gus']],
  ['new', 'Engineer', 'Globex', 20, ['Hal', 'Ivy', 'Jon', 'Kit']],
  ['pitch', 'Founder', 'Initech', 800, ['Lee', 'Mia', 'Ned', 'Oda']],
  ['sales', 'Sales Manager', 'Umbrella Co', 800, ['Pam', 'Quin', 'Rex', 'Sue', 'Tad']],
  ['mission', 'Fusion Engineer', 'Plasma Works', 800, ['Uma', 'Vic', 'Wes']],
  ['empty', '', '', 800, ['Xia', 'Yul', 'Zed']],
  ['low', 'Accountant', 'Hooli', 800, ['Abe', 'Bea', 'Cal', 'Dot', 'Eve', 'Fin']],
  ['other', 'Teacher', 'Stark School', 200, ['Gil', 'Hug', 'Ida', 'Jan', 'Kay', 'Lou']],
];
const people = GROUPS.flatMap(([reason, pos, co, days, firsts]) => firsts.map((f) => ({ first: f, last: reason, pos, co, days, reason })));
const header = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const rows = people.map((p) => [p.first, p.last, slug(p.first, p.last), '', q(p.co), q(p.pos), ago(p.days)].join(','));
rows.push(['Nora', 'Nolink', '', '', q('Acme Corp'), q('Analyst'), ago(800)].join(','), ['Omar', 'Nolink', '', '', q('Globex'), q('Engineer'), ago(900)].join(','));
writeFileSync(join(dir, 'Connections.csv'), ['Notes:', '"Fictional sample for Linken. Not real people."', '', header, ...rows, ''].join('\n'));

const owner = ['Olive', 'Owner'];
const msg = (id, from, to, day, text) =>
  [id, from[0], slug(...from), to[0], slug(...to), `2026-01-${String(day).padStart(2, '0')} 10:00:00 UTC`, q(text), 'INBOX'].join(',');
const pair = (p) => [p.first, p.last];
const lines = [];
people.filter((p) => p.reason === 'thread').forEach((p, i) => {
  lines.push(msg(`t${i}`, owner, pair(p), 2, 'Hello, good to meet you.'), msg(`t${i}`, pair(p), owner, 3, 'Likewise.'), msg(`t${i}`, owner, pair(p), 4, 'Talk soon.'));
});
people.filter((p) => p.reason === 'pitch').forEach((p, i) => lines.push(msg(`p${i}`, pair(p), owner, 5, 'Hi! Can we book a call for 15 minutes about our services?')));
writeFileSync(join(dir, 'messages.csv'), ['CONVERSATION ID,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,CONTENT,FOLDER', ...lines, ''].join('\n'));

const endorsers = people.filter((p) => p.reason === 'endorsed').map((p) => `2025-01-01,Math,${p.first},${p.last},${slug(p.first, p.last)},ACCEPTED`);
writeFileSync(join(dir, 'Endorsement_Received_Info.csv'), ['Endorsement Date,Skill Name,Endorser First Name,Endorser Last Name,Endorser Public Url,Endorsement Status', ...endorsers, ''].join('\n'));

console.log(`Sample export written to ${dir} (${rows.length} connections). Next: ask Claude to call archive_load on that folder.`);
