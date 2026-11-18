import type { DatabaseSync as Database } from 'node:sqlite';

// This port operates on synthetic local fixtures. A production caller must provide
// independently verified release observations and system verification.
type State = { current: string; previous: string | null };
type Common = {
  dbPath: string;
  stateFile: string;
  rootDir: string;
  releasesDir: string;
  selfCheck: (db: Database, sha: string) => void | Promise<void>;
  compatible: (db: Database, sha: string) => boolean | Promise<boolean>;
  previousRoot?: {
    tree: Record<string, { gitBlob: string; sha256: string }>;
    allowedPaths: string[];
    checkBoundary: (paths: { rootDir: string; stagingDir: string }) => void | Promise<void>;
  };
};
type Accept = Common & {
  sha: string;
  allowed: boolean;
  sessionActive: boolean;
  migrate: (db: Database) => void | Promise<void>;
  lifecycle?: (event: {
    phase: 'before-commit' | 'after-commit';
    db: Database;
  }) => void | Promise<void>;
};
type Launch = {
  dbPath: string;
  stateFile: string;
  verify: (selected: string, db: Database) => boolean | Promise<boolean>;
  execute: (selected: string, db: Database) => void | Promise<void>;
};
export declare function acceptUpdate(options: Accept): Promise<void>;
export declare function restorePrevious(options: Common): Promise<void>;
export declare function launchVerified(options: Launch): Promise<void>;

declare const require: NodeRequire;
declare const exports: {
  acceptUpdate: typeof acceptUpdate;
  restorePrevious: typeof restorePrevious;
  launchVerified: typeof launchVerified;
};
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite') as typeof import('node:sqlite');
const shaPattern = /^[a-f0-9]{40}$/;
const installedReleases =
  path.join(
    require('node:os').userInfo().homedir,
    'Library/Application Support/Foliome/app/releases',
  ) + path.sep;
const stateModule = __dirname.startsWith(installedReleases)
  ? '/Library/Application Support/Foliome/base/activation-state.js'
  : path.resolve(__dirname, '../../../base/activation-state.js');
const { exclusive, marker } = require(stateModule) as {
  exclusive: <T>(file: string, work: () => Promise<T>) => Promise<T>;
  marker: (db: Database) => State | null;
};
async function readState(file: string): Promise<State> {
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('state');
  const state = value as State;
  if (
    Object.keys(value).sort().join(',') !== 'current,previous' ||
    typeof state.current !== 'string' ||
    !shaPattern.test(state.current) ||
    !(
      state.previous === null ||
      (typeof state.previous === 'string' && shaPattern.test(state.previous))
    ) ||
    state.current === state.previous
  )
    throw new Error('state');
  return state;
}
async function writeState(file: string, state: State): Promise<void> {
  const temp = `${file}.${crypto.randomBytes(16).toString('hex')}`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(path.resolve(file)), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
}
function setMarker(db: Database, state: State): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS activation_state (id INTEGER PRIMARY KEY CHECK (id = 1), current_sha TEXT NOT NULL, previous_sha TEXT) STRICT',
  );
  db.prepare(
    'INSERT INTO activation_state (id, current_sha, previous_sha) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET current_sha = excluded.current_sha, previous_sha = excluded.previous_sha',
  ).run(state.current, state.previous);
}
async function selectedState(db: Database, file: string): Promise<State> {
  const committed = marker(db);
  if (committed) {
    await writeState(file, committed);
    return committed;
  }
  return readState(file);
}
async function copyDatabase(file: string): Promise<string> {
  const temp = `${file}.${crypto.randomBytes(16).toString('hex')}.check`;
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    await backup(source, temp);
    return temp;
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  } finally {
    source.close();
  }
}
exports.acceptUpdate = async function acceptUpdate(options) {
  try {
    await exclusive(options.stateFile, async () => {
      if (
        options.allowed !== true ||
        options.sessionActive !== false ||
        !shaPattern.test(options.sha)
      )
        throw new Error('refused');
      const selectionDb = new DatabaseSync(options.dbPath);
      let state: State;
      try {
        state = await selectedState(selectionDb, options.stateFile);
      } finally {
        selectionDb.close();
      }
      if (options.sha === state.current) throw new Error('refused');
      const copy = await copyDatabase(options.dbPath);
      try {
        const check = new DatabaseSync(copy);
        try {
          check.exec('BEGIN IMMEDIATE');
          try {
            await options.migrate(check);
            check.exec('COMMIT');
          } catch (e) {
            check.exec('ROLLBACK');
            throw e;
          }
          if ((await options.compatible(check, options.sha)) !== true)
            throw new Error('incompatible');
          await options.selfCheck(check, options.sha);
        } finally {
          check.close();
        }
      } finally {
        await fs.rm(copy, { force: true });
      }
      const next = { current: options.sha, previous: state.current };
      const db = new DatabaseSync(options.dbPath);
      let committed = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        await options.migrate(db);
        setMarker(db, next);
        await options.lifecycle?.({ phase: 'before-commit', db });
        db.exec('COMMIT');
        committed = true;
        // A timing observer cannot turn a committed activation into a rejection.
        try {
          await options.lifecycle?.({ phase: 'after-commit', db });
        } catch {
          /* the transaction is already committed */
        }
      } catch (error) {
        if (!committed) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* no transaction */
          }
        }
        throw error;
      } finally {
        db.close();
      }
      // The committed database is authoritative even if the projection fails.
      await writeState(options.stateFile, next).catch(() => {});
    });
  } catch {
    throw new Error('update-failed');
  }
};
exports.restorePrevious = async function restorePrevious(options) {
  try {
    await exclusive(options.stateFile, async () => {
      const selectionDb = new DatabaseSync(options.dbPath);
      let state: State;
      try {
        state = await selectedState(selectionDb, options.stateFile);
      } finally {
        selectionDb.close();
      }
      if (!state.previous) throw new Error('refused');
      const copy = await copyDatabase(options.dbPath);
      try {
        const check = new DatabaseSync(copy);
        try {
          if ((await options.compatible(check, state.previous)) !== true)
            throw new Error('incompatible');
          await options.selfCheck(check, state.previous);
        } finally {
          check.close();
        }
      } finally {
        await fs.rm(copy, { force: true });
      }
      if (!options.previousRoot) throw new Error('unverified-root');
      const restored = { current: state.previous, previous: null };
      const { installRoot } = require('../../../base/install-root.js') as {
        installRoot: (options: object) => Promise<void>;
      };
      await installRoot({
        ...options.previousRoot,
        releaseDir: path.join(options.releasesDir, state.previous),
        rootDir: options.rootDir,
        sha: state.previous,
        selectedOnly: true,
        finalize: () => {
          const db = new DatabaseSync(options.dbPath);
          try {
            db.exec('BEGIN IMMEDIATE');
            try {
              setMarker(db, restored);
              db.exec('COMMIT');
            } catch (error) {
              try {
                db.exec('ROLLBACK');
              } catch {
                /* no transaction */
              }
              throw error;
            }
          } finally {
            db.close();
          }
        },
      });
      await writeState(options.stateFile, restored).catch(() => {});
    });
  } catch {
    throw new Error('restore-failed');
  }
};

exports.launchVerified = async function launchVerified(options) {
  try {
    await exclusive(options.stateFile, async () => {
      const db = new DatabaseSync(options.dbPath);
      try {
        const state = await selectedState(db, options.stateFile);
        if ((await options.verify(state.current, db)) !== true) throw new Error('refused');
        await options.execute(state.current, db);
      } finally {
        db.close();
      }
    });
  } catch {
    throw new Error('launch-failed');
  }
};
