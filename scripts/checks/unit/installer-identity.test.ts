const assert = require('node:assert/strict');
const test = require('node:test');
const { accountAttributes, checkExecutorGroups } = require('../../../base/install-platform.js');

const guid = '11111111-2222-4333-8444-555555555555';
const builtIn = (gid: string) => 'ABCDEFAB-CDEF-ABCD-EFAB-CDEF000000' + gid;
const records = {
  ssh:
    'GroupMembers: ' +
    guid +
    '\nGroupMembership: executor\nPrimaryGroupID: 399\nRecordName: com.apple.access_ssh',
  print:
    'NestedGroups: ' +
    builtIn('3D') +
    ' ' +
    builtIn('62') +
    '\nPrimaryGroupID: 100\nRecordName: _lpoperator',
  share:
    'NestedGroups: ' +
    builtIn('0C') +
    '\nPrimaryGroupID: 702\nRecordName: com.apple.sharepoint.group.2',
};
const groups = '20 12 61 399 702 100 701';
function directory(overrides: Record<string, string> = {}) {
  const groupRecords: Record<string, string> = {
    '/Groups/com.apple.access_ssh': records.ssh,
    '/Groups/_lpoperator': records.print,
    '/Groups/com.apple.sharepoint.group.2': records.share,
    ...overrides,
  };
  return async (program: string, args: string[]) => {
    assert.equal(program, '/usr/bin/dscl');
    assert.deepEqual(args.slice(0, 2), ['.', '-read']);
    assert.ok(Object.hasOwn(groupRecords, args[2]));
    return groupRecords[args[2]];
  };
}

test('reads the native macOS hidden attribute without accepting ambiguous records', () => {
  const hidden = 'dsAttrTypeNative:IsHidden: 1';
  const record = ['RecordName: executor', 'GeneratedUID: ' + guid, hidden];
  const fields = ['RecordName', 'GeneratedUID', 'IsHidden'];
  assert.equal(accountAttributes(record.join('\n'), fields).IsHidden, '1');
  for (const lines of [
    [...record, 'IsHidden: 1'],
    [record[0], 'IsHidden: 1', hidden],
    [record[0], record[1], 'dsAttrTypeStandard:IsHidden: 1'],
    [record[0], record[1], 'dsAttrTypeNative:GeneratedUID: ' + guid],
  ]) {
    assert.throws(() => accountAttributes(lines.join('\n'), fields), {
      message: 'boundary-account',
    });
  }
});

test('admits the local SSH access group and inherited macOS groups only with verified records', async () => {
  await checkExecutorGroups('20 12 61', guid, directory());
  await checkExecutorGroups(groups, guid, directory());
  await assert.rejects(checkExecutorGroups(groups + ' 80', guid, directory()), {
    message: 'boundary-account',
  });
  await assert.rejects(
    checkExecutorGroups(groups, '99999999-2222-4333-8444-555555555555', directory()),
    { message: 'boundary-account' },
  );
  for (const [name, record] of [
    [
      'com.apple.access_ssh',
      records.ssh.replace('GroupMembership: executor', 'GroupMembership: other'),
    ],
    ['com.apple.access_ssh', records.ssh.replace('PrimaryGroupID: 399', 'PrimaryGroupID: 398')],
    ['_lpoperator', records.print.replace(builtIn('3D'), builtIn('0C'))],
    ['_lpoperator', records.print + '\nGroupMembership: executor'],
    ['com.apple.sharepoint.group.2', records.share.replace(builtIn('0C'), builtIn('50'))],
    ['com.apple.sharepoint.group.2', records.share + '\nGroupMembers: ' + guid],
  ]) {
    await assert.rejects(
      checkExecutorGroups(groups, guid, directory({ ['/Groups/' + name]: record })),
      { message: 'boundary-account' },
    );
  }
});
