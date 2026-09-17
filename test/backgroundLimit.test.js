const test = require('node:test');
const assert = require('node:assert');
const { background, flush, setMaxConcurrent } = require('../lib/background');

/* A snapshot sync releases one Drive upload per SPG in the same tick — about a thousand of
   them. Google does not refuse a burst that size, it closes the connections, and the error
   that comes back has no HTTP status to reason about. The ceiling is what keeps the burst
   from forming; these tests hold it to that, and to leaving the request path alone. */

const tick = () => new Promise(r => setTimeout(r, 0));

async function runUnderCeiling(ceiling, jobs) {
  setMaxConcurrent(ceiling);
  let active = 0;
  let peak = 0;
  const finished = [];

  try {
    for (let i = 0; i < jobs; i++) {
      background(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        finished.push(i);
      }, `job-${i}`);
    }
    await flush();
  } finally {
    setMaxConcurrent(0);
  }

  return { peak, finished };
}

test('a ceiling caps how many run at once', async () => {
  const { peak, finished } = await runUnderCeiling(3, 12);
  assert.equal(peak, 3, `expected at most 3 at once, saw ${peak}`);
  assert.equal(finished.length, 12, 'every job still ran');
});

test('no ceiling is the default, so the request path is untouched', async () => {
  const { peak, finished } = await runUnderCeiling(0, 10);
  assert.equal(peak, 10, 'without a ceiling everything starts together');
  assert.equal(finished.length, 10);
});

test('flush waits for queued work, not only for what is already running', async () => {
  // The bug this guards against: a queued job that flush() never knew about, so the script
  // exits believing it wrote snapshots it had not started yet.
  setMaxConcurrent(2);
  const done = [];
  try {
    for (let i = 0; i < 9; i++) {
      background(async () => { await tick(); done.push(i); }, `queued-${i}`);
    }
    await flush();
    assert.equal(done.length, 9, `expected all 9 finished before flush returned, got ${done.length}`);
  } finally {
    setMaxConcurrent(0);
  }
});

test('a job that throws does not stall the queue behind it', async () => {
  setMaxConcurrent(1);
  const done = [];
  try {
    background(async () => { throw new Error('sengaja gagal'); }, 'boom');
    background(async () => { done.push('after'); }, 'after');
    await flush();
    assert.deepEqual(done, ['after']);
  } finally {
    setMaxConcurrent(0);
  }
});

test('a plain promise is still accepted, for callers with nothing to defer', async () => {
  let ran = false;
  await background(Promise.resolve().then(() => { ran = true; }), 'legacy');
  await flush();
  assert.equal(ran, true);
});
