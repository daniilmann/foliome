import type { Server, Socket } from 'node:net';
const { spawn } = require('node:child_process') as typeof import('node:child_process');
const { createServer } = require('node:net') as typeof import('node:net');
const { TextDecoder } = require('node:util') as typeof import('node:util');

export declare const createAdmittedChannel: typeof create;
declare const exports: { createAdmittedChannel: typeof create };

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 2000;
const HELPER_OUTPUT_BYTES = 32;
const METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call',
  'ping',
]);
const PERL = [
  'use strict; use warnings; use Fcntl qw(F_GETFL F_SETFL O_NONBLOCK);',
  'open(my $peer, "+<&=3") or die;',
  'my $credentials=getsockopt($peer, 0, 1) or die;',
  'die unless length($credentials) >= 12;',
  'my ($version,$uid)=unpack("I2",$credentials);',
  'die unless $version == 0;',
  'my $flags=fcntl($peer,F_GETFL,0); die unless defined($flags);',
  'defined(fcntl($peer,F_SETFL,$flags|O_NONBLOCK)) or die;',
  'print "$uid\\n";',
].join('\n');

type Request = {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type Options = {
  expectedUid: number;
  maxLineBytes: number;
  peerUid?: (socket: Socket) => Promise<number>;
  onRequest?: (request: Request) => unknown | Promise<unknown>;
  createHandler?: () => (request: Request) => unknown | Promise<unknown>;
  onDenied: (code: string) => void;
};

function systemPeerUid(socket: Socket): Promise<number> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('unsupported'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = Buffer.alloc(0);
    const child = spawn('/usr/bin/perl', ['-e', PERL], {
      env: {},
      stdio: ['ignore', 'pipe', 'ignore', socket],
    });
    const finish = (uid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (uid === undefined) {
        child.kill();
        reject(new Error('peer-uid'));
      } else resolve(uid);
    };
    const timer = setTimeout(() => finish(), HELPER_TIMEOUT_MS);
    child.on('error', () => finish());
    if (!child.stdout) return finish();
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > HELPER_OUTPUT_BYTES) return finish();
      output = Buffer.concat([output, chunk]);
    });
    child.stdout.on('error', () => finish());
    child.on('close', (code) => {
      const value = output.toString('ascii');
      if (code !== 0 || !/^(0|[1-9][0-9]*)\n$/.test(value)) return finish();
      const uid = Number(value.slice(0, -1));
      finish(Number.isSafeInteger(uid) && uid <= 0xffffffff ? uid : undefined);
    });
  });
}

function parseRequest(bytes: Buffer): Request {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('format');
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
    object.jsonrpc !== '2.0' ||
    typeof object.method !== 'string' ||
    !METHODS.has(object.method) ||
    ('id' in object &&
      !(
        typeof object.id === 'string' ||
        (typeof object.id === 'number' && Number.isSafeInteger(object.id) && object.id >= 0)
      )) ||
    ('params' in object &&
      (object.params === null || typeof object.params !== 'object' || Array.isArray(object.params)))
  ) {
    throw new Error('format');
  }
  return object as Request;
}

function create(options: Options): Server {
  if (
    !Number.isSafeInteger(options.expectedUid) ||
    options.expectedUid < 0 ||
    options.expectedUid > 0xffffffff ||
    !Number.isSafeInteger(options.maxLineBytes) ||
    options.maxLineBytes < 1 ||
    options.maxLineBytes > MAX_LINE_BYTES ||
    (typeof options.onRequest !== 'function' && typeof options.createHandler !== 'function') ||
    (options.onRequest !== undefined && typeof options.onRequest !== 'function') ||
    (options.createHandler !== undefined && typeof options.createHandler !== 'function') ||
    typeof options.onDenied !== 'function' ||
    (options.peerUid !== undefined && typeof options.peerUid !== 'function')
  )
    throw new TypeError('invalid channel options');

  const server = createServer({ pauseOnConnect: true }, (socket) => {
    let closed = false;
    let buffered = Buffer.alloc(0);
    let pending = Promise.resolve();
    const deny = (code: string) => {
      if (closed) return;
      closed = true;
      socket.destroy();
      try {
        options.onDenied(code);
      } catch {
        /* Denial reporting cannot reopen the channel. */
      }
    };
    socket.on('error', () => {
      closed = true;
    });
    socket.on('close', () => {
      closed = true;
    });
    Promise.resolve()
      .then(() => (options.peerUid ?? systemPeerUid)(socket))
      .then((uid) => {
        if (closed) return;
        if (!Number.isSafeInteger(uid) || uid !== options.expectedUid) return deny('peerUid');
        let handler: Options['onRequest'];
        try {
          handler = options.createHandler ? options.createHandler() : options.onRequest;
        } catch {
          return deny('handler');
        }
        if (typeof handler !== 'function') return deny('handler');
        socket.on('data', (chunk: Buffer) => {
          let start = 0;
          while (!closed && start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const end = newline === -1 ? chunk.length : newline;
            const part = chunk.subarray(start, end);
            if (buffered.length + part.length > options.maxLineBytes) return deny('format');
            buffered = Buffer.concat([buffered, part]);
            if (newline === -1) break;
            let request: Request;
            try {
              request = parseRequest(buffered);
            } catch {
              return deny('format');
            }
            buffered = Buffer.alloc(0);
            socket.pause();
            pending = pending
              .then(async () => {
                if (closed) return;
                const response = await handler(request);
                if (closed || response === undefined) return;
                const serialized = JSON.stringify(response);
                if (serialized === undefined) throw new Error('response');
                const line = Buffer.from(`${serialized}\n`);
                if (line.length > MAX_RESPONSE_BYTES) throw new Error('response');
                if (!socket.write(line)) {
                  await new Promise<void>((resolve) => {
                    const done = () => {
                      socket.off('drain', done);
                      socket.off('close', done);
                      resolve();
                    };
                    socket.once('drain', done);
                    socket.once('close', done);
                  });
                }
              })
              .catch(() => deny('handler'));
            start = newline + 1;
          }
          void pending.then(() => {
            if (!closed) socket.resume();
          });
        });
        socket.on('end', () => {
          if (buffered.length > 0) deny('format');
        });
        socket.resume();
      })
      .catch(() => deny('peerUid'));
  });
  const listen = server.listen.bind(server);
  server.listen = ((...args: unknown[]) => {
    const first = args[0];
    if (!(typeof first === 'string' && first.startsWith('/') && !first.includes('\0'))) {
      throw new TypeError('Unix socket path required');
    }
    return (listen as (...values: unknown[]) => Server)(...args);
  }) as Server['listen'];
  return server;
}

exports.createAdmittedChannel = create;
