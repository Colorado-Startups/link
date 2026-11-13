// SPDX-License-Identifier: Apache-2.0
// A small RFC 4180 CSV reader: quoted fields may hold commas, doubled quotes and line breaks.

/** Every row of `text` as an array of cells. Handles a BOM, CRLF and a missing final newline. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (cell += '"', i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      (row = []), (cell = '');
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) (row.push(cell), rows.push(row));
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/**
 * Rows as objects keyed by lower-cased header. The header is the first row that has a cell equal to `anchor`
 * (case-insensitive), so a preamble above it, like the "Notes:" block in Connections.csv, is skipped.
 */
export function records(text: string, anchor: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const at = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === anchor.toLowerCase()));
  if (at < 0) return [];
  const head = rows[at].map((h) => h.trim().toLowerCase());
  return rows.slice(at + 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
