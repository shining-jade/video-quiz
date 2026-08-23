'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { requestJson } = require('../release-http-json.js');

test('release evidence transport rejects a response close before complete JSON', async t => {
  const originalRequest = https.request;
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.statusCode = 200;
  request.destroy = error => request.emit('error', error);
  https.request = (_options, respond) => {
    request.end = () => {
      respond(response);
      setImmediate(() => response.emit('close'));
    };
    return request;
  };
  t.after(() => { https.request = originalRequest; });

  const controller = new AbortController();
  const result = await Promise.race([
    requestJson({
      method: 'GET', url: 'https://example.invalid/resource',
      accessToken: 'private', signal: controller.signal
    }).then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('deadline'), 50))
  ]);

  assert.notEqual(result, 'deadline');
  assert.notEqual(result, 'resolved');
  assert.equal(result.code, 'ECONNRESET');
});

test('release evidence PATCH abort settles only after transport close and marks uncertainty', async t => {
  const originalRequest = https.request;
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = error => {
    request.destroyed = true;
    request.emit('error', error);
  };
  https.request = () => {
    request.end = () => {};
    return request;
  };
  t.after(() => { https.request = originalRequest; });

  const controller = new AbortController();
  const timeout = Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' });
  let settlement = 'pending';
  const attempted = requestJson({
    method: 'PATCH', url: 'https://example.invalid/resource',
    accessToken: 'private', payload: { fixed: true }, signal: controller.signal
  }).then(() => { settlement = 'resolved'; }, error => { settlement = error; });

  controller.abort(timeout);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settlement, 'pending');
  request.emit('close');
  await attempted;
  assert.equal(settlement, timeout);
  assert.equal(settlement.mutationOutcomeUnknown, true);
});
