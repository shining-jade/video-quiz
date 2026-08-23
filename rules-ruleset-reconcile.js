'use strict';

// `rulesets.create` is a POST and is not idempotent. On 2026-08-22 the R19
// release read HTTP 503 from it and recorded that nothing had been written,
// but the ruleset had in fact been persisted server-side -- only the response
// was lost. A retry would then have produced a second ruleset holding
// identical source.
//
// So a non-2xx create proves nothing about whether the write landed. This
// module reconciles the question with read-only requests: it lists the
// project's rulesets, keeps the ones that were not present before the attempt,
// and hashes their source to see whether the intended source is already there.
//
// It deliberately does not adopt what it finds. Turning a failed release into
// a live one is a human decision, so the caller stays fail-closed and only
// records the answer.

const crypto = require('node:crypto');

const PAGE_SIZE = 100;
const MAX_PAGES = 40;
// Each source readback pulls the full ruleset text, so cap how many a single
// reconciliation will fetch.
const MAX_INSPECT = 25;
// Allowance for clock difference when the caller could not snapshot names and
// has to fall back to filtering by create time.
const CLOCK_SKEW_MS = 10 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function httpSuccess(response) {
  return Boolean(response) && response.statusCode >= 200 && response.statusCode < 300;
}

function skewedLowerBound(createdAfter) {
  const parsed = Date.parse(createdAfter);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed - CLOCK_SKEW_MS).toISOString();
}

async function listRulesets({ getJson, apiRoot, projectId, accessToken }) {
  const rulesets = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = apiRoot + 'projects/' + projectId + '/rulesets?pageSize=' + PAGE_SIZE +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    let response;
    try {
      response = await getJson({ url, accessToken, method: 'GET' });
    } catch (_) {
      return { readable: false, rulesets, response: null, transportFailed: true };
    }
    if (!httpSuccess(response)) return { readable: false, rulesets, response };
    const page_ = Array.isArray(response.body.rulesets) ? response.body.rulesets : [];
    for (const ruleset of page_) {
      if (!ruleset || typeof ruleset.name !== 'string' || !ruleset.name) continue;
      rulesets.push({
        name: ruleset.name,
        createTime: typeof ruleset.createTime === 'string' ? ruleset.createTime : ''
      });
    }
    pageToken = typeof response.body.nextPageToken === 'string' ? response.body.nextPageToken : '';
    if (!pageToken) return { readable: true, rulesets, response };
  }
  return { readable: false, rulesets, response: null, truncated: true };
}

function selectCandidates(rulesets, { knownRulesetNames, createdAfter }) {
  const known = new Set(Array.isArray(knownRulesetNames) ? knownRulesetNames : []);
  let candidates = rulesets;
  if (known.size > 0) {
    candidates = candidates.filter(ruleset => !known.has(ruleset.name));
  } else if (createdAfter) {
    const lowerBound = skewedLowerBound(createdAfter);
    if (lowerBound) {
      candidates = candidates.filter(
        ruleset => ruleset.createTime && ruleset.createTime >= lowerBound
      );
    }
  }
  // Newest first: the write we are looking for is the most recent one.
  return candidates.slice().sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
}

async function sourceMatches({ getJson, apiRoot, accessToken, rulesetName, expectedSha256 }) {
  let response;
  try {
    response = await getJson({ url: apiRoot + rulesetName, accessToken, method: 'GET' });
  } catch (_) {
    return { readable: false, matches: false, transportFailed: true };
  }
  if (!httpSuccess(response)) return { readable: false, matches: false };
  const files = response.body && response.body.source && response.body.source.files;
  if (!Array.isArray(files) || files.length !== 1) return { readable: true, matches: false };
  const file = files[0];
  if (!file || typeof file.content !== 'string') return { readable: true, matches: false };
  return { readable: true, matches: sha256(file.content) === expectedSha256 };
}

// writeLanded is deliberately three-valued. `null` means the reconciliation
// could not answer, which must never be read as "nothing was written".
async function reconcileCreate({
  getJson, apiRoot, projectId, accessToken, expectedSha256,
  knownRulesetNames, createdAfter
}) {
  const result = {
    checked: true,
    writeLanded: null,
    matchingRulesetNames: [],
    candidateCount: 0,
    inspectedCount: 0,
    unreadableCount: 0,
    listReadable: false,
    note: ''
  };
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    result.checked = false;
    result.note = 'reconciliation needs an exact expected source sha256';
    return result;
  }

  const listing = await listRulesets({ getJson, apiRoot, projectId, accessToken });
  result.listReadable = listing.readable;
  if (!listing.readable) {
    result.note = 'ruleset listing was unreadable, so the create outcome is undetermined';
    return result;
  }

  const candidates = selectCandidates(listing.rulesets, { knownRulesetNames, createdAfter });
  result.candidateCount = candidates.length;
  if (candidates.length > MAX_INSPECT) {
    result.note = 'too many candidate rulesets to inspect (' + candidates.length + ')';
    return result;
  }

  for (const candidate of candidates) {
    const inspection = await sourceMatches({
      getJson, apiRoot, accessToken, rulesetName: candidate.name, expectedSha256
    });
    if (!inspection.readable) {
      result.unreadableCount += 1;
      continue;
    }
    result.inspectedCount += 1;
    if (inspection.matches) result.matchingRulesetNames.push(candidate.name);
  }

  if (result.unreadableCount > 0) {
    result.note = 'some candidate rulesets were unreadable, so the create outcome is undetermined';
    return result;
  }
  if (result.matchingRulesetNames.length > 0) {
    result.writeLanded = true;
    result.note = 'the intended source is already persisted; do not retry the create';
    return result;
  }
  result.writeLanded = false;
  result.note = 'no matching persisted source was found; this does not authorize a create';
  return result;
}

module.exports = {
  CLOCK_SKEW_MS, MAX_INSPECT, MAX_PAGES, PAGE_SIZE,
  listRulesets, reconcileCreate, selectCandidates, sha256, sourceMatches, skewedLowerBound
};
