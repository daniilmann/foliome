'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const locks = new Set();
const shaPattern = /^[a-f0-9]{40}$/;

async function exclusive(file, work) {
  const key = path.resolve(file);
  if (locks.has(key)) throw new Error('busy');
  locks.add(key);
  let db;
  try {
    const lockPath = `${key}.lease.sqlite`;
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(lockPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('lease');
    db = new DatabaseSync(lockPath);
    db.exec('BEGIN EXCLUSIVE');
    return await work();
  } finally {
    try {
      db?.close();
    } finally {
      locks.delete(key);
    }
  }
}

function marker(db) {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activation_state'")
    .get();
  if (!exists) return null;
  const table = db
    .prepare(
      "SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'activation_state' AND type = 'table'",
    )
    .get();
  if (!table || table.strict !== 1) throw new Error('state');
  const rows = db.prepare('SELECT id, current_sha, previous_sha FROM activation_state').all();
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.id !== 1 ||
    typeof row.current_sha !== 'string' ||
    !shaPattern.test(row.current_sha) ||
    !(
      row.previous_sha === null ||
      (typeof row.previous_sha === 'string' && shaPattern.test(row.previous_sha))
    ) ||
    row.current_sha === row.previous_sha
  )
    throw new Error('state');
  return { current: row.current_sha, previous: row.previous_sha };
}
module.exports = { exclusive, marker };
