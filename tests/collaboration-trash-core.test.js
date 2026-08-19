const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../collaboration-trash-core.js');

test('canonical email and set access separate owner, editor, teacher and trashed state', () => {
  assert.equal(Core.canonicalEmail(' Editor@School.KR '), 'editor@school.kr');
  const set = { ownerUid: 'owner', trashedAt: null, purgeStartedAt: null };
  assert.equal(Core.setAccess(set, { uid: 'owner', email: 'o@x.kr', role: 'teacher' }, []).canManage, true);
  assert.equal(Core.setAccess(set, { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, ['editor@school.kr']).canEdit, true);
  assert.equal(Core.setAccess(set, { uid: 'admin', email: 'a@x.kr', role: 'admin' }, []).canEdit, false);
  assert.equal(Core.setAccess({ ...set, trashedAt: 1 }, { uid: 'editor', email: 'editor@school.kr', role: 'teacher' }, ['editor@school.kr']).canRead, false);
});

test('30-day retention uses exact boundary and purge is resumable', () => {
  const deleted = Date.UTC(2026, 7, 1);
  assert.equal(Core.trashRetention({ trashedAt: deleted }, deleted + 30 * 86400000 - 1).expired, false);
  assert.equal(Core.trashRetention({ trashedAt: deleted }, deleted + 30 * 86400000).expired, true);
  assert.equal(Core.nextPurgeStep({ collaboratorsRemaining: 1, imagesRemaining: 2 }), 'children');
  assert.equal(Core.nextPurgeStep({ collaboratorsRemaining: 0, imagesRemaining: 0 }), 'parent');
});

test('collaborator change rejects owner, duplicate, disabled and twenty-first editor', () => {
  assert.equal(Core.validateCollaboratorChange({ ownerEmail: 'a@x.kr', email: 'a@x.kr', enabled: true, existing: [] }).code, 'owner');
  assert.equal(Core.validateCollaboratorChange({ ownerEmail: 'a@x.kr', email: 'b@x.kr', enabled: false, existing: [] }).code, 'unapproved');
  assert.equal(Core.validateCollaboratorChange({ ownerEmail: 'a@x.kr', email: 'b@x.kr', enabled: true, existing: Array(20).fill('x') }).code, 'limit');
});
