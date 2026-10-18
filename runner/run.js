// Speed monitor runner: measures every site x strategy, then uploads the rows to the report.
//
// With PSI_API_KEY set: Google PageSpeed Insights API (the same results as pagespeed.web.dev),
//   all tests of a round sent at the same moment.
// Without it: local Lighthouse + Chrome, tests run one after another.
//
//   node run.js          keep running, one round at the top of every hour
//   node run.js --once   one round, then exit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const CSV = path.join(DATA, 'results.csv');
const PENDING = path.join(DATA, 'pending.json'); // rows not uploaded yet
const DETAILS = path.join(DATA, 'details.jsonl'); // per-test diagnostics (LCP element, LCP phases, third parties)
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
// On GitHub Actions these come from repository secrets.
cfg.upload_url = process.env.UPLOAD_URL || cfg.upload_url;
cfg.upload_token = process.env.UPLOAD_TOKEN || cfg.upload_token;
cfg.psi_api_key = process.env.PSI_API_KEY || cfg.psi_api_key || '';

export const FIELDS = [
  'round_id', 'timestamp', 'site', 'url', 'strategy', 'status',
  'score', 'fcp_ms', 'lcp_ms', 'tbt_ms', 'cls', 'si_ms', 'ttfb_ms',
  'page_kb', 'requests', 'benchmark', 'error',
];

const log = msg => console.log(`${new Date().toISOString().slice(0, 19)}  ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Local wall-clock time in the configured timezone, e.g. 2026-10-17T15:00:04
function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function appendCsv(rows) {
  fs.mkdirSync(DATA, { recursive: true });
  const head = fs.existsSync(CSV) ? '' : FIELDS.join(',') + '\n';
  fs.appendFileSync(CSV, head + rows.map(r => FIELDS.map(f => csvCell(r[f])).join(',')).join('\n') + '\n');
}

const audit = (a, key, digits = 0) => {
  const v = a[key]?.numericValue;
  return typeof v === 'number' ? +v.toFixed(digits) : '';
};

// The parts of the report that explain WHY a test was slow; kept small (one JSON line per test).
const DETAIL_AUDITS = ['lcp-breakdown-insight', 'lcp-discovery-insight', 'largest-contentful-paint-element',
  'render-blocking-insight', 'third-party-summary', 'bootup-time'];
function details(lhr) {
  const out = {};
  for (const id of DETAIL_AUDITS) {
    const a = lhr.audits[id];
    if (!a) continue;
    // Drop layout/selector noise and table headings; round numbers; keep the top 5 rows.
    const d = JSON.parse(JSON.stringify(a.details || {}), (k, v) =>
      ['boundingRect', 'lhId', 'path', 'selector', 'headings', 'debugData'].includes(k) ? undefined
        : typeof v === 'number' ? Math.round(v) : v);
    const trim = x => { if (Array.isArray(x?.items)) { x.items = x.items.slice(0, 5); x.items.forEach(trim); } };
    trim(d);
    out[id] = { value: a.displayValue || a.numericValue || '', details: d };
  }
  return out;
}

// Same Lighthouse report format from both engines.
function metrics(lhr) {
  if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
  const a = lhr.audits;
  const score = lhr.categories.performance.score;
  if (score == null) throw new Error('No performance score returned');
  const diag = a.diagnostics?.details?.items?.[0] || {};
  return {
    status: 'ok',
    score: Math.round(score * 100),
    fcp_ms: audit(a, 'first-contentful-paint'),
    lcp_ms: audit(a, 'largest-contentful-paint'),
    tbt_ms: audit(a, 'total-blocking-time'),
    cls: audit(a, 'cumulative-layout-shift', 3),
    si_ms: audit(a, 'speed-index'),
    ttfb_ms: audit(a, 'server-response-time'),
    page_kb: diag.totalByteWeight ? Math.round(diag.totalByteWeight / 1024) : '',
    requests: diag.numRequests ?? '',
    // How fast the measuring machine was during this test. A low value = busy machine, not a slow site.
    benchmark: Math.round(lhr.environment?.benchmarkIndex || 0) || '',
    error: '',
    details: details(lhr),
  };
}

async function runPsi(site, strategy) {
  const params = new URLSearchParams({ url: site.url, strategy, category: 'performance', key: cfg.psi_api_key });
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.lighthouseResult) {
    const msg = body.error?.message || `unexpected response`;
    throw new Error(`HTTP ${res.status}: ${msg}`.replaceAll(cfg.psi_api_key, '***'));
  }
  return metrics(body.lighthouseResult);
}

async function runLighthouse(site, strategy) {
  const { default: lighthouse } = await import('lighthouse');
  const { default: desktopConfig } = await import('lighthouse/core/config/desktop-config.js');
  const chromeLauncher = await import('chrome-launcher');
  const chrome = await chromeLauncher.launch({
    chromePath: cfg.chrome_path || undefined,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  try {
    const result = await lighthouse(
      site.url,
      { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] },
      strategy === 'desktop' ? desktopConfig : undefined,
    );
    return metrics(result.lhr);
  } finally {
    // On Windows, deleting Chrome's temp profile can fail while Chrome is still exiting; harmless.
    try { await chrome.kill(); } catch { /* ignore cleanup errors */ }
  }
}

async function upload(rows) {
  if (!cfg.upload_url) return;
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { /* nothing pending */ }
  queue.push(...rows);
  try {
    const res = await fetch(cfg.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': cfg.upload_token },
      body: JSON.stringify(queue),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
    log(`uploaded ${queue.length} rows`);
  } catch (e) {
    fs.writeFileSync(PENDING, JSON.stringify(queue));
    log(`upload failed, ${queue.length} rows kept for next round: ${e.message}`);
  }
}

async function measure(job, roundId, roundTs, test) {
  const { site, strategy } = job;
  const row = { round_id: roundId, timestamp: roundTs, site: site.name, url: site.url, strategy };
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      Object.assign(row, await test(site, strategy));
      break;
    } catch (e) {
      Object.assign(row, { status: 'error', error: String(e.message || e).replace(/\s+/g, ' ').slice(0, 300) });
      if (attempt < cfg.retries) await sleep(15000);
    }
  }
  log(row.status === 'ok'
    ? `${roundId} ${site.name.padEnd(18)} ${strategy.padEnd(8)} score=${row.score} LCP=${row.lcp_ms} TTFB=${row.ttfb_ms} machine=${row.benchmark}`
    : `${roundId} ${site.name.padEnd(18)} ${strategy.padEnd(8)} ERROR ${row.error}`);
  return row;
}

async function runRound() {
  const roundTs = localNow();
  const roundId = roundTs.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  let rows;
  if (cfg.psi_api_key) {
    // Google runs the tests on its own machines, so all of them can go at the same moment.
    log(`round ${roundId}: Google PageSpeed Insights API`);
    const jobs = cfg.strategies.flatMap(strategy => cfg.sites.map(site => ({ site, strategy })));
    rows = await Promise.all(jobs.map(job => measure(job, roundId, roundTs, runPsi)));
  } else {
    // Local Lighthouse: one test at a time so they don't slow each other down.
    // The starting site rotates every hour so no site is always measured first.
    log(`round ${roundId}: local Lighthouse`);
    const shift = Number(roundTs.slice(11, 13)) % cfg.sites.length;
    const sites = [...cfg.sites.slice(shift), ...cfg.sites.slice(0, shift)];
    const jobs = cfg.strategies.flatMap(strategy => sites.map(site => ({ site, strategy })));
    rows = [];
    for (const job of jobs) rows.push(await measure(job, roundId, roundTs, runLighthouse));
  }
  // Diagnostics stay in the GitHub backup only; the report receives the summary columns.
  const detailLines = rows.filter(r => r.details).map(r => JSON.stringify(
    { round_id: r.round_id, site: r.site, strategy: r.strategy, score: r.score, lcp_ms: r.lcp_ms, ...r.details }));
  fs.mkdirSync(DATA, { recursive: true });
  if (detailLines.length) fs.appendFileSync(DETAILS, detailLines.join('\n') + '\n');
  rows.forEach(r => delete r.details);
  appendCsv(rows);
  await upload(rows);
}

if (process.argv.includes('--once')) {
  await runRound();
} else {
  log(`started: a round every ${cfg.interval_minutes} minutes`);
  for (;;) {
    await runRound();
    const period = cfg.interval_minutes * 60000;
    await sleep(period - (Date.now() % period) + 5000); // align to the top of the hour
  }
}
