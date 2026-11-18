import type { DatabaseSync as Database } from 'node:sqlite';

// This port operates on synthetic local fixtures. A production caller must provide
// independently verified release observations and system verification.
type State = { current: string; previous: string | null };
type Common = {
  dbPath: string; stateFile: string; rootDir: string; releasesDir: string;
  selfCheck: (db: Database, sha: string) => void | Promise<void>;
  compatible: (db: Database, sha: string) => boolean | Promise<boolean>;
  previousRoot?: { tree: Record<string, { gitBlob: string; sha256: string }>; allowedPaths: string[]; checkBoundary: (paths: { rootDir: string; stagingDir: string }) => void | Promise<void> };
};
type Accept = Common & {
  sha: string; allowed: boolean; sessionActive: boolean;
  migrate: (db: Database) => void | Promise<void>;
};
export declare function acceptUpdate(options: Accept): Promise<void>;
export declare function restorePrevious(options: Common): Promise<void>;

declare const require: NodeRequire;
declare const exports: { acceptUpdate: typeof acceptUpdate; restorePrevious: typeof restorePrevious };
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite') as typeof import('node:sqlite');
const locks = new Set<string>();
const shaPattern = /^[a-f0-9]{40}$/;

async function exclusive<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  if (locks.has(key)) throw new Error('busy');
  locks.add(key);
  let lock: import('node:fs/promises').FileHandle | undefined;
  try {
    lock = await fs.open(`${key}.lock`, 'wx', 0o600);
    return await work();
  } finally {
    try { if (lock) { try { await lock.close(); } finally { await fs.unlink(`${key}.lock`); } } }
    finally { locks.delete(key); }
  }
}
async function readState(file: string): Promise<State> {
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('state');
  const state = value as State;
  if (Object.keys(value).sort().join(',') !== 'current,previous' || typeof state.current !== 'string' || !shaPattern.test(state.current) || !(state.previous === null || (typeof state.previous === 'string' && shaPattern.test(state.previous))) || state.current === state.previous) throw new Error('state');
  return state;
}
async function writeState(file: string, state: State): Promise<void> {
  const temp = `${file}.${crypto.randomBytes(16).toString('hex')}`;
  try { await fs.writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function copyDatabase(file: string): Promise<string> {
  const temp = `${file}.${crypto.randomBytes(16).toString('hex')}.check`;
  const source = new DatabaseSync(file, { readOnly: true });
  try { await backup(source, temp); return temp; }
  catch (e) { await fs.rm(temp, { force: true }); throw e; }
  finally { source.close(); }
}
exports.acceptUpdate = async function acceptUpdate(options) {
  try {
    await exclusive(options.stateFile, async () => {
      if (options.allowed !== true || options.sessionActive !== false || !shaPattern.test(options.sha)) throw new Error('refused');
      const state = await readState(options.stateFile);
      if (options.sha === state.current) throw new Error('refused');
      const copy = await copyDatabase(options.dbPath);
      try {
        const check = new DatabaseSync(copy);
        try {
          check.exec('BEGIN IMMEDIATE');
          try { await options.migrate(check); check.exec('COMMIT'); }
          catch (e) { check.exec('ROLLBACK'); throw e; }
          if (await options.compatible(check, options.sha) !== true) throw new Error('incompatible');
          await options.selfCheck(check, options.sha);
        } finally { check.close(); }
      } finally { await fs.rm(copy, { force: true }); }
      const temp = `${options.stateFile}.${crypto.randomBytes(16).toString('hex')}`;
      await fs.writeFile(temp, JSON.stringify({ current: options.sha, previous: state.current }), { flag: 'wx', mode: 0o600 });
      // A process killed between pointer publication and SQLite commit needs recovery.
      let db: InstanceType<typeof DatabaseSync> | undefined;
      let stateChanged = false;
      try {
        db = new DatabaseSync(options.dbPath);
        db.exec('BEGIN IMMEDIATE');
        await options.migrate(db);
        await fs.rename(temp, options.stateFile);
        stateChanged = true;
        db.exec('COMMIT');
      } catch (e) {
        try { db?.exec('ROLLBACK'); } catch { /* no transaction */ }
        if (stateChanged) await writeState(options.stateFile, state);
        throw e;
      } finally { db?.close(); await fs.rm(temp, { force: true }); }
    });
  } catch { throw new Error('update-failed'); }
};
exports.restorePrevious = async function restorePrevious(options) {
  try {
    await exclusive(options.stateFile, async () => {
      const state = await readState(options.stateFile);
      if (!state.previous) throw new Error('refused');
      const copy = await copyDatabase(options.dbPath);
      try {
        const check = new DatabaseSync(copy);
        try {
          if (await options.compatible(check, state.previous) !== true) throw new Error('incompatible');
          await options.selfCheck(check, state.previous);
        } finally { check.close(); }
      } finally { await fs.rm(copy, { force: true }); }
      if (!options.previousRoot) throw new Error('unverified-root');
      const temp = `${options.stateFile}.${crypto.randomBytes(16).toString('hex')}`;
      try {
        await fs.writeFile(temp, JSON.stringify({ current: state.previous, previous: null }), { flag: 'wx', mode: 0o600 });
        const { installRoot } = require('../../../base/install-root.js') as { installRoot: (options: object) => Promise<void> };
        await installRoot({ ...options.previousRoot, releaseDir: path.join(options.releasesDir, state.previous), rootDir: options.rootDir, sha: state.previous, selectedOnly: true, finalize: () => fs.rename(temp, options.stateFile) });
      } finally { await fs.rm(temp, { force: true }); }
    });
  } catch { throw new Error('restore-failed'); }
};
