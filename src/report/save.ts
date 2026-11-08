import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = 'logs';

export const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Writes `data` to logs/<profile>-<timestamp>-<kind>.json and returns the path. */
export function saveReport(profile: string, kind: string, data: unknown, stamp = timestamp()): string {
  mkdirSync(LOG_DIR, { recursive: true });
  const path = join(LOG_DIR, `${profile}-${stamp}-${kind}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

/** Writes rows to logs/<profile>-<timestamp>-<kind>.csv and returns the path. */
export function saveCsv<T extends object>(
  profile: string,
  kind: string,
  rows: T[],
  columns: (keyof T & string)[],
  stamp = timestamp(),
): string {
  mkdirSync(LOG_DIR, { recursive: true });
  const path = join(LOG_DIR, `${profile}-${stamp}-${kind}.csv`);
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
