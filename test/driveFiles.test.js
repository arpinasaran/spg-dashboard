const test = require('node:test');
const assert = require('node:assert');
const driveFiles = require('../lib/driveFiles');

/* The creator hook is what lets a snapshot exist at all: a service account has no Drive
   storage quota, so it can update a file forever but can never create one. Only
   scripts/sync-snapshot.js registers a creator, and only because a signed-in human is
   sitting next to it there. These tests pin the two halves of that arrangement — that a
   registered creator is used and gets what it needs, and that nothing is registered by
   default, so a deployed instance still takes the plain files.create path. */

test('a registered creator is used when the file does not exist yet', async () => {
  const calls = [];
  driveFiles.setCreator(async (args) => {
    calls.push(args);
    return { id: 'made-by-human', name: args.name };
  });

  try {
    const out = await driveFiles.drive.writeJson({
      name: 'poi-batam-hub.json',
      value: { rows: 3 },
      parentId: 'folder-1',
    });

    assert.deepEqual(out, { id: 'made-by-human', name: 'poi-batam-hub.json' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'poi-batam-hub.json');
    assert.equal(calls[0].parentId, 'folder-1');
    // The creator writes the real content, not a placeholder to be filled in later.
    assert.deepEqual(calls[0].value, { rows: 3 });
  } finally {
    driveFiles.setCreator(null);
  }
});

test('an existing file is updated by the service account, never handed to the creator', async () => {
  let creatorCalled = false;
  driveFiles.setCreator(async () => { creatorCalled = true; return { id: 'x' }; });

  try {
    // No credentials are loaded in tests, so the service account path fails on auth. That it
    // fails there rather than reaching the creator is exactly the assertion: an id means an
    // update, and updating is the one thing the service account is allowed to do.
    await assert.rejects(
      () => driveFiles.drive.writeJson({ id: 'existing-id', name: 'roster.json', value: {} }),
      (err) => !/creator/i.test(err.message),
    );
    assert.equal(creatorCalled, false);
  } finally {
    driveFiles.setCreator(null);
  }
});

test('no creator is registered by default', async () => {
  // A deployed instance registers nothing, and must keep the original behaviour: attempt
  // files.create and let it fail loudly rather than silently doing something else.
  await assert.rejects(() => driveFiles.drive.writeJson({
    name: 'roster.json', value: {}, parentId: 'folder-1',
  }));
});
