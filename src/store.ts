// SPDX-License-Identifier: Apache-2.0
// The stored connections: LINKEN_HOME/connections.json, which archive_load writes and the connections and inbox tools
// read, and writeJson, which writes every owner-only JSON file. A leaf under rater.ts, so archive, inbox and
// connections need not import each other.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LinkError, type Config } from './core.ts';
import type { Row } from './rater.ts';

/** One stored connection: the export's fields, its signals, the owner's mark and state, and its tier and reason. */
export interface Connection extends Row {
  state?: 'removed' | 'skipped';
  note?: string;
  tier: string;
  reason: string;
}

/** The path of the stored connections, LINKEN_HOME/connections.json. */
export const connectionsFile = (config: Config) => join(config.home, 'connections.json');

/** The stored connections, or a LinkError that says to run archive_load first. */
export function readConnections(config: Config): Connection[] {
  try {
    return JSON.parse(readFileSync(connectionsFile(config), 'utf8')) as Connection[];
  } catch {
    throw new LinkError('No connections loaded yet. Run archive_load with the path to your LinkedIn data export first.');
  }
}

/** Writes JSON for the owner only (600), through a temp file and a rename, so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Reads JSON. Only a missing file gives `missing()`: a corrupt one is a LinkError naming the file, so the next write cannot drop what it held. */
export function readJson<T>(path: string, missing: () => T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LinkError(`${path} is not readable JSON. Fix or delete it.`);
    return missing();
  }
}
