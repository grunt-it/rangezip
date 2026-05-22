/**
 * The demo UI — a single self-contained HTML page (vanilla JS, no build step).
 *
 * Served as a string by Hono at `GET /`. It talks to the same Worker's API:
 * `/auth`, `/extract`, `/jobs/:id`, `/jobs/:id/ws`, `/jobs/:id/files`,
 * `/validate-destination`. The sample presets are injected server-side so the
 * page knows the labels/sizes without a second round-trip.
 *
 * Kept deliberately framework-free and dependency-free: it's a demo surface, not
 * a product frontend, so a self-contained page beats a bundler. The styling aims
 * for "looks like a real product" — there's a logo slot left for later.
 */

import { SAMPLE_PRESETS, type SamplePreset } from './samples';

/** Render the page, embedding the sample presets as JSON. */
export function renderDemoPage(samples: readonly SamplePreset[] = SAMPLE_PRESETS): string {
  const samplesJson = JSON.stringify(samples);
  return PAGE.replace('__SAMPLES__', samplesJson);
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>rangezip — extract files from a huge remote ZIP</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #12161f;
    --panel-2: #171c27;
    --line: #232a38;
    --text: #e6e9ef;
    --muted: #8b94a7;
    --accent: #4f9dff;
    --accent-2: #6ee7b7;
    --bad: #ff6b6b;
    --warn: #ffcf6b;
    --radius: 12px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  a { color: var(--accent); }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 32px 20px 80px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
  .logo {
    width: 40px; height: 40px; border-radius: 10px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: grid; place-items: center; font-weight: 800; color: #06121f;
    font-size: 20px; flex: 0 0 auto;
  }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .tag { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 20px; margin-top: 18px;
  }
  .panel h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 0 0 14px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 0 0 6px; }
  input[type=text], input[type=password], select {
    width: 100%; padding: 10px 12px; background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; color: var(--text);
    font: inherit; outline: none;
  }
  input:focus, select:focus { border-color: var(--accent); }
  .row { display: grid; gap: 12px; }
  .row.two { grid-template-columns: 1fr 1fr; }
  .row.three { grid-template-columns: 1fr 1fr 1fr; }
  button {
    background: var(--accent); color: #06121f; border: 0; border-radius: 8px;
    padding: 11px 18px; font: inherit; font-weight: 700; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .mt { margin-top: 14px; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); }
  .pill {
    display: inline-block; font-size: 12px; padding: 2px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .pill.ok { color: var(--accent-2); border-color: #2c5a44; }
  .pill.bad { color: var(--bad); border-color: #5a2c2c; }
  .pill.run { color: var(--warn); border-color: #5a4f2c; }
  .seg { display: flex; gap: 8px; }
  .seg button { flex: 1; background: var(--panel-2); color: var(--text);
    border: 1px solid var(--line); font-weight: 600; }
  .seg button.active { background: var(--accent); color: #06121f; border-color: var(--accent); }
  .bar { height: 10px; background: var(--panel-2); border-radius: 999px; overflow: hidden;
    border: 1px solid var(--line); }
  .bar > i { display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .25s; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .metric { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
  .metric .v { font-size: 20px; font-weight: 800; font-family: var(--mono); }
  .metric .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-top: 4px; }
  .metric.headline { border-color: #2c4a6a; background: #0f1c2c; }
  .metric.headline .v { color: var(--accent-2); }
  .log { font-family: var(--mono); font-size: 12.5px; max-height: 280px; overflow: auto;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  .log .line { display: flex; justify-content: space-between; gap: 12px; padding: 3px 4px; border-bottom: 1px solid var(--line); }
  .log .line:last-child { border-bottom: 0; }
  .log .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { flex: 0 0 auto; }
  .st.done { color: var(--accent-2); }
  .st.failed { color: var(--bad); }
  .st.extracting { color: var(--warn); }
  .st.pending, .st.queued { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .countdown { font-family: var(--mono); font-weight: 800; color: var(--warn); }
  .err { color: var(--bad); font-size: 13px; margin-top: 10px; }
  .ok { color: var(--accent-2); }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .note { background: #0f1c2c; border: 1px solid #2c4a6a; border-radius: 10px; padding: 12px; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">rz</div>
    <div>
      <h1>rangezip</h1>
      <p class="tag">Extract files from a huge remote ZIP via HTTP byte-range reads — without downloading the whole archive.</p>
    </div>
  </header>

  <!-- ACCESS GATE -->
  <section id="gate" class="panel">
    <h2>Access</h2>
    <label for="code">Access code</label>
    <div class="row two">
      <input id="code" type="password" placeholder="Enter your access code" autocomplete="off" />
      <button id="enter">Enter</button>
    </div>
    <div id="gateErr" class="err hidden"></div>
    <p class="hint">Gated demo. Codes are configured server-side via <code>wrangler secret put ACCESS_CODES</code>.</p>
  </section>

  <!-- MAIN -->
  <main id="main" class="hidden">
    <!-- SOURCE -->
    <section class="panel">
      <h2>1 — Source archive</h2>
      <div class="seg" id="sourceSeg">
        <button data-src="url" class="active">Paste a ZIP URL</button>
        <button data-src="sample">Use a sample</button>
      </div>
      <div id="srcUrl" class="mt">
        <label for="zipUrl">ZIP URL (must support HTTP range requests)</label>
        <input id="zipUrl" type="text" placeholder="https://example.com/huge.zip" />
      </div>
      <div id="srcSample" class="mt hidden">
        <label for="sampleSel">Sample archive</label>
        <select id="sampleSel"></select>
        <p class="hint" id="sampleHint"></p>
      </div>
    </section>

    <!-- DESTINATION -->
    <section class="panel">
      <h2>2 — Destination</h2>
      <div class="seg" id="destSeg">
        <button data-dest="demo" class="active">Demo bucket (ephemeral, auto-cleaned)</button>
        <button data-dest="byo">My S3/R2 bucket (validated, kept)</button>
      </div>
      <div id="destDemo" class="mt note">
        Files are written to the demo bucket and <strong>auto-deleted</strong> after the TTL.
        You'll see a live countdown once extraction completes.
      </div>
      <div id="destByo" class="mt hidden">
        <div class="row two">
          <div><label for="bEndpoint">Endpoint</label><input id="bEndpoint" type="text" placeholder="https://&lt;account&gt;.r2.cloudflarestorage.com" /></div>
          <div><label for="bRegion">Region</label><input id="bRegion" type="text" placeholder="auto" /></div>
        </div>
        <div class="row two mt">
          <div><label for="bBucket">Bucket</label><input id="bBucket" type="text" placeholder="my-bucket" /></div>
          <div><label for="bPrefix">Prefix (optional)</label><input id="bPrefix" type="text" placeholder="exports/" /></div>
        </div>
        <div class="row two mt">
          <div><label for="bKey">Access key ID</label><input id="bKey" type="text" autocomplete="off" placeholder="AKIA… / R2 token id" /></div>
          <div><label for="bSecret">Secret access key</label><input id="bSecret" type="password" autocomplete="off" placeholder="••••••••" /></div>
        </div>
        <div class="row two mt">
          <button id="validateBtn" class="ghost">Validate access</button>
          <div id="validateMsg" class="muted" style="align-self:center"></div>
        </div>
        <p class="hint">Use a <strong>scoped, write-only key</strong> for just this bucket/prefix — not a root key.
          Your credentials are sent over HTTPS, held only in memory for the run, never stored or logged.</p>
      </div>
    </section>

    <!-- EXTRACT -->
    <section class="panel">
      <h2>3 — Extract</h2>
      <div class="row two">
        <div><label for="prefix">Output prefix (R2 key prefix for this job)</label>
          <input id="prefix" type="text" value="demo" /></div>
        <div style="align-self:end"><button id="extractBtn">Extract</button></div>
      </div>
      <div id="extractErr" class="err hidden"></div>
    </section>

    <!-- PROGRESS -->
    <section id="progressPanel" class="panel hidden">
      <h2>Progress <span id="jobPill" class="pill">pending</span></h2>
      <div class="bar"><i id="overallBar"></i></div>
      <p class="hint"><span id="overallPct">0%</span> · <span id="counts">0 / 0</span>
        <span id="cleanupWrap" class="hidden"> · clears in <span id="countdown" class="countdown">—</span></span></p>

      <div class="metrics mt" id="metrics">
        <div class="metric headline"><div class="v" id="mPct">—</div><div class="k">range bytes vs archive</div></div>
        <div class="metric"><div class="v" id="mFetched">—</div><div class="k">bytes fetched</div></div>
        <div class="metric"><div class="v" id="mArchive">—</div><div class="k">archive size</div></div>
        <div class="metric"><div class="v" id="mSaved">—</div><div class="k">bytes not fetched</div></div>
        <div class="metric"><div class="v" id="mReq">—</div><div class="k">range requests</div></div>
        <div class="metric"><div class="v" id="mPeak">—</div><div class="k">peak concurrency</div></div>
        <div class="metric"><div class="v" id="mFiles">—</div><div class="k">files extracted</div></div>
        <div class="metric"><div class="v" id="mR2">—</div><div class="k">bucket writes</div></div>
        <div class="metric"><div class="v" id="mIndex">—</div><div class="k">index-read time</div></div>
        <div class="metric"><div class="v" id="mExtract">—</div><div class="k">extraction time</div></div>
        <div class="metric"><div class="v" id="mTotal">—</div><div class="k">total time</div></div>
        <div class="metric"><div class="v" id="mCompute">—</div><div class="k">compute time (measured)</div></div>
        <div class="metric"><div class="v" id="mCd">—</div><div class="k">central dir reads (reused)</div></div>
      </div>

      <h2 class="mt">Per-file status</h2>
      <div class="log" id="fileLog"></div>
    </section>

    <!-- FILE BROWSER -->
    <section id="browserPanel" class="panel hidden">
      <h2>Extracted files</h2>
      <div id="byoNote" class="note hidden">Files were written to <strong>your bucket</strong> — yours to keep. rangezip won't list or delete them.</div>
      <table id="filesTable">
        <thead><tr><th>Name</th><th>Size</th><th></th></tr></thead>
        <tbody id="filesBody"></tbody>
      </table>
      <p id="browserEmpty" class="muted hidden">No files yet.</p>
    </section>

    <p class="hint mt"><a href="#" id="signout">Sign out</a></p>
  </main>
</div>

<script>
const SAMPLES = __SAMPLES__;
const $ = (id) => document.getElementById(id);

// ---- helpers ----
function fmtBytes(n) {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(2)) + ' ' + u[i];
}
function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}
function fmtCountdown(msLeft) {
  if (msLeft <= 0) return '0:00:00';
  const s = Math.floor(msLeft / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h + ':' + String(m).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
}
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}

// ---- state ----
let sourceMode = 'url';
let destMode = 'demo';
let byoValidated = false;
let currentJob = null;
let ws = null;
let countdownTimer = null;
let expiresAt = null;

// ---- gate ----
$('enter').onclick = doEnter;
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doEnter(); });
async function doEnter() {
  const code = $('code').value;
  $('gateErr').classList.add('hidden');
  const r = await api('/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (r.ok) { showMain(); }
  else { $('gateErr').textContent = (r.body && r.body.error && r.body.error.message) || 'Invalid code'; $('gateErr').classList.remove('hidden'); }
}
function showMain() { $('gate').classList.add('hidden'); $('main').classList.remove('hidden'); }
$('signout').onclick = async (e) => { e.preventDefault(); await api('/logout', { method: 'POST' }); location.reload(); };

// If already authenticated (cookie present + valid), skip the gate.
(async () => {
  const r = await api('/me');
  if (r.ok) showMain();
})();

// ---- source toggle ----
for (const b of $('sourceSeg').querySelectorAll('button')) {
  b.onclick = () => {
    sourceMode = b.dataset.src;
    for (const x of $('sourceSeg').querySelectorAll('button')) x.classList.toggle('active', x === b);
    $('srcUrl').classList.toggle('hidden', sourceMode !== 'url');
    $('srcSample').classList.toggle('hidden', sourceMode !== 'sample');
  };
}
// populate samples
for (const s of SAMPLES) {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.label + (s.available ? '' : ' (placeholder — not uploaded)');
  $('sampleSel').appendChild(opt);
}
function updateSampleHint() {
  const s = SAMPLES.find(x => x.id === $('sampleSel').value);
  if (!s) { $('sampleHint').textContent = ''; return; }
  $('sampleHint').innerHTML = '~' + s.fileCount.toLocaleString() + ' files · ' + fmtBytes(s.sizeBytes)
    + (s.available ? '' : ' · <span class="muted">URL is a placeholder until the sample is generated + uploaded (see README)</span>');
}
$('sampleSel').onchange = updateSampleHint;
updateSampleHint();

// ---- destination toggle ----
for (const b of $('destSeg').querySelectorAll('button')) {
  b.onclick = () => {
    destMode = b.dataset.dest;
    for (const x of $('destSeg').querySelectorAll('button')) x.classList.toggle('active', x === b);
    $('destDemo').classList.toggle('hidden', destMode !== 'demo');
    $('destByo').classList.toggle('hidden', destMode !== 'byo');
    byoValidated = false;
    updateExtractEnabled();
  };
}
function byoFromForm() {
  return {
    endpoint: $('bEndpoint').value.trim(),
    region: $('bRegion').value.trim() || 'auto',
    bucket: $('bBucket').value.trim(),
    prefix: $('bPrefix').value.trim() || undefined,
    accessKeyId: $('bKey').value.trim(),
    secretAccessKey: $('bSecret').value,
  };
}
for (const id of ['bEndpoint','bRegion','bBucket','bPrefix','bKey','bSecret']) {
  $(id).addEventListener('input', () => { byoValidated = false; updateExtractEnabled(); });
}
$('validateBtn').onclick = async () => {
  $('validateMsg').textContent = 'Validating…'; $('validateMsg').className = 'muted';
  const r = await api('/validate-destination', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination: byoFromForm() }),
  });
  if (r.ok && r.body && r.body.valid) {
    byoValidated = true;
    $('validateMsg').textContent = '✓ Access confirmed'; $('validateMsg').className = 'ok';
  } else {
    byoValidated = false;
    $('validateMsg').textContent = '✗ ' + ((r.body && r.body.reason) || (r.body && r.body.error && r.body.error.message) || 'Validation failed');
    $('validateMsg').className = 'err';
  }
  updateExtractEnabled();
};
function updateExtractEnabled() {
  $('extractBtn').disabled = destMode === 'byo' && !byoValidated;
}
updateExtractEnabled();

// ---- extract ----
$('extractBtn').onclick = doExtract;
function currentSourceUrl() {
  if (sourceMode === 'url') return $('zipUrl').value.trim();
  const s = SAMPLES.find(x => x.id === $('sampleSel').value);
  return s ? s.url : '';
}
async function doExtract() {
  $('extractErr').classList.add('hidden');
  const sourceUrl = currentSourceUrl();
  if (!sourceUrl) return showExtractErr('Pick or paste a source ZIP URL first.');
  const prefix = $('prefix').value.trim() || 'demo';
  const payload = { sourceUrl, prefix, destination: destMode };
  if (destMode === 'byo') payload.byo = byoFromForm();

  $('extractBtn').disabled = true;
  const r = await api('/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  updateExtractEnabled();
  if (!r.ok) return showExtractErr((r.body && r.body.error && r.body.error.message) || ('Extract failed (' + r.status + ')'));
  currentJob = r.body.jobId;
  startTracking(currentJob);
}
function showExtractErr(msg) { $('extractErr').textContent = msg; $('extractErr').classList.remove('hidden'); $('extractBtn').disabled = false; }

// ---- live tracking ----
function startTracking(jobId) {
  $('progressPanel').classList.remove('hidden');
  $('browserPanel').classList.add('hidden');
  $('fileLog').innerHTML = '';
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/jobs/' + jobId + '/ws');
  ws.onmessage = (ev) => { try { handleMessage(JSON.parse(ev.data)); } catch {} };
  ws.onclose = () => {};
  // Fallback poll in case the socket drops.
  pollFallback(jobId);
}
let pollTimer = null;
function pollFallback(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await api('/jobs/' + jobId);
    if (r.ok) {
      renderSnapshot(r.body);
      if (r.body.status === 'completed' || r.body.status === 'failed') { clearInterval(pollTimer); onFinished(jobId, r.body); }
    }
  }, 2000);
}
const fileState = {};
function handleMessage(m) {
  if (m.type === 'snapshot') { renderSnapshot(m); }
  else if (m.type === 'file') { renderFile(m.file); renderProgressNums(m); renderMetrics(m.metrics); }
  else if (m.type === 'done') { renderMetrics(m.metrics); expiresAt = m.expiresAt; setPill(m.status); onFinished(currentJob, { status: m.status, expiresAt: m.expiresAt }); }
}
function renderSnapshot(s) {
  setPill(s.status);
  renderProgressNums(s);
  renderMetrics(s.metrics);
  expiresAt = s.expiresAt;
  for (const f of (s.files || [])) renderFile(f);
  if (s.status === 'completed' || s.status === 'failed') onFinished(currentJob, s);
}
function setPill(status) {
  const el = $('jobPill'); el.textContent = status;
  el.className = 'pill ' + (status === 'completed' ? 'ok' : status === 'failed' ? 'bad' : 'run');
}
function renderProgressNums(s) {
  $('overallBar').style.width = (s.percent || 0) + '%';
  $('overallPct').textContent = (s.percent || 0) + '%';
  $('counts').textContent = (s.done || 0) + ' done / ' + (s.failed || 0) + ' failed / ' + (s.total || 0) + ' total';
}
function renderFile(f) {
  fileState[f.name] = f;
  let line = document.querySelector('[data-f="' + cssEscape(f.name) + '"]');
  if (!line) {
    line = document.createElement('div'); line.className = 'line'; line.dataset.f = f.name;
    const name = document.createElement('span'); name.className = 'name';
    const st = document.createElement('span'); st.className = 'st';
    line.appendChild(name); line.appendChild(st); $('fileLog').appendChild(line);
  }
  line.querySelector('.name').textContent = f.name;
  const st = line.querySelector('.st');
  st.className = 'st ' + f.status;
  st.textContent = f.status + (f.bytes != null ? ' · ' + fmtBytes(f.bytes) : '') + (f.error ? ' · ' + f.error : '');
}
function cssEscape(s) { return s.replace(/["\\]/g, '\\$&'); }
function renderMetrics(m) {
  if (!m) return;
  $('mPct').textContent = m.rangeBytesPercent + '%';
  $('mFetched').textContent = fmtBytes(m.rangeBytesFetched);
  $('mArchive').textContent = fmtBytes(m.archiveSize);
  $('mSaved').textContent = fmtBytes(m.bytesSaved);
  $('mReq').textContent = m.rangeRequestCount;
  $('mPeak').textContent = m.peakConcurrency;
  $('mFiles').textContent = m.filesExtracted;
  $('mR2').textContent = m.r2Writes;
  $('mIndex').textContent = fmtMs(m.indexReadMs);
  $('mExtract').textContent = fmtMs(m.extractionMs);
  $('mTotal').textContent = fmtMs(m.totalMs);
  $('mCompute').textContent = fmtMs(m.computeMs);
  $('mCd').textContent = m.centralDirectoryReads;
}
async function onFinished(jobId, s) {
  // File browser
  $('browserPanel').classList.remove('hidden');
  const isByo = s.destination === 'byo' || destMode === 'byo';
  $('byoNote').classList.toggle('hidden', !isByo);
  if (isByo) {
    $('filesTable').classList.add('hidden');
    $('browserEmpty').classList.add('hidden');
  } else {
    $('filesTable').classList.remove('hidden');
    const r = await api('/jobs/' + jobId + '/files');
    const tbody = $('filesBody'); tbody.innerHTML = '';
    const files = (r.ok && r.body && r.body.files) || [];
    $('browserEmpty').classList.toggle('hidden', files.length > 0);
    for (const f of files) {
      const tr = document.createElement('tr');
      const a = '/jobs/' + jobId + '/files/' + encodeURIComponent(f.name);
      tr.innerHTML = '<td>' + escapeHtml(f.name) + '</td><td>' + fmtBytes(f.size) + '</td>'
        + '<td><a href="' + a + '" download>download</a></td>';
      tbody.appendChild(tr);
    }
  }
  // Countdown
  if (s.expiresAt) { expiresAt = s.expiresAt; startCountdown(); }
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function startCountdown() {
  clearInterval(countdownTimer);
  $('cleanupWrap').classList.remove('hidden');
  const tick = () => {
    const left = expiresAt - Date.now();
    $('countdown').textContent = fmtCountdown(left);
    if (left <= 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}
</script>
</body>
</html>`;
