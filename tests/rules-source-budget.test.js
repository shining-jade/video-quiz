'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { measureRulesSource } = require('../rules-source-metrics.js');

test('Firestore Rules source stays within the released compiler budget', async t => {
  const source = fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8');
  const metrics = measureRulesSource(source);

  await t.test('uses no more than 150000 UTF-8 bytes', () => {
    assert.ok(metrics.bytes <= 150000, `bytes ${metrics.bytes} exceeds 150000`);
  });
  await t.test('uses no more than 3000 physical lines', () => {
    assert.ok(metrics.lines <= 3000, `lines ${metrics.lines} exceeds 3000`);
  });
  await t.test('declares no more than 210 functions', () => {
    assert.ok(metrics.functions <= 210, `functions ${metrics.functions} exceeds 210`);
  });
});
