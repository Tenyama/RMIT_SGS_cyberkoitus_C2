import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/** Open (and migrate) a SQLite DB. Use ':memory:' in tests. */
export function openDb(path: string = process.env.DB_PATH || './data/procure.db'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

// Process-wide current DB + clock, so other tracks (simulator) can call alerts/audit without plumbing.
let current: Db | null = null;
let clock: () => number = () => Date.now();

export function setDb(db: Db): void {
  current = db;
}
export function getDb(): Db {
  if (!current) current = openDb();
  return current;
}
export function setClock(fn: () => number): void {
  clock = fn;
}
export function now(): number {
  return clock();
}
