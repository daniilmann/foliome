const { openSync, writeFileSync, closeSync, constants } = require('node:fs') as typeof import('node:fs');

type Event = 'started' | 'browser-event' | 'channel-denied' | 'protocol-unavailable';
function create(file: string) {
  const entries: string[] = [];
  return (event: Event) => {
    try {
      entries.push(event);
      if (entries.length > 128) entries.shift();
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, entries.join('\n') + '\n'); } finally { closeSync(fd); }
    } catch { /* Diagnostics never influence the protocol. */ }
  };
}
export declare const createTechnicalLog: typeof create;
declare const exports: { createTechnicalLog: typeof create };
exports.createTechnicalLog = create;
