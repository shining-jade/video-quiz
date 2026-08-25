'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('Firebase wires the exact public-library composite index', () => {
  const firebase = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  assert.equal(firebase.firestore.indexes, 'firestore.indexes.json');

  const indexes = JSON.parse(fs.readFileSync(
    path.join(root, 'firestore.indexes.json'), 'utf8'
  ));
  assert.deepEqual(indexes.fieldOverrides, []);
  assert.deepEqual(indexes.indexes.filter(index =>
    index.collectionGroup === 'sessions'), [{
    collectionGroup: 'sessions',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'sourceOwnerUid', order: 'ASCENDING' },
      { fieldPath: 'sourceSetId', order: 'ASCENDING' },
      { fieldPath: 'createdAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' }
    ]
  }]);
  assert.deepEqual(indexes.indexes.filter(index =>
    index.collectionGroup === 'published_quiz_sets'), [{
    collectionGroup: 'published_quiz_sets',
    queryScope: 'COLLECTION',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'updatedAt', order: 'DESCENDING' },
      { fieldPath: '__name__', order: 'DESCENDING' }
    ]
  }]);
});
