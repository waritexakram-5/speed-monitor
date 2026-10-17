// Speed monitor runner: measures every site x strategy with Lighthouse (the engine behind
// PageSpeed Insights), back to back in the same round, then uploads the rows to the report.
//
//   node run.js          keep running, one round at the top of every hour
//   node run.js --once   one round, then exit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const CSV = path.join(DATA, 'results.csv');
const PENDING = path.join(DATA, 'pending.json'); // rows not uploaded yet
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
// On GitHub Actions the upload address and token come from repository secrets.
cfg.upload_url = process.env.UPLOAD_URL || cfg.upload_url;
cfg.upload_token = process.env.UPLOAD_TOKEN || cfg.upload_token;

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

async function runTest(site, strategy) {
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
    const lhr = result.lhr;
    if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
    const a = lhr.audits;
    const score = lhr.categories.performance.score;
    if (score == null) throw new Error('Lighthouse returned no performance score');
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
    };
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

async function runRound() {
  const roundTs = localNow();
  const roundId = roundTs.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  // All sites on one device type, then the next, so the sites in a round are measured minutes apart.
  // The starting site rotates every hour so no site is always measured first.
  const shift = Number(roundTs.slice(11, 13)) % cfg.sites.length;
  const sites = [...cfg.sites.slice(shift), ...cfg.sites.slice(0, shift)];
  const jobs = cfg.strategies.flatMap(strategy => sites.map(site => ({ site, strategy })));

  const rows = [];
  for (const { site, strategy } of jobs) {
    const row = { round_id: roundId, timestamp: roundTs, site: site.name, url: site.url, strategy };
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        Object.assign(row, await runTest(site, strategy));
        break;
      } catch (e) {
        Object.assign(row, { status: 'error', error: String(e.message || e).replace(/\s+/g, ' ').slice(0, 300) });
        if (attempt < cfg.retries) await sleep(10000);
      }
    }
    rows.push(row);
    log(row.status === 'ok'
      ? `${roundId} ${site.name.padEnd(14)} ${strategy.padEnd(8)} score=${row.score} LCP=${row.lcp_ms} TTFB=${row.ttfb_ms} machine=${row.benchmark}`
      : `${roundId} ${site.name.padEnd(14)} ${strategy.padEnd(8)} ERROR ${row.error}`);
  }
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
