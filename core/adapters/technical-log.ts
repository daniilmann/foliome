import type { Stats } from 'node:fs';

const { constants } = require('node:fs') as typeof import('node:fs');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const path = require('node:path') as typeof import('node:path');

const levels = Object.freeze(['error', 'warn', 'info', 'debug'] as const);
export type TechnicalLogLevel = (typeof levels)[number];
type BrowserKind = 'main-frame-navigation' | 'non-get-request';
type Event =
  | Readonly<{ level: 'error'; code: 'protocol-unavailable' | 'action-denial-limit' }>
  | Readonly<{ level: 'warn'; code: 'channel-denied' }>
  | Readonly<{ level: 'info'; code: 'started' }>
  | Readonly<{
      level: 'debug';
      code: 'browser-event';
      kind?: BrowserKind;
      elapsedMs?: number;
    }>;
type Overflow = Readonly<{
  level: 'warn';
  code: 'queue-overflow';
  droppedDebug: number;
  droppedOther: number;
}>;
type Options = Readonly<{
  directory: string;
  now(): Date;
  onUnavailable(code: 'log-unavailable', sessionId: string): void;
}>;
type Entry = {
  session: Session;
  day: string;
  line: string;
  level: TechnicalLogLevel;
  flush: boolean;
};
type Session = {
  id: string;
  day?: string;
  failed: boolean;
  failurePending: boolean;
  ring: Entry[];
  ringIndex: number;
  droppedDebug: number;
  droppedOther: number;
};
type LogFile = { name: string; day: string; sequence: number; stat: Stats };

const ringLimit = 2000;
const queueLimit = 10_000;
const batchLimit = 128;
const fileLimit = 10_000_000;
const totalLimit = 100_000_000;
const directoryLimit = 1024;
const names = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\.(\d{4})\.jsonl$/;

function invalid(): never {
  throw new Error('invalid technical log record');
}

function checked(value: Event): Event {
  if (!value || typeof value !== 'object') return invalid();
  const fields = Object.getOwnPropertyDescriptors(value as object);
  const level: unknown = fields.level?.value;
  const code: unknown = fields.code?.value;
  const browser = level === 'debug' && code === 'browser-event';
  for (const key of Reflect.ownKeys(fields)) {
    if (
      typeof key !== 'string' ||
      (key !== 'level' &&
        key !== 'code' &&
        !(browser && (key === 'kind' || key === 'elapsedMs'))) ||
      !Object.hasOwn(fields[key], 'value')
    )
      return invalid();
  }
  if (level === 'error' && (code === 'protocol-unavailable' || code === 'action-denial-limit'))
    return { level, code };
  if (level === 'warn' && code === 'channel-denied') return { level, code };
  if (level === 'info' && code === 'started') return { level, code };
  if (browser) {
    const kind: unknown = fields.kind?.value;
    const elapsedMs: unknown = fields.elapsedMs?.value;
    if (
      (Object.hasOwn(fields, 'kind') &&
        kind !== 'main-frame-navigation' &&
        kind !== 'non-get-request') ||
      (Object.hasOwn(fields, 'elapsedMs') &&
        (typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0))
    )
      return invalid();
    return {
      level,
      code,
      ...(kind === 'main-frame-navigation' || kind === 'non-get-request' ? { kind } : {}),
      ...(typeof elapsedMs === 'number' ? { elapsedMs } : {}),
    };
  }
  return invalid();
}

function localDay(date: Date): string {
  const year = date.getFullYear();
  if (!(year >= 1000 && year <= 9999)) throw new Error('technical log time');
  return [year, date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function owned(stat: Stats, mode: number): boolean {
  return stat.uid === process.getuid?.() && (stat.mode & 0o7777) === mode;
}

function safeFile(stat: Stats): boolean {
  return stat.isFile() && owned(stat, 0o600) && stat.nlink === 1;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function persist(directory: string, entries: readonly Entry[], date: Date) {
  const existing = await fs.lstat(directory).catch((error: unknown) => {
    if (!hasCode(error, 'ENOENT')) throw error;
    return undefined;
  });
  if (!existing && entries.length === 0) return;
  const parent = path.dirname(directory);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || !owned(parentStat, 0o700))
    throw new Error('technical log parent');
  if (!existing) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  const directoryStat = existing ?? (await fs.lstat(directory));
  async function checkDirectory() {
    const [currentParent, current] = await Promise.all([fs.lstat(parent), fs.lstat(directory)]);
    if (
      !currentParent.isDirectory() ||
      !owned(currentParent, 0o700) ||
      !sameFile(currentParent, parentStat) ||
      !current.isDirectory() ||
      !owned(current, 0o700) ||
      !sameFile(current, directoryStat)
    )
      throw new Error('technical log directory');
  }
  await checkDirectory();

  const files: LogFile[] = [];
  const listing = await fs.opendir(directory);
  for await (const item of listing) {
    const match = names.exec(item.name);
    if (!match || files.length >= directoryLimit) throw new Error('technical log listing');
    const [, day, sequence] = match;
    const stat = await fs.lstat(path.join(directory, item.name));
    if (!safeFile(stat)) throw new Error('technical log file');
    files.push({ name: item.name, day, sequence: Number(sequence), stat });
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  let total = files.reduce((sum, file) => sum + file.stat.size, 0);
  date.setDate(date.getDate() - 30);
  const expired = localDay(date);

  async function remove(file: LogFile) {
    await checkDirectory();
    const filename = path.join(directory, file.name);
    const current = await fs.lstat(filename);
    if (!safeFile(current) || !sameFile(current, file.stat) || current.size !== file.stat.size)
      throw new Error('technical log file');
    await fs.unlink(filename);
    files.splice(files.indexOf(file), 1);
    total -= file.stat.size;
  }
  for (const file of [...files]) {
    if (file.day <= expired || file.stat.size > fileLimit) await remove(file);
  }
  while (total > totalLimit) await remove(files[0]);

  for (let start = 0; start < entries.length;) {
    const day = entries[start].day;
    if (day <= expired) {
      start++;
      continue;
    }
    const last = files.findLast((file) => file.day === day);
    const next = last ? last.sequence + 1 : 0;
    const reuse = last && last.stat.size + Buffer.byteLength(entries[start].line) <= fileLimit;
    const previousSize = reuse ? last.stat.size : 0;
    const name = reuse ? last.name : day + '.' + String(next).padStart(4, '0') + '.jsonl';
    if (!reuse && next > 9999) throw new Error('technical log rotation');
    let end = start;
    let bytes = 0;
    let flush = false;
    while (end < entries.length && entries[end].day === day) {
      const size = Buffer.byteLength(entries[end].line);
      if (previousSize + bytes + size > fileLimit) break;
      bytes += size;
      flush ||= entries[end].flush;
      end++;
    }
    while (total + bytes > totalLimit || (!reuse && files.length >= directoryLimit)) {
      const oldest = files.find((file) => !reuse || file !== last);
      if (!oldest) throw new Error('technical log quota');
      await remove(oldest);
    }
    await checkDirectory();
    const filename = path.join(directory, name);
    const file = await fs.open(
      filename,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (reuse ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      const before = await file.stat();
      const named = await fs.lstat(filename);
      if (
        !safeFile(before) ||
        !safeFile(named) ||
        !sameFile(before, named) ||
        (reuse && !sameFile(before, last.stat)) ||
        before.size !== previousSize ||
        named.size !== previousSize
      )
        throw new Error('technical log file');
      await checkDirectory();
      try {
        await file.writeFile(
          entries
            .slice(start, end)
            .map((entry) => entry.line)
            .join(''),
        );
      } catch (error) {
        await file.truncate(previousSize).catch(() => {});
        throw error;
      }
      if (flush) await file.sync();
      const after = await file.stat();
      if (!safeFile(after) || after.size !== previousSize + bytes)
        throw new Error('technical log file');
      if (reuse) last.stat = after;
      else {
        files.push({ name, day, sequence: next, stat: after });
        files.sort((left, right) => left.name.localeCompare(right.name));
      }
      total += bytes;
    } finally {
      await file.close();
    }
    start = end;
  }
}

function create({ directory, now, onUnavailable }: Options) {
  if (
    !path.isAbsolute(directory) ||
    path.normalize(directory) !== directory ||
    directory.endsWith(path.sep) ||
    directory.includes('\0')
  )
    throw new Error('technical log path');

  let level: TechnicalLogLevel = 'error';
  let current: Session | undefined;
  let queue: Entry[] = [];
  let maintenance: Session | undefined;
  let inFlight = 0;
  let work: Promise<void> | undefined;

  function entry(session: Session, event: Event | Overflow): Entry {
    const date = now();
    return {
      session,
      day: localDay(date),
      line: JSON.stringify({ at: date.toISOString(), sessionId: session.id, ...event }) + '\n',
      level: event.level,
      flush: event.level === 'error',
    };
  }

  function unavailable(session: Session) {
    if (session.failed) return;
    session.failed = true;
    session.ring.length = 0;
    session.droppedDebug = session.droppedOther = 0;
    if (maintenance === session) maintenance = undefined;
    queue = queue.filter((item) => item.session !== session);
    try {
      onUnavailable('log-unavailable', session.id);
    } catch {
      /* The protected protocol owns its failure path. */
    }
  }

  function enqueue(item: Entry) {
    if (queue.length + inFlight < queueLimit) {
      queue.push(item);
      return;
    }
    let index = -1;
    if (item.level !== 'debug') index = queue.findLastIndex((queued) => queued.level === 'debug');
    if (index < 0 && item.level === 'error')
      index = queue.findLastIndex((queued) => queued.level !== 'error');
    if (index < 0 && item.level === 'error') index = queue.length - 1;
    const dropped = index < 0 ? item : queue.splice(index, 1)[0];
    if (index >= 0) queue.push(item);
    const session = dropped.session;
    const counter = dropped.level === 'debug' ? 'droppedDebug' : 'droppedOther';
    session[counter] = Math.min(Number.MAX_SAFE_INTEGER, session[counter] + 1);
  }

  async function run() {
    while (true) {
      const session = queue[0]?.session ?? maintenance;
      if (!session) return;
      if (maintenance === session) maintenance = undefined;
      let count = 0;
      while (count < batchLimit && queue[count]?.session === session) count++;
      const entries = queue.splice(0, count);
      inFlight = count;
      try {
        await persist(directory, entries, new Date(now().getTime()));
        if (!session.failed && (session.droppedDebug || session.droppedOther)) {
          const overflow = entry(session, {
            level: 'warn',
            code: 'queue-overflow',
            droppedDebug: session.droppedDebug,
            droppedOther: session.droppedOther,
          });
          session.droppedDebug = session.droppedOther = 0;
          inFlight = 0;
          enqueue(overflow);
        }
      } catch {
        unavailable(session);
      } finally {
        inFlight = 0;
      }
    }
  }

  function schedule() {
    if (!work && (queue.length || maintenance)) {
      work = new Promise<void>((resolve) => setImmediate(resolve)).then(run).finally(() => {
        work = undefined;
        schedule();
      });
    }
  }

  function endSession() {
    const session = current;
    if (!session) return;
    current = undefined;
    session.ring.length = 0;
    if (maintenance === session) maintenance = undefined;
    // A queued error keeps its context for the asynchronous flush after revocation.
    const lastError = queue.findLastIndex(
      (item) => item.session === session && item.level === 'error',
    );
    queue = queue.filter((item, index) => item.session !== session || index <= lastError);
  }

  return {
    beginSession(sessionId: string) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
        throw new Error('technical log session');
      endSession();
      current = {
        id: sessionId,
        failed: false,
        failurePending: false,
        ring: [],
        ringIndex: 0,
        droppedDebug: 0,
        droppedOther: 0,
      };
    },
    endSession,
    setLevel(value: TechnicalLogLevel) {
      if (!levels.includes(value)) throw new Error('technical log level');
      level = value;
    },
    write(value: Event) {
      const event = checked(value);
      const session = current;
      if (!session || session.failed || session.failurePending) return;
      try {
        const item = entry(session, event);
        if (session.day !== item.day) {
          session.day = item.day;
          maintenance = session;
        }
        if (event.level === 'error') {
          for (const buffered of [
            ...session.ring.slice(session.ringIndex),
            ...session.ring.slice(0, session.ringIndex),
          ]) {
            buffered.flush = true;
            enqueue(buffered);
          }
          session.ring.length = 0;
          session.ringIndex = 0;
        }
        if (levels.indexOf(event.level) <= levels.indexOf(level)) {
          enqueue(item);
        } else if (session.ring.length < ringLimit) {
          session.ring.push(item);
        } else {
          session.ring[session.ringIndex] = item;
          session.ringIndex = (session.ringIndex + 1) % ringLimit;
        }
        schedule();
      } catch {
        session.failurePending = true;
        queueMicrotask(() => unavailable(session));
      }
    },
    async drain() {
      await Promise.resolve();
      while (work) await work;
    },
  };
}

export declare const createTechnicalLog: typeof create;
export declare const technicalLogLevels: typeof levels;
declare const exports: { createTechnicalLog: typeof create; technicalLogLevels: typeof levels };
exports.createTechnicalLog = create;
exports.technicalLogLevels = levels;
