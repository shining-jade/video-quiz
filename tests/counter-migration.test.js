const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../counter-migration.js');

function fakeDb(initial) {
  const docs = new Map(Object.entries(initial));
  const ref = path => ({ path });
  const snapshot = path => {
    const value = docs.get(path);
    return { exists: value !== undefined, data: () => value, id: path.split('/').at(-1) };
  };
  const query = path => ({ path, async get() {
    const prefix = path + '/';
    const child = [...docs.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'));
    return { docs: child.map(([id, data]) => ({ id: id.split('/').at(-1), data: () => data })), size: child.length };
  }});
  return {
    docs,
    collection(path) { return path === 'quiz_sets' ? { async get() {
      const sets = [...docs.entries()].filter(([key]) => key.startsWith('quiz_sets/') && !key.slice(10).includes('/'));
      return { docs: sets.map(([key, data]) => ({ id: key.split('/').at(-1), data: () => data })) };
    }} : query(path); },
    doc: ref,
    async runTransaction(handler) {
      const updates = [];
      const transaction = {
        async get(target) { return typeof target.get === 'function' ? target.get() : snapshot(target.path); },
        update(target, patch) { updates.push([target.path, patch]); }
      };
      const result = await handler(transaction);
      updates.forEach(([path, patch]) => docs.set(path, { ...docs.get(path), ...patch }));
      return result;
    }
  };
}

test('counter migration dry-run is read-only and plans authoritative child counts', async () => {
  const db = fakeDb({
    'quiz_sets/a': { title: 'A' },
    'quiz_sets/a/collaborators/e@school.kr': { email: 'e@school.kr' },
    'images/a/q/v0q0': { data: 'image' }
  });
  const report = await migration.runCounterBackfill({ db, projectId: 'demo-video-quiz' });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plannedCount, 1);
  assert.equal(db.docs.get('quiz_sets/a').imageCount, undefined);
  assert.equal(report.safeToDeployStrictRules, false);
});

test('counter migration apply is exact-project gated, idempotent, and concurrency-safe on reread', async () => {
  const db = fakeDb({
    'quiz_sets/a': { title: 'A' },
    'quiz_sets/a/collaborators/e@school.kr': { email: 'e@school.kr' }
  });
  await assert.rejects(migration.runCounterBackfill({ db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'wrong' }), /exact project/);
  const applied = await migration.runCounterBackfill({ db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'demo-video-quiz' });
  assert.equal(applied.appliedCount, 1);
  assert.deepEqual(db.docs.get('quiz_sets/a'), { title: 'A', collaboratorCount: 1, imageCount: 0 });
  const retry = await migration.runCounterBackfill({ db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'demo-video-quiz' });
  assert.equal(retry.plannedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
});
