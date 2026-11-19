const assert = require('node:assert/strict');
const test = require('node:test');
const { checkExecutorGroups } = require('../../base/install-platform.js');

test('rejects an ambiguous group identifier in the local or effective directory', async () => {
  const guid = '11111111-2222-4333-8444-555555555555';
  const name = 'com.apple.sharepoint.group.2';
  const group =
    'NestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C\nPrimaryGroupID: 702\nRecordName: ' + name;
  const match = name + '\t\tPrimaryGroupID = (\n    702\n)';
  for (const node of ['.', '/Search']) {
    await assert.rejects(
      checkExecutorGroups('20 12 61 702', guid, async (_program: string, args: string[]) =>
        args[1] !== '-search'
          ? group
          : args[0] === node
            ? match + '\nother-group\t\tPrimaryGroupID = (\n    702\n)'
            : match,
      ),
      { message: 'boundary-account' },
    );
  }
});
