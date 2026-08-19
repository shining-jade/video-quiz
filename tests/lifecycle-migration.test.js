const test = require('node:test');
const assert = require('node:assert/strict');
const { planLifecycleBackfill, runLifecycleBackfill } = require('../lifecycle-migration.js');

function fakeDb(initial) {
  const docs = new Map(Object.entries(initial));
  const commits = [];
  return {
    docs,
    commits,
    collection() {
      return { async get() {
        return { docs: [...docs.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) })) };
      } };
    },
    doc(path) { return { path }; },
    batch() {
      const updates = [];
      return {
        update(ref, patch) { updates.push({ ref, patch }); },
        async commit() {
          commits.push(updates.slice());
          updates.forEach(({ ref, patch }) => {
            const id = ref.path.slice('quiz_sets/'.length);
            docs.set(id, { ...docs.get(id), ...patch });
          });
        }
      };
    }
  };
}

test('lifecycle backfill plans only legacy active sets and skips trash/present state', () => {
  const plan = planLifecycleBackfill([
    { id: 'legacy', data: { title: 'A' } },
    { id: 'active', data: { lifecycleState: 'active' } },
    { id: 'trash', data: { trashedAt: 1 } },
    { id: 'purging', data: { purgeStartedAt: 1 } }
  ]);
  assert.deepEqual(plan.planned.map(item => item.id), ['legacy']);
  assert.equal(plan.skipped.length, 3);
});

test('lifecycle backfill dry-run is read-only and apply is idempotent in batches', async () => {
  const db = fakeDb({ legacy: { title: 'A' }, legacy2: { title: 'B' } });
  const dry = await runLifecycleBackfill({ db, projectId: 'demo-video-quiz' });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.plannedCount, 2);
  assert.equal(db.commits.length, 0);
  await assert.rejects(
    runLifecycleBackfill({ db, projectId: 'video-quiz-65798', apply: true, confirmProject: 'wrong' }),
    /exact project/
  );
  const applied = await runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'demo-video-quiz', batchSize: 1
  });
  assert.equal(applied.appliedCount, 2);
  assert.equal(db.commits.length, 2);
  const retry = await runLifecycleBackfill({
    db, projectId: 'demo-video-quiz', apply: true, confirmProject: 'demo-video-quiz'
  });
  assert.equal(retry.plannedCount, 0);
  assert.equal(retry.safeToDeployStrictRules, true);
});
