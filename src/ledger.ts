// SPDX-License-Identifier: Apache-2.0
// The ledger: one JSON line per published post or comment, appended to LINK_HOME/ledger.jsonl and never rewritten. It holds what
// was posted and where, never the token.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One published post. */
export interface LedgerEntry {
  /** When LinkedIn accepted the post, ISO 8601 in UTC. */
  time: string;
  kind: 'text' | 'image' | 'document' | 'comment';
  /** The post URN from LinkedIn's `x-restli-id` header. */
  urn: string;
  url: string;
  /** Length of the text as the caller gave it. */
  chars: number;
  /** SHA-256 of that text, hex. */
  sha256: string;
  /** The attached file's name, without its folder; null for a text post. */
  media: string | null;
}

const FILE = 'ledger.jsonl';

/** Appends one line. Creates the folder for its owner only (700) and the file for its owner only (600). */
export function appendLedger(home: string, entry: LedgerEntry): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  appendFileSync(join(home, FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** The last `count` lines, oldest first, each parsed; a line that is not JSON comes back as its text. No file: none. */
export function lastLedgerLines(home: string, count: number): unknown[] {
  let text: string;
  try {
    text = readFileSync(join(home, FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
}
