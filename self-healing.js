// Bright Data — Scraper Studio AI Flow
// Workflow 2: Update an existing scraper with Self-Healing
//
// Demo flow:
//   [scrape:before]  POST /dca/trigger?collector=…             → run the (broken) scraper
//                    GET  /dca/dataset?id=…                    → fetch its output for comparison
//   [heal]           POST /dca/collectors/{id}/refactor_template
//                    GET  /dca/collectors/{id}/refactor_template/progress  (poll)
//   [scrape:after]   POST /dca/trigger?collector=…             → run the healed scraper
//                    GET  /dca/dataset?id=…                    → fetch its output
//
// Docs: https://docs.brightdata.com/api-reference/scraper-studio-api/ai-flow/overview

import 'dotenv/config';

const BASE_URL = 'https://api.brightdata.com';

const {
  BRIGHTDATA_API_KEY,
  COLLECTOR_ID,
  HEAL_PROMPT = 'Fix broken selectors and make the scraper resilient to minor DOM changes.',
  TEST_URL = 'https://example.com/',
  QUEUE_NEXT = '1',
  POLL_INTERVAL_MS = '5000',
  POLL_TIMEOUT_MS = '600000',
  // Comma-separated field names that MUST be present and non-empty in every row.
  // Field-name match is case-insensitive. Empty → only check for any non-input value.
  REQUIRED_FIELDS = '',
} = process.env;

const pollIntervalMs = Number(POLL_INTERVAL_MS);
const pollTimeoutMs = Number(POLL_TIMEOUT_MS);
const queueNext = Number(QUEUE_NEXT);
const targetUrls = TEST_URL.split(',').map((s) => s.trim()).filter(Boolean);
const requiredFields = REQUIRED_FIELDS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function assertEnv() {
  const missing = [];
  if (!BRIGHTDATA_API_KEY) missing.push('BRIGHTDATA_API_KEY');
  if (!COLLECTOR_ID) missing.push('COLLECTOR_ID');
  if (!targetUrls.length) missing.push('TEST_URL');
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}. Copy .env.example → .env and fill them in.`);
    process.exit(1);
  }
  if (HEAL_PROMPT.length > 1000) {
    console.error(`HEAL_PROMPT exceeds 1000 chars (${HEAL_PROMPT.length}).`);
    process.exit(1);
  }
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${BRIGHTDATA_API_KEY}`,
    Accept: 'application/json',
    ...extra,
  };
}

// Low-level fetch wrapper. Returns { status, data }; only throws on network error.
async function request(method, url, { body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: authHeaders(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

async function requestOrThrow(method, url, opts) {
  const { status, ok, data } = await request(method, url, opts);
  if (!ok) {
    const err = new Error(`${method} ${url} → ${status}`);
    err.status = status;
    err.body = data;
    throw err;
  }
  return data;
}

// ─── Scrape ──────────────────────────────────────────────────────────────────

async function triggerCollection({ collectorId, urls, label }) {
  const qs = new URLSearchParams({ collector: collectorId });
  if (queueNext) qs.set('queue_next', String(queueNext));
  const url = `${BASE_URL}/dca/trigger?${qs.toString()}`;
  console.log(`  [${label}] trigger → ${urls.length} URL(s)`);
  const data = await requestOrThrow('POST', url, {
    headers: { 'Content-Type': 'application/json' },
    body: urls.map((u) => ({ url: u })),
  });
  console.log(`  [${label}] collection_id=${data.collection_id}  start_eta=${data.start_eta}`);
  return data;
}

// /dca/dataset returns 202 + { status: "building", … } while pending and 200 + [rows] when ready.
async function waitForDataset({ collectionId, label, intervalMs, timeoutMs }) {
  const url = `${BASE_URL}/dca/dataset?id=${encodeURIComponent(collectionId)}`;
  const startedAt = Date.now();
  let attempt = 0;
  console.log(`  [${label}] polling dataset ${collectionId}…`);
  while (true) {
    attempt += 1;
    const { status, data } = await request('GET', url);
    if (status === 200) {
      const rows = Array.isArray(data) ? data.length : 'n/a';
      console.log(`  [${label}] ✓ dataset ready (rows=${rows}, attempts=${attempt})`);
      return data;
    }
    if (status === 202) {
      const msg = data && data.message ? ` — ${data.message}` : '';
      console.log(`  [${label}] attempt ${attempt}: building${msg}`);
    } else {
      const err = new Error(`Unexpected dataset status ${status} for ${collectionId}`);
      err.body = data;
      throw err;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Dataset ${collectionId} not ready within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function scrape({ label }) {
  console.log(`\n── ${label} ──`);
  const trig = await triggerCollection({ collectorId: COLLECTOR_ID, urls: targetUrls, label });
  const data = await waitForDataset({
    collectionId: trig.collection_id,
    label,
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
  });
  return { collectionId: trig.collection_id, data };
}

// ─── Heal ────────────────────────────────────────────────────────────────────

async function triggerSelfHealing({ collectorId, prompt, customInput = [] }) {
  const url = `${BASE_URL}/dca/collectors/${encodeURIComponent(collectorId)}/refactor_template`;
  console.log(`\n── heal ──\n  trigger heal for ${collectorId}`);
  const data = await requestOrThrow('POST', url, {
    headers: { 'Content-Type': 'application/json' },
    body: { prompt, custom_input: customInput },
  });
  console.log('  ✓ heal job accepted');
  return data;
}

async function waitForHealing({ collectorId, intervalMs, timeoutMs }) {
  const url = `${BASE_URL}/dca/collectors/${encodeURIComponent(collectorId)}/refactor_template/progress`;
  const startedAt = Date.now();
  const okStates = new Set(['ready', 'done', 'completed', 'success', 'finished']);
  const failStates = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);
  let attempt = 0;
  console.log(`  polling heal progress every ${intervalMs}ms (timeout ${timeoutMs}ms)`);
  while (true) {
    attempt += 1;
    const progress = await requestOrThrow('GET', url);
    const status = String((progress && (progress.status || progress.state)) || 'unknown');
    const pct = progress && (progress.progress ?? progress.percent);
    const suffix = pct != null ? ` (${pct}%)` : '';
    console.log(`  attempt ${attempt}: status=${status}${suffix}`);
    const lower = status.toLowerCase();
    if (okStates.has(lower)) {
      console.log('  ✓ heal job finished');
      return progress;
    }
    if (failStates.has(lower)) {
      const err = new Error(`Heal job ended with status "${status}"`);
      err.body = progress;
      throw err;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Heal job did not finish within ${timeoutMs}ms (last status="${status}")`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Health check ────────────────────────────────────────────────────────────

// Returns { healthy: boolean, reason: string } given a dataset payload.
// Heuristic: a row is "good" if it has at least one non-`input` field with a
// non-null, non-empty value. If REQUIRED_FIELDS is set, every row must contain
// all of those field names with non-empty values.
function assessHealth(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return { healthy: false, reason: 'no rows returned' };
  }
  const isMeaningful = (v) => {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  };
  const broken = [];
  data.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      broken.push(`row ${i}: not an object`);
      return;
    }
    const lowerKeys = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (requiredFields.length) {
      const missing = requiredFields.filter((f) => !isMeaningful(lowerKeys[f]));
      if (missing.length) broken.push(`row ${i}: missing ${missing.join(', ')}`);
    } else {
      const hasAny = Object.entries(row).some(([k, v]) => k.toLowerCase() !== 'input' && isMeaningful(v));
      if (!hasAny) broken.push(`row ${i}: all data fields empty`);
    }
  });
  if (broken.length) return { healthy: false, reason: broken.slice(0, 3).join('; ') };
  return { healthy: true, reason: `${data.length} row(s) look good` };
}

// ─── Compare ─────────────────────────────────────────────────────────────────

function summarize(label, data) {
  console.log(`\n── ${label} (summary) ──`);
  if (!Array.isArray(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`  rows: ${data.length}`);
  const sample = data[0];
  if (sample && typeof sample === 'object') {
    const populated = Object.entries(sample).filter(([, v]) => v != null && v !== '').length;
    const total = Object.keys(sample).length;
    console.log(`  first row: ${populated}/${total} fields populated`);
    console.log('  preview:', JSON.stringify(sample, null, 2).slice(0, 800));
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  assertEnv();
  const args = new Set(process.argv.slice(2));
  const forceHeal = args.has('--force-heal');
  const skipHeal = args.has('--no-heal');

  console.log(`Collector: ${COLLECTOR_ID}`);
  console.log(`URLs:      ${targetUrls.join(', ')}`);
  if (requiredFields.length) console.log(`Required:  ${requiredFields.join(', ')}`);

  try {
    // Step 1 — initial scrape.
    const before = await scrape({ label: 'scrape:before' });
    summarize('scrape:before', before.data);

    // Step 2 — decide whether to heal.
    const health = assessHealth(before.data);
    console.log(`\n── health ──\n  ${health.healthy ? '✓ healthy' : '✗ broken'} — ${health.reason}`);

    if (health.healthy && !forceHeal) {
      console.log('  scraper is producing usable data — skipping self-healing.');
      return;
    }
    if (skipHeal) {
      console.log('  --no-heal set — skipping self-healing despite broken data.');
      return;
    }
    if (forceHeal && health.healthy) {
      console.log('  --force-heal set — running heal even though data looks healthy.');
    }

    // Step 3 — heal.
    await triggerSelfHealing({ collectorId: COLLECTOR_ID, prompt: HEAL_PROMPT });
    await waitForHealing({
      collectorId: COLLECTOR_ID,
      intervalMs: pollIntervalMs,
      timeoutMs: pollTimeoutMs,
    });

    // Step 4 — re-scrape to confirm the fix.
    const after = await scrape({ label: 'scrape:after' });
    summarize('scrape:after', after.data);

    const afterHealth = assessHealth(after.data);
    console.log(`\n── final ──\n  before: ${health.reason}\n  after:  ${afterHealth.reason}`);
    if (!afterHealth.healthy) {
      console.error('  ✗ scraper still broken after healing — review the prompt or template.');
      process.exit(2);
    }
    console.log('  ✓ self-healing produced usable data');
  } catch (err) {
    console.error('\n✗ Workflow failed:', err.message);
    if (err.body) console.error('  response:', err.body);
    process.exit(1);
  }
}

main();
