/**
 * The admin panel — a single self-contained HTML page (vanilla JS, no build
 * step), served by Hono at `GET /admin`. Same dark theme + logo as the demo UI
 * (`./ui`), reusing its embedded brand assets so there's one source of truth for
 * the mark.
 *
 * It talks to the admin DATA API on the same Worker (all server-gated by the
 * admin session cookie via `requireAdmin`):
 *   POST /admin/auth   { key }                  -> set admin session cookie
 *   POST /admin/logout                          -> clear it
 *   GET  /admin/codes                           -> { codes: CodeSummary[] }
 *   POST /admin/codes  { label }                -> { code, label }
 *   POST /admin/codes/:code/revoke              -> { ok }
 *   GET  /admin/codes/:code/timeline            -> { code, events }
 *
 * Deliberately framework-free and dependency-free — an internal admin surface,
 * not a product frontend, so a self-contained page beats a bundler.
 */

import { FAVICON_PNG, LOGO_PNG } from './ui';

/** Render the admin page, embedding the brand assets inline. */
export function renderAdminPage(): string {
  return PAGE.replace('__FAVICON__', FAVICON_PNG).replace('__LOGO__', LOGO_PNG);
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>rangezip — admin</title>
<link rel="icon" type="image/png" href="__FAVICON__" />
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
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
  .logo { width: 32px; height: 32px; flex: 0 0 auto; display: block; object-fit: contain; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .tag { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 20px; margin-top: 18px;
  }
  .panel h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 0 0 14px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 0 0 6px; }
  input[type=text], input[type=password] {
    width: 100%; padding: 10px 12px; background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; color: var(--text);
    font: inherit; outline: none;
  }
  input:focus { border-color: var(--accent); }
  .row { display: grid; gap: 12px; }
  .row.two { grid-template-columns: 1fr auto; align-items: end; }
  button {
    background: var(--accent); color: #06121f; border: 0; border-radius: 8px;
    padding: 11px 18px; font: inherit; font-weight: 700; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 600; }
  button.danger { background: transparent; color: var(--bad); border: 1px solid #5a2c2c; font-weight: 600; padding: 6px 12px; }
  button.link { background: transparent; color: var(--accent); border: 0; padding: 6px 8px; font-weight: 600; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .mt { margin-top: 14px; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); }
  .err { color: var(--bad); font-size: 13px; margin-top: 10px; }
  .ok { color: var(--accent-2); }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .pill {
    display: inline-block; font-size: 12px; padding: 2px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .pill.ok { color: var(--accent-2); border-color: #2c5a44; }
  .pill.bad { color: var(--bad); border-color: #5a2c2c; }
  .pill.idle { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.num { font-family: var(--mono); text-align: right; }
  td.code { font-family: var(--mono); color: var(--accent-2); }
  .note { background: #0f1c2c; border: 1px solid #2c4a6a; border-radius: 10px; padding: 12px; font-size: 13px; }
  .newcode { font-family: var(--mono); font-size: 18px; color: var(--accent-2); user-select: all; }
  .timeline { font-family: var(--mono); font-size: 12.5px; max-height: 360px; overflow: auto;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  .timeline .ev { display: flex; gap: 12px; padding: 4px 4px; border-bottom: 1px solid var(--line); }
  .timeline .ev:last-child { border-bottom: 0; }
  .timeline .at { color: var(--muted); flex: 0 0 auto; }
  .timeline .ty { color: var(--accent); flex: 0 0 auto; min-width: 130px; }
  .timeline .de { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img class="logo" src="__LOGO__" alt="rangezip logo" width="32" height="32" />
    <div>
      <h1>rangezip <span class="muted" style="font-weight:400">· admin</span></h1>
      <p class="tag">Manage access codes and review per-code usage.</p>
    </div>
  </header>

  <!-- KEY GATE -->
  <section id="gate" class="panel">
    <h2>Admin access</h2>
    <label for="key">Admin key</label>
    <div class="row two">
      <input id="key" type="password" placeholder="Enter the admin key" autocomplete="off" />
      <button id="enter">Enter</button>
    </div>
    <div id="gateErr" class="err hidden"></div>
    <p class="hint">Set server-side via <code>wrangler secret put ADMIN_KEY</code>.</p>
  </section>

  <!-- MAIN -->
  <main id="main" class="hidden">
    <!-- GENERATE -->
    <section class="panel">
      <h2>Generate a code</h2>
      <div class="row two">
        <div style="flex:1"><label for="label">Label (who/what is this for?)</label>
          <input id="label" type="text" placeholder="e.g. Investor demo — Acme" /></div>
        <div><button id="genBtn">Generate</button></div>
      </div>
      <div id="newCodeWrap" class="note mt hidden">
        New code: <span id="newCode" class="newcode"></span>
        <button id="copyBtn" class="link">copy</button>
        <span id="copyMsg" class="ok hidden">copied</span>
        <p class="hint" style="margin-top:8px">Copy it now and share it — the code is shown in the list below too.</p>
      </div>
      <div id="genErr" class="err hidden"></div>
    </section>

    <!-- CODES -->
    <section class="panel">
      <h2>Access codes</h2>
      <table id="codesTable">
        <thead><tr>
          <th>Label</th><th>Code</th><th>Created</th><th>Redeemed</th><th>Last active</th>
          <th class="num">Sessions</th><th class="num">Jobs</th><th class="num">Files</th><th class="num">Bytes</th><th></th>
        </tr></thead>
        <tbody id="codesBody"></tbody>
      </table>
      <p id="codesEmpty" class="muted hidden">No codes yet — generate one above.</p>
    </section>

    <!-- DETAIL -->
    <section id="detailPanel" class="panel hidden">
      <h2>Usage timeline — <span id="detailCode" class="code"></span></h2>
      <div id="timeline" class="timeline"></div>
      <p id="timelineEmpty" class="muted hidden">No events recorded for this code yet.</p>
      <p class="hint mt"><button id="closeDetail" class="link">close</button></p>
    </section>

    <p class="hint mt"><a href="/">← demo</a> · <a href="#" id="signout">Sign out</a></p>
  </main>
</div>

<script>
const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (n == null) return '—';
  if (n === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(2)) + ' ' + u[i];
}
function fmtTime(ms) {
  if (ms == null) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}

// ---- gate ----
$('enter').onclick = doEnter;
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') doEnter(); });
async function doEnter() {
  $('gateErr').classList.add('hidden');
  const r = await api('/admin/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: $('key').value }),
  });
  if (r.ok) { showMain(); }
  else {
    $('gateErr').textContent = (r.body && r.body.error && r.body.error.message) || 'Invalid key';
    $('gateErr').classList.remove('hidden');
  }
}
function showMain() { $('gate').classList.add('hidden'); $('main').classList.remove('hidden'); loadCodes(); }
$('signout').onclick = async (e) => { e.preventDefault(); await api('/admin/logout', { method: 'POST' }); location.reload(); };

// If an admin session is already valid, /admin/codes succeeds → skip the gate.
(async () => { const r = await api('/admin/codes'); if (r.ok) { renderCodes(r.body.codes || []); showMain(); } })();

// ---- generate ----
$('genBtn').onclick = doGenerate;
async function doGenerate() {
  $('genErr').classList.add('hidden');
  $('genBtn').disabled = true;
  const r = await api('/admin/codes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: $('label').value }),
  });
  $('genBtn').disabled = false;
  if (!r.ok) {
    $('genErr').textContent = (r.body && r.body.error && r.body.error.message) || 'Failed to generate';
    $('genErr').classList.remove('hidden');
    return;
  }
  $('newCode').textContent = r.body.code;
  $('newCodeWrap').classList.remove('hidden');
  $('copyMsg').classList.add('hidden');
  $('label').value = '';
  loadCodes();
}
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('newCode').textContent); $('copyMsg').classList.remove('hidden'); }
  catch {}
};

// ---- codes table ----
async function loadCodes() {
  const r = await api('/admin/codes');
  if (r.ok) renderCodes(r.body.codes || []);
}
function renderCodes(codes) {
  const tbody = $('codesBody'); tbody.innerHTML = '';
  $('codesEmpty').classList.toggle('hidden', codes.length > 0);
  for (const c of codes) {
    const tr = document.createElement('tr');
    const revoked = c.revokedAt != null;
    const redeemed = c.redeemed
      ? '<span class="pill ok">yes</span>'
      : '<span class="pill idle">no</span>';
    const statusPill = revoked ? ' <span class="pill bad">revoked</span>' : '';
    tr.innerHTML =
      '<td>' + (escapeHtml(c.label) || '<span class="muted">—</span>') + statusPill + '</td>'
      + '<td class="code">' + escapeHtml(c.code) + '</td>'
      + '<td>' + fmtTime(c.createdAt) + '</td>'
      + '<td>' + redeemed + '</td>'
      + '<td>' + fmtTime(c.lastActiveAt) + '</td>'
      + '<td class="num">' + (c.sessions || 0) + '</td>'
      + '<td class="num">' + (c.jobs || 0) + '</td>'
      + '<td class="num">' + (c.filesExtracted || 0) + '</td>'
      + '<td class="num">' + fmtBytes(c.bytes || 0) + '</td>'
      + '<td></td>';
    const actions = tr.lastElementChild;
    const view = document.createElement('button'); view.className = 'link'; view.textContent = 'timeline';
    view.onclick = () => showTimeline(c.code);
    actions.appendChild(view);
    if (!revoked) {
      const rev = document.createElement('button'); rev.className = 'danger'; rev.textContent = 'revoke';
      rev.onclick = () => revoke(c.code, c.label);
      actions.appendChild(rev);
    }
    tbody.appendChild(tr);
  }
}
async function revoke(code, label) {
  if (!confirm('Revoke code "' + code + '"' + (label ? ' (' + label + ')' : '') + '? It can no longer sign in.')) return;
  const r = await api('/admin/codes/' + encodeURIComponent(code) + '/revoke', { method: 'POST' });
  if (r.ok) loadCodes();
}

// ---- timeline ----
async function showTimeline(code) {
  $('detailCode').textContent = code;
  $('detailPanel').classList.remove('hidden');
  $('detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const r = await api('/admin/codes/' + encodeURIComponent(code) + '/timeline');
  const events = (r.ok && r.body && r.body.events) || [];
  const box = $('timeline'); box.innerHTML = '';
  $('timelineEmpty').classList.toggle('hidden', events.length > 0);
  for (const ev of events) {
    const div = document.createElement('div'); div.className = 'ev';
    const detail = ev.detail ? JSON.stringify(ev.detail) : '';
    div.innerHTML = '<span class="at">' + fmtTime(ev.at) + '</span>'
      + '<span class="ty">' + escapeHtml(ev.type) + '</span>'
      + '<span class="de">' + escapeHtml(detail) + '</span>';
    box.appendChild(div);
  }
}
$('closeDetail').onclick = () => $('detailPanel').classList.add('hidden');
</script>
</body>
</html>`;
