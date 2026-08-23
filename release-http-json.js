'use strict';

const https = require('node:https');

function acquireAccessToken() {
  const { applicationDefault } = require('firebase-admin/app');
  return applicationDefault().getAccessToken().then(value => {
    const token = typeof value === 'string' ? value : value && value.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('Application Default Credentials returned no access token.');
    }
    return token;
  });
}

function requestJson({ method, url, accessToken, payload, signal }) {
  if (!['GET', 'PATCH'].includes(method)) {
    return Promise.reject(new Error('Release evidence transport permits GET and PATCH only.'));
  }
  if (!signal || typeof signal.addEventListener !== 'function') {
    return Promise.reject(new Error('Release evidence transport requires an AbortSignal.'));
  }
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Request aborted.'));
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const encoded = payload == null ? null : JSON.stringify(payload);
    const headers = {};
    if (accessToken) headers.authorization = 'Bearer ' + accessToken;
    if (encoded != null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(encoded, 'utf8');
    }
    let settled = false;
    let pendingError = null;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortRequest);
      complete(value);
    };
    const rejectClosed = error => {
      if (settled) return;
      const failure = error || Object.assign(
        new Error('Release evidence transport closed before a complete response.'),
        { code: 'ECONNRESET' }
      );
      if (method === 'PATCH') failure.mutationOutcomeUnknown = true;
      settle(reject, failure);
    };
    const request = https.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: endpoint.pathname + endpoint.search,
      method,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => {
        if (settled) return;
        if (!pendingError) pendingError = error;
        request.destroy(pendingError);
      });
      response.on('close', () => {
        if (settled) return;
        if (!pendingError) pendingError = Object.assign(
          new Error('Release evidence response closed before completion.'),
          { code: 'ECONNRESET' }
        );
        if (!request.destroyed) request.destroy(pendingError);
        rejectClosed(pendingError);
      });
      response.on('end', () => {
        if (settled || pendingError) return;
        const statusCode = response.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          settle(resolve, { statusCode, body: text ? JSON.parse(text) : {} });
        } catch (error) {
          if (statusCode < 200 || statusCode >= 300) {
            settle(resolve, { statusCode, body: null });
          } else {
            settle(reject, new Error('Provider returned invalid JSON.', { cause: error }));
          }
        }
      });
    });
    function abortRequest() {
      if (settled) return;
      pendingError = signal.reason || new Error('Request aborted.');
      request.destroy(pendingError);
    }
    request.on('error', error => {
      if (settled) return;
      if (!pendingError) pendingError = error;
    });
    request.on('close', () => rejectClosed(pendingError));
    signal.addEventListener('abort', abortRequest, { once: true });
    request.end(encoded == null ? undefined : encoded);
  });
}

module.exports = { acquireAccessToken, requestJson };
