'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { measureRulesSource } = require('../rules-source-metrics.js');

test('Firestore Rules source stays within the post-503 compiler characterization budget', async t => {
  const source = fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8');
  const metrics = measureRulesSource(source);

  await t.test('uses no more than 130000 UTF-8 bytes', () => {
    assert.ok(metrics.bytes <= 130000, `bytes ${metrics.bytes} exceeds 130000`);
  });
  await t.test('uses no more than 2700 physical lines', () => {
    assert.ok(metrics.lines <= 2700, `lines ${metrics.lines} exceeds 2700`);
  });
  await t.test('declares no more than 190 functions', () => {
    assert.ok(metrics.functions <= 190, `functions ${metrics.functions} exceeds 190`);
  });
});
