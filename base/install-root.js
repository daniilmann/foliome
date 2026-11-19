'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const locks = new Set();
const valid = (name) =>
  typeof name === 'string' &&
  /^(?:system|base)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(name) &&
  name.split('/').every((p) => p !== '.' && p !== '..' && p.toLowerCase() !== '.git');

// Fixture port only: production must supply fixed roots and independently verified Git observations.
async function installRoot({
  releaseDir,
  rootDir,
  sha,
  tree,
  allowedPaths,
  checkBoundary,
  finalize,
  selectedOnly = false,
}) {
  const lock = path.resolve(rootDir);
  if (locks.has(lock)) throw new Error('busy');
  locks.add(lock);
  let stage;
  let lockFile;
  let boundaryFailed = false;
  const changed = [];
  try {
    if (
      process.getuid() === 0 ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      !Array.isArray(allowedPaths) ||
      !tree ||
      typeof checkBoundary !== 'function'
    )
      throw Error();
    const names = Object.keys(tree);
    if (
      !names.length ||
      names.length > 1000 ||
      names.length !== allowedPaths.length ||
      new Set(allowedPaths).size !== names.length ||
      names.some((n) => !valid(n) || !allowedPaths.includes(n)) ||
      new Set(names.map((n) => n.toLowerCase())).size !== names.length
    )
      throw Error();
    if (selectedOnly && names.some((name) => !name.startsWith('system/'))) throw Error();
    const sourceStat = await fs.lstat(releaseDir);
    if (
      !sourceStat.isDirectory() ||
      sourceStat.isSymbolicLink() ||
      sourceStat.uid !== process.getuid()
    )
      throw Error();
    if (!selectedOnly) {
      const found = [];
      async function walk(dir, prefix = '') {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!names.some((item) => item.startsWith(`${name}/`))) throw Error();
            await walk(path.join(dir, entry.name), name);
          } else found.push(name);
        }
      }
      await walk(releaseDir);
      if (found.length !== names.length || found.some((name) => !names.includes(name)))
        throw Error();
    }
    const rootStat = await fs.lstat(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.mode & 0o022)
      throw Error();
    lockFile = await fs.open(path.join(rootDir, '.install.lock'), 'wx', 0o600);
    stage = await fs.mkdtemp(path.join(rootDir, '.staging-'));
    await fs.chmod(stage, 0o700);
    for (const name of names) {
      const entry = tree[name];
      if (!entry || !/^[a-f0-9]{40}$/.test(entry.gitBlob) || !/^[a-f0-9]{64}$/.test(entry.sha256))
        throw Error();
      const { stdout } = await run(
        '/usr/bin/perl',
        [path.join(__dirname, 'read-release-file.pl'), releaseDir, name, String(process.getuid())],
        { encoding: 'buffer', maxBuffer: 10485760, timeout: 10000, killSignal: 'SIGKILL', env: {} },
      );
      const blob = crypto
        .createHash('sha1')
        .update(`blob ${stdout.length}\0`)
        .update(stdout)
        .digest('hex');
      if (
        blob !== entry.gitBlob ||
        crypto.createHash('sha256').update(stdout).digest('hex') !== entry.sha256
      )
        throw Error();
      const dest = path.join(stage, name);
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.writeFile(dest, stdout, { flag: 'wx', mode: 0o600 });
    }
    let checked = false;
    for (const name of names.sort(
      (a, b) => Number(a.startsWith('base/')) - Number(b.startsWith('base/')),
    )) {
      if (!checked && name.startsWith('base/')) {
        try {
          await checkBoundary({ rootDir, stagingDir: stage });
        } catch {
          boundaryFailed = true;
          throw Error();
        }
        checked = true;
      }
      const parts = name.split('/');
      parts.pop();
      let parent = rootDir;
      for (const part of parts) {
        parent = path.join(parent, part);
        try {
          await fs.mkdir(parent, { mode: 0o700 });
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        const stat = await fs.lstat(parent);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== rootStat.uid ||
          stat.mode & 0o022
        )
          throw Error();
      }
      const target = path.join(rootDir, name);
      let previous = null;
      try {
        const stat = await fs.lstat(target);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.uid !== rootStat.uid
        )
          throw Error();
        previous = { bytes: await fs.readFile(target), mode: stat.mode & 0o777 };
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const temp = path.join(parent, `.install-${crypto.randomBytes(16).toString('hex')}`);
      await fs.copyFile(path.join(stage, name), temp, require('node:fs').constants.COPYFILE_EXCL);
      changed.push({ target, previous, temp });
      await fs.rename(temp, target);
    }
    if (!checked) {
      try {
        await checkBoundary({ rootDir, stagingDir: stage });
      } catch {
        boundaryFailed = true;
        throw Error();
      }
    }
    if (finalize) await finalize();
  } catch {
    let failed = false;
    for (const item of changed.reverse()) {
      try {
        await fs.rm(item.temp, { force: true });
        if (item.previous) {
          await fs.writeFile(item.temp, item.previous.bytes, {
            flag: 'wx',
            mode: item.previous.mode,
          });
          await fs.rename(item.temp, item.target);
        } else await fs.rm(item.target, { force: true });
      } catch {
        failed = true;
      }
    }
    throw new Error(
      failed ? 'restore-failed' : boundaryFailed ? 'boundary-failed' : 'install-failed',
    );
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    try {
      if (lockFile) {
        try {
          await lockFile.close();
        } finally {
          await fs.unlink(path.join(rootDir, '.install.lock'));
        }
      }
    } finally {
      locks.delete(lock);
    }
  }
}
async function installInitial(options) {
  const temp = `${options.activeFile}.${crypto.randomBytes(16).toString('hex')}`;
  try {
    await fs.writeFile(temp, options.sha, { flag: 'wx', mode: 0o600 });
    await installRoot({ ...options, finalize: () => fs.rename(temp, options.activeFile) });
  } catch (error) {
    if (['boundary-failed', 'restore-failed', 'install-failed'].includes(error.message))
      throw error;
    throw new Error('install-failed');
  } finally {
    await fs.rm(temp, { force: true });
  }
}
module.exports = { installRoot, installInitial };

async function installedMain() {
  const system = '/Library/Application Support/Foliome';
  const base = path.join(system, 'base');
  const entry = path.join(base, 'install-root.js');
  const node = path.join(base, 'node');
  const [sha, mode] = process.argv.slice(2);
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    process.getuid() !== 0 ||
    process.geteuid() !== 0 ||
    process.getgid() !== 0 ||
    process.getegid() !== 0 ||
    (process.argv.length !== 3 && (process.argv.length !== 4 || mode !== '--initial')) ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    Object.keys(process.env).length !== 0 ||
    process.execArgv.join(' ') !== '--disable-sigusr1' ||
    process.cwd() !== '/' ||
    process.execPath !== node ||
    process.argv[1] !== entry ||
    __filename !== entry
  )
    throw Error('boundary-entry');
  process.umask(0o077);
  async function trusted(file, mode, directory) {
    const s = await fs.lstat(file);
    if (
      (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
      s.uid !== 0 ||
      (mode === undefined ? (s.mode & 0o7022) !== 0 : s.gid !== 0 || (s.mode & 0o7777) !== mode)
    )
      throw Error('boundary-entry');
    const { stdout } = await run('/bin/ls', ['-lde', file], { cwd: '/', env: {}, timeout: 3000 });
    const acl = stdout.trimEnd().split('\n').slice(1);
    if (
      acl.some((line) => mode !== undefined || !/^\s*\d+: group:everyone deny delete$/.test(line))
    )
      throw Error('boundary-entry');
  }
  for (const dir of ['/', '/Library', '/Library/Application Support'])
    await trusted(dir, undefined, true);
  for (const dir of [system, base]) await trusted(dir, 0o755, true);
  for (const name of [
    'activation-state.js',
    'first-install.js',
    'installation-release.js',
    'installed-config.ts',
    'install-owner.js',
    'install-platform.js',
    'install-production.js',
    'install-root.js',
    'install-transaction.js',
    'launcher.js',
    'publisher-verification.js',
    'read-release-file.pl',
    'release-materialization.js',
    'release-observation.js',
    'release-origin.js',
    'release-pipeline.js',
    'release-policy.ts',
    'system-install-layout.js',
  ])
    await trusted(path.join(base, name), 0o644, false);
  for (const file of [node, path.join(base, 'launch')]) await trusted(file, 0o755, false);
  await trusted(path.join(system, 'bootstrap-root.pl'), 0o644, false);
  await require('./install-production.js').installApprovedSystem(sha, mode === '--initial');
}

if (require.main === module) {
  installedMain().catch((error) => {
    const code =
      /^(boundary-(entry|permissions|base|account|config|pf|ssh|program|state)|release-(verification|stage|materialization)|restore-failed)$/.test(
        error.message,
      )
        ? error.message
        : 'install-failed';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
