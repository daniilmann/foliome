type Entry = {
  type: string;
  uid: number;
  mode: number;
  links: number;
  acl: string[];
};
type Evidence = {
  ownerUid: number;
  ownerName: string;
  executorName: string;
  home: Entry;
  app: Entry;
  data: Entry;
  channel: Entry;
  socket: Entry;
  adminMembers: string[];
  canary: string;
};

function classify(input: Evidence) {
  const validName = (name: string) => typeof name === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name);
  const validOwner = Number.isSafeInteger(input.ownerUid) && input.ownerUid > 0 && validName(input.ownerName) && validName(input.executorName) && input.ownerName !== input.executorName;
  const check = (entry: Entry, type: string, uid: number, mode: number, acl: string[]) =>
    validOwner && !!entry && entry.type === type && entry.uid === uid && entry.mode === mode && Number.isSafeInteger(entry.links) && entry.links >= 1 &&
    (type !== 'socket' || entry.links === 1) && Array.isArray(entry.acl) && entry.acl.length === acl.length &&
    entry.acl.every((line, index) => line === acl[index]);
  return {
    permissions: {
      home: check(input.home, 'directory', input.ownerUid, 0o700, []),
      app: check(input.app, 'directory', input.ownerUid, 0o700, []),
      data: check(input.data, 'directory', input.ownerUid, 0o700, []),
      channel: check(input.channel, 'directory', 0, 0o700, [`0: user:${input.executorName} allow search`]),
      socket: check(input.socket, 'socket', input.ownerUid, 0o600, [`0: user:${input.executorName} allow read,write`]),
    },
    adminMembers: input.adminMembers,
    canary: input.canary,
  };
}

export declare const classifySystemObservation: typeof classify;
declare const exports: { classifySystemObservation: typeof classify };
exports.classifySystemObservation = classify;
