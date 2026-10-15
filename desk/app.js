/* Acquiro desk. One static page: sign in, read the deals through Supabase row level security, press buttons.
   The browser never executes anything. A button that changes or runs something inserts ONE row into acquiro.actions; the desk worker
   (src/acquiro/actions.py) claims it, does the work and writes the result back, and this page shows it live.
   No framework, no build step. Every value from the database goes in as a text node, never as HTML. */
(function () {
'use strict';

// ---------------------------------------------------------------------------------------------------------------------------------
// configuration. The anon key is public by design: it can do nothing the row level security does not allow a signed-in member to do.
var SUPABASE_URL = 'https://tdwnsfkdtveonleolizj.supabase.co';
var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkd25zZmtkdHZlb25sZW9saXpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNzg0NDgsImV4cCI6MjEwNzY1NDQ0OH0.bBpaCy6BDH2RWgnJxK2fIEort0loWDo3ZbwTLl89ByQ';
var SDK = {
  integrity: 'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok',
  urls: ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
         'https://unpkg.com/@supabase/supabase-js@2.117.2/dist/umd/supabase.js']
};
var GMAIL_DRAFT = 'https://mail.google.com/mail/u/0/#drafts/';
var PAGE = 20;                         // deals drawn at a time
var COMPS_CAP = 15;                    // rows in a comps table
var DESK_ONLINE_MS = 2 * 60 * 1000;    // a worker seen this recently is "online"

var VERDICTS = ['surface', 'pass', 'insufficient'];
var VERDICT_LABEL = { surface: 'Surface', pass: 'Pass', insufficient: 'Insufficient' };
var SOURCE_LABEL = { investorlift: 'InvestorLift', avivo_inbox: 'Agent', forwarded: 'Forwarded', listing_feed: 'MLS listing feed' };
var COMPS_SOURCE = { listprice_proxy: 'list-price proxy', mls_export: 'MLS export', mls_sold: 'MLS sold', origin_closed: 'Origin closed sales' };
var TAG_LABEL = { agent_sent: 'agent sent', we_found: 'we found', not_found: 'not found', listing: 'listing' };
var GATES = [['G1_comps', 'Comps'], ['G2_buildable', 'Buildable'], ['G3_zip', 'ZIP'], ['G5_flood', 'Flood']];
var GATE_CLASS = { pass: 'ok', amber: 'warn', fail: 'bad', insufficient: 'mute' };
var TREE_CLASS = { low: 'ok', medium: 'warn', high: 'bad', unknown: 'mute' };
var RFQ_ROLES = ['architect', 'civil', 'structural', 'interior'];
var KIND_LABEL = {
  approve_send: 'Approve & send', hold: 'Hold', pass: 'Pass', reopen: 'Reopen', note: 'Note', offer: 'Offer draft', rescreen: 'Re-screen',
  make_dossier: 'Dossier', make_lender_packet: 'Lender packet', make_rfq: 'Vendor RFQ', make_permit_intake: 'Permit intake',
  make_uw_copy: 'UW copy', run_pass: 'Run a pass', call_contact: 'AI call to the agent', email_contact: 'Email to the agent',
  add_to_call_list: 'Call list', refresh_buybox: 'Refresh buy box', sync_close: 'Sync Close', feed_pull: 'Pull the MLS feed', ping: 'Test the desk'
};
// What the worker has no code for yet. The worker publishes the real list (and its wording) into the workspace settings; this is only
// what the page assumes before it has read them.
var SOON_FALLBACK = {
  rescreen: 'Re-screening with what-if inputs is coming soon.',
  call_contact: 'Calling the agent from the desk is coming soon.',
  email_contact: 'Emailing the agent from the desk is coming soon.',
  add_to_call_list: 'The call list is coming soon.',
  refresh_buybox: 'Refreshing the buy box from the desk is coming soon.',
  sync_close: 'Starting the Close sync from the desk is coming soon.',
  feed_pull: 'Pulling the MLS feed on demand is coming soon.'
};
var OWNER_ONLY = { approve_send: 1, offer: 1, rescreen: 1, make_dossier: 1, make_lender_packet: 1, make_rfq: 1, make_permit_intake: 1, make_uw_copy: 1,
  run_pass: 1, call_contact: 1, email_contact: 1, add_to_call_list: 1, refresh_buybox: 1, sync_close: 1, feed_pull: 1 };

// ---------------------------------------------------------------------------------------------------------------------------------
// small helpers
function add(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (k) { add(el, k); }); return; }
  el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  });
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function $(sel, root) { return (root || document).querySelector(sel); }
function obj(x) {
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (e) { return {}; } }
  return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
}
function arr(x) {
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (e) { return []; } }
  return Array.isArray(x) ? x : [];
}
function num(x) {
  if (x == null || x === '' || typeof x === 'boolean') return null;
  var v = Number(x);
  return isFinite(v) ? v : null;
}
var NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function usd(x) { x = num(x); return x == null ? '' : (x < 0 ? '-' : '') + '$' + NF.format(Math.abs(Math.round(x))); }
function usdK(x) {          // nearest $1,000, the way the reply drafts and the board round
  x = num(x); if (x == null) return '';
  var v = Math.floor(Math.abs(x) / 1000 + 0.5) * 1000;
  return (x < 0 && v ? '-' : '') + '$' + NF.format(v);
}
function cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function zip5(z) { var m = /^\s*(\d{5})(?:\.0)?(?:-\d{4})?\s*$/.exec(String(z == null ? '' : z)); return m ? m[1] : null; }
function parseDate(s) {
  if (!s) return null;
  var t = String(s).trim().replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');      // Postgres can print +00, Date wants +00:00
  var d = new Date(t);
  return isNaN(d) ? null : d;
}
var CT = { timeZone: 'America/Chicago' };
function fmtDate(s) { var d = parseDate(s); return d ? new Intl.DateTimeFormat('en-US', Object.assign({ month: 'short', day: 'numeric', year: 'numeric' }, CT)).format(d) : null; }
function fmtCT(s) { var d = parseDate(s); return d ? new Intl.DateTimeFormat('en-US', Object.assign({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, CT)).format(d) : null; }
function rel(s) {
  var d = parseDate(s); if (!d) return '';
  var sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return Math.round(sec / 60) + ' min ago';
  if (sec < 86400) return Math.round(sec / 3600) + ' h ago';
  return Math.round(sec / 86400) + ' d ago';
}
function safeUrl(u) {
  var s = String(u || '').trim();
  if (!s) return null;
  try { var p = new URL(s); return (p.protocol === 'https:' || p.protocol === 'http:') && p.host ? s : null; } catch (e) { return null; }
}
// The database already redacts raw mail. This is the same rule applied once more to anything the page prints from a deal row.
var SECRET_PARAM = /\b(token|access_token|id_token|refresh_token|emailtoken|email_token|auth|authorization|key|apikey|api_key|secret|sig|signature|password|pwd|eml|session|sessionid|sid|jwt)=[^&\s"'<>)\]]+/gi;
function redact(s) {
  return String(s == null ? '' : s).replace(SECRET_PARAM, '$1=[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_+=-]{60,}/g, '[redacted]');
}
function haversine(a1, o1, a2, o2) {
  var R = 3958.7613, rad = Math.PI / 180, dLat = (a2 - a1) * rad, dLon = (o2 - o1) * rad;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function median(list) { var s = list.slice().sort(function (a, b) { return a - b; }), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } return null; }

var ICONS = {
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>',
  deals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/></svg>',
  feed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
};
function icon(name) { var t = document.createElement('template'); t.innerHTML = ICONS[name]; return t.content.firstChild; }

// ---------------------------------------------------------------------------------------------------------------------------------
// state
var S = {
  sb: null, session: null, email: '', member: null, org: null, settings: {},
  started: false, starting: false, demo: false,
  index: [], idx: new Map(), rows: new Map(), raws: new Map(), actions: [], byDeal: new Map(), workers: [], runs: [], comps: new Map(),
  artifacts: new Map(),
  tab: 'surface', q: '', shown: PAGE, open: new Set(), detailTab: 'underwriting',
  route: { name: 'deals' }, busy: false, again: false, timer: null, rt: null, loadedOnce: false, error: null, demoDone: false
};

// ---------------------------------------------------------------------------------------------------------------------------------
// toasts and sheets
function toast(text, kind) {
  var box = $('#toasts');
  var t = h('div', { class: 'toast' + (kind === 'bad' ? ' bad' : '') }, text);
  box.appendChild(t);
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, kind === 'bad' ? 7000 : 4500);
}

var sheetStack = [];
function openSheet(opts) {
  // opts: {title, body: Node|Node[], footer: Node|Node[], full: bool, onClose}
  var closeBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close' }, icon('close'));
  var sheet = h('div', { class: 'sheet' + (opts.full ? ' full' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Dialog' },
    h('header', null, h('h2', null, opts.title || ''), closeBtn),
    h('div', { class: 'sbody' }, opts.body),
    opts.footer ? h('footer', null, opts.footer) : null);
  var back = h('div', { class: 'backdrop' }, sheet);
  var api = { el: sheet, back: back, body: $('.sbody', sheet), close: close };
  function close() {
    if (!back.parentNode) return;
    back.parentNode.removeChild(back);
    sheetStack = sheetStack.filter(function (s) { return s !== api; });
    if (!sheetStack.length) document.body.classList.remove('locked');
    document.removeEventListener('keydown', onKey);
    if (opts.onClose) opts.onClose();
  }
  function onKey(e) { if (e.key === 'Escape' && sheetStack[sheetStack.length - 1] === api) close(); }
  closeBtn.addEventListener('click', close);
  back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.classList.add('locked');
  document.body.appendChild(back);
  sheetStack.push(api);
  var first = sheet.querySelector('input:not([type=hidden]), select, textarea');
  if (first && !opts.full) { try { first.focus({ preventScroll: true }); } catch (e) { /* older browsers */ } }
  return api;
}

// A button you must press and hold for a second: the second confirmation before anything is sent to a third party.
function holdButton(label, ms, onDone) {
  var fill = h('i', { class: 'fill' });
  var btn = h('button', { class: 'btn primary block hold', type: 'button' }, fill, h('span', null, label));
  var timer = null, fired = false;
  function start(e) { if (e && e.type === 'keydown' && (e.repeat || (e.key !== ' ' && e.key !== 'Enter'))) return; if (e && e.type === 'keydown') e.preventDefault(); if (timer || fired) return; btn.classList.add('on'); timer = setTimeout(function () { fired = true; btn.classList.remove('on'); onDone(btn); }, ms); }
  function stop() { if (timer) { clearTimeout(timer); timer = null; } btn.classList.remove('on'); }
  btn.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(function (ev) { btn.addEventListener(ev, stop); });
  btn.addEventListener('keydown', start);
  btn.addEventListener('keyup', stop);
  btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  btn.setLabel = function (t) { clear($('span', btn)).appendChild(document.createTextNode(t)); };
  return btn;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// supabase
function loadSdk() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var urls = SDK.urls.slice();
    (function next() {
      var u = urls.shift();
      if (!u) return reject(new Error('The sign-in library did not load.'));
      var s = document.createElement('script');
      s.src = u; s.integrity = SDK.integrity; s.crossOrigin = 'anonymous';
      s.onload = function () { (window.supabase && window.supabase.createClient) ? resolve() : next(); };
      s.onerror = function () { s.remove(); next(); };
      document.head.appendChild(s);
    })();
  });
}
function explain(err) {
  var m = String((err && (err.message || err.error_description)) || err || '');
  var code = err && (err.code || err.status);
  if (/rate limit|too many|over_email_send_rate_limit|429/i.test(m + ' ' + code)) return 'Too many sign-in emails just now. Wait a few minutes and try again.';
  if (/not authorized|not_authorized/i.test(m)) return 'The email service is not allowed to send to that address yet. Ask your admin.';
  if (/expired|invalid/i.test(m) && /otp|token|code|link/i.test(m)) return 'That code or link is not valid any more. Ask for a new one.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No connection. Check your signal and try again.';
  return m || 'Something went wrong.';
}
function redirectUrl() {
  var base = location.origin + location.pathname.replace(/index\.html$/, '');
  return base + (S.demo ? '?demo=1' : '');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// screens that are not the desk: loading, sign in, not a member
var app = function () { return $('#app'); };
function showSplash(text) { clear(app()).appendChild(h('div', { class: 'splash' }, text || 'Loading the desk')); }
function fatal(text) { clear(app()).appendChild(h('div', { class: 'login' }, h('div', { class: 'box' }, h('div', { class: 'wm' }, 'Acquiro'), h('p', { class: 'msg bad' }, text), h('button', { class: 'btn primary block', type: 'button', onclick: function () { location.reload(); } }, 'Try again')))); }

function urlProblem() {
  var src = (location.hash.length > 1 ? location.hash.slice(1) : '') + '&' + location.search.slice(1);
  var p = new URLSearchParams(src.replace(/^\/[^&]*&?/, ''));
  var d = p.get('error_description') || p.get('error');
  if (!d) return null;
  if (/expired|invalid|otp/i.test(d + ' ' + (p.get('error_code') || ''))) return 'That sign-in link has expired or was already used. Some mail apps open links before you do. Ask for a new email and use the code.';
  return d.replace(/\+/g, ' ');
}

function renderLogin(state) {
  state = state || {};
  var email = state.email || store('acquiro-desk-email') || '';
  var msgBox = h('div', { class: 'stack' });
  function say(text, kind) { clear(msgBox); if (text) msgBox.appendChild(h('p', { class: 'msg' + (kind ? ' ' + kind : ''), role: kind === 'bad' ? 'alert' : 'status' }, text)); }
  if (state.problem) say(state.problem, 'bad');
  var box;

  if (state.step !== 'sent') {
    var input = h('input', { type: 'email', name: 'email', id: 'login-email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, placeholder: 'you@company.com', value: email });
    var go = h('button', { class: 'btn primary block', type: 'submit' }, 'Email me a sign-in code');
    var link = h('button', { class: 'btn quiet block', type: 'button' }, 'Email me a link instead');
    var send = async function (mode) {
      var v = input.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { say('Enter your work email.', 'bad'); input.focus(); return; }
      go.disabled = link.disabled = true; say('Sending...');
      var r = await S.sb.auth.signInWithOtp({ email: v, options: { shouldCreateUser: true, emailRedirectTo: redirectUrl() } });
      go.disabled = link.disabled = false;
      if (r.error) { say(explain(r.error), 'bad'); return; }
      store('acquiro-desk-email', v);
      renderLogin({ step: 'sent', email: v, mode: mode });
    };
    var form = h('form', { novalidate: true, onsubmit: function (e) { e.preventDefault(); send('code'); } },
      h('label', null, 'Work email', input), h('div', { class: 'stack' }, go, link));
    link.addEventListener('click', function () { send('link'); });
    box = h('div', { class: 'box' }, h('div', { class: 'wm' }, 'Acquiro'), h('h1', null, 'Sign in to the desk'),
      h('p', { class: 'muted' }, 'We email you a code. Type it here to sign in.'), msgBox, form,
      h('p', { class: 'fine' }, 'Access is by invitation. No password to remember.'));
    setTimeout(function () { if (!input.value) input.focus(); }, 50);
  } else {
    var code = h('input', { class: 'code', type: 'text', id: 'login-code', name: 'one-time-code', autocomplete: 'one-time-code', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '10', placeholder: '------', 'aria-label': 'Sign-in code' });
    var verify = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');
    var again = h('button', { class: 'btn quiet block', type: 'button', onclick: function () { renderLogin({ email: state.email }); } }, 'Use a different email');
    var check = async function () {
      var token = code.value.replace(/\D/g, '');
      if (token.length < 6) { say('Enter the code from the email.', 'bad'); code.focus(); return; }
      verify.disabled = true; say('Checking...');
      var r = await S.sb.auth.verifyOtp({ email: state.email, token: token, type: 'email' });
      if (r.error) r = await S.sb.auth.verifyOtp({ email: state.email, token: token, type: 'signup' });
      verify.disabled = false;
      if (r.error) { say(explain(r.error), 'bad'); code.select(); return; }
      say('Signed in.', 'ok');
    };
    var f2 = h('form', { novalidate: true, onsubmit: function (e) { e.preventDefault(); check(); } }, h('label', null, 'Code from the email', code), h('div', { class: 'stack' }, verify));
    box = h('div', { class: 'box' }, h('div', { class: 'wm' }, 'Acquiro'), h('h1', null, 'Check your email'),
      h('p', null, 'We sent a message to ', h('b', null, state.email), '.'),
      h('p', { class: 'muted' }, state.mode === 'link' ? 'Tap the link in it. On a phone, if your mail app opens the link in its own window, choose Open in browser so you stay signed in. Or type the code if the email shows one.' : 'Type the code it shows. If it only has a link, tap the link. On a phone, if your mail app opens it in its own window, choose Open in browser.'),
      msgBox, f2, again, h('p', { class: 'fine' }, 'Sign-in emails are limited to a few per hour. Sign in once on your phone and it stays signed in.'));
    setTimeout(function () { code.focus(); }, 50);
  }
  clear(app()).appendChild(h('div', { class: 'login' }, box));
}

function renderNoAccess() {
  clear(app()).appendChild(h('div', { class: 'login' }, h('div', { class: 'box' }, h('div', { class: 'wm' }, 'Acquiro'), h('h1', null, 'Ask your admin'),
    h('p', null, h('b', null, S.email), ' is signed in, but it is not on a workspace yet.'),
    h('p', { class: 'muted' }, 'Ask your admin to add this address. Then reload this page.'),
    h('button', { class: 'btn block', type: 'button', onclick: signOut }, 'Sign out'))));
}

async function signOut() {
  stopLive();
  try { await S.sb.auth.signOut(); } catch (e) { /* the local session is cleared either way */ }
  S.started = false; S.member = null; S.org = null; S.loadedOnce = false;
  S.rows.clear(); S.raws.clear(); S.index = []; S.actions = []; S.byDeal.clear();
  renderLogin();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// loading data
async function q(promise) { var r = await promise; if (r.error) throw r.error; return r.data; }
function tbl(name) { return S.sb.from(name); }

async function loadIndex() {
  var out = [], from = 0;
  for (;;) {
    var data = await q(tbl('deals_index').select('*').neq('status', 'merged').order('created_at', { ascending: false }).range(from, from + 999));
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}
async function loadActions() {
  return q(tbl('actions').select('id,deal_id,kind,params,status,result,requested_by,requested_at,started_at,finished_at').order('requested_at', { ascending: false }).limit(600));
}
async function loadWorkers() { return q(tbl('workers').select('*').order('last_seen', { ascending: false }).limit(10)); }
async function loadRuns() { return q(tbl('runs').select('id,started_at,finished_at,mode,raw_seen,deals_new,screened,surfaced,drafted,errors').order('started_at', { ascending: false }).limit(25)); }
async function loadOrg() {
  var o = await q(tbl('orgs').select('id,name,settings').eq('id', S.member.org_id).maybeSingle());
  S.org = o; S.settings = (o && o.settings) || {};
}

function indexActions(list) {
  S.actions = list; S.byDeal = new Map();
  list.forEach(function (a) { if (!a.deal_id) return; (S.byDeal.get(a.deal_id) || S.byDeal.set(a.deal_id, []).get(a.deal_id)).push(a); });
}

async function ensureRows(ids) {
  var need = ids.filter(function (id) {
    var have = S.rows.get(id), ix = S.idx.get(id);
    return !have || (ix && String(have.updated_at) !== String(ix.updated_at));
  });
  for (var i = 0; i < need.length; i += 40) {
    var chunk = need.slice(i, i + 40);
    var rows = await q(tbl('deals').select('*').in('id', chunk));
    rows.forEach(function (r) { S.rows.set(r.id, r); });
    var rawIds = rows.map(function (r) { return r.raw_id; }).filter(function (id) { return id && !S.raws.has(id); });
    if (rawIds.length) {
      var raws = await q(tbl('deals_raw_redacted').select('id,source,subject,sender,received_at').in('id', rawIds));
      raws.forEach(function (r) { S.raws.set(r.id, r); });
    }
  }
}

function visibleIds() {
  var r = S.route.name, ids = [];
  if (r === 'deals') ids = filtered().slice(0, S.shown).map(function (x) { return x.id; });
  else if (r === 'today') ids = todayDeals().map(function (x) { return x.id; });
  else if (r === 'deal') ids = [S.route.id];
  else if (r === 'feed') ids = S.actions.slice(0, 60).map(function (a) { return a.deal_id; }).filter(Boolean);
  if (S.demo && !S.demoDone) { var inw = inwood(); if (inw) ids = [inw.id].concat(ids); }
  return Array.from(new Set(ids));
}

async function refreshAll(opts) {
  if (S.busy) { S.again = true; return; }
  S.busy = true;
  var btn = $('#refresh'); if (btn) btn.classList.add('spin');
  try {
    var res = await Promise.all([loadIndex(), loadActions(), loadWorkers(), loadRuns()]);
    S.index = res[0]; S.idx = new Map(S.index.map(function (r) { return [r.id, r]; }));
    indexActions(res[1]); S.workers = res[2]; S.runs = res[3];
    S.error = null;
    await ensureRows(visibleIds());
    S.loadedOnce = true;
  } catch (e) {
    S.error = e;
    if (!(opts && opts.quiet)) toast(explain(e), 'bad');
  } finally {
    S.busy = false;
    if (btn) btn.classList.remove('spin');
  }
  render();
  if (S.again) { S.again = false; refreshAll({ quiet: true }); }
}

// live: Realtime tells the page something changed, a timer covers a dead socket and a sleeping phone
var refreshSoon = (function () { var t = null; return function () { clearTimeout(t); t = setTimeout(function () { refreshAll({ quiet: true }); }, 450); }; })();
function pending() { return S.actions.some(function (a) { return a.status === 'queued' || a.status === 'running'; }); }
function startLive() {
  stopLive();
  try {
    var ch = S.sb.channel('desk-live');
    ['actions', 'deals', 'workers'].forEach(function (t) { ch.on('postgres_changes', { event: '*', schema: 'acquiro', table: t }, refreshSoon); });
    ch.subscribe();
    S.rt = ch;
  } catch (e) { S.rt = null; }
  (function tick() {
    S.timer = setTimeout(function () {
      if (document.visibilityState === 'visible') refreshAll({ quiet: true });
      tick();
    }, pending() ? 6000 : 30000);
  })();
}
function stopLive() {
  clearTimeout(S.timer); S.timer = null;
  if (S.rt && S.sb) { try { S.sb.removeChannel(S.rt); } catch (e) { /* closing anyway */ } }
  S.rt = null;
}
document.addEventListener('visibilitychange', function () { if (S.started && document.visibilityState === 'visible') refreshAll({ quiet: true }); });

// ---------------------------------------------------------------------------------------------------------------------------------
// derived: what a deal is, in the board's own words
function hasStreet(d) { return !!String(d.street || '').trim() || /^\d+\s/.test(String(d.address || '').trim()); }
function isFeed(d) { return !!obj(d.facts).listing_feed || d.is_feed === true; }
function verdictOf(d) {
  var s = obj(d.screen);
  return VERDICTS.indexOf(d.verdict) >= 0 ? d.verdict : (VERDICTS.indexOf(s.verdict) >= 0 ? s.verdict : null);
}
function titleOf(d) {
  var street = hasStreet(d), addr = String(d.address || '').trim();
  if (street && addr) return addr;
  var z = zip5(d.zip);
  return z ? 'ZIP only ' + z : 'No address';
}
function sourceKey(d) { var raw = S.raws.get(d.raw_id); return isFeed(d) ? 'listing_feed' : (raw && raw.source) || null; }
function uwUrls(d) {
  var out = [], re = /UW copy:\s*(\S+)/g, m;
  while ((m = re.exec(String(d.notes || '')))) { var u = safeUrl(m[1].replace(/[.,;)|]+$/, '')); if (u && out.indexOf(u) < 0) out.push(u); }
  return out;
}
function tagOf(d, field) {
  if (String(d[field] == null ? '' : d[field]).trim() === '') return 'not_found';
  var t = obj(d.field_sources)[field];
  return t === 'agent_sent' || t === 'we_found' || t === 'listing' ? t : null;
}
function targetLabel() {
  var t = num(obj(S.settings.pack).target_profit_per_lot);
  if (!t || t <= 0) return null;
  return t % 1000 === 0 ? '$' + NF.format(t / 1000) + 'k' : usd(t);
}
function bindingCaption(screen) {
  var t = targetLabel(), cap = t ? 'seller-facing · still makes ' + t + '/lot' : 'seller-facing';
  var b = screen.max_price_binding_test, m = num(obj(S.settings.pack).min_margin_on_cost);
  if (b === 'margin') cap += m ? ' · binds: ' + (Math.round(m * 1000) / 10) + '% margin' : ' · binds: margin';
  else if (b === 'profit_floor') cap += t ? ' · binds: ' + t + ' floor' : ' · binds: profit floor';
  return cap;
}
function replied(d) { return d.status === 'sent' || d.status === 'bounced'; }
function canSendDraft(d) { return !!String(d.reply_draft_id || '').trim() && !replied(d); }

function latest(dealId, kind) {
  var list = S.byDeal.get(dealId) || [];
  for (var i = 0; i < list.length; i++) if (list[i].kind === kind) return list[i];
  return null;
}
function soonText(kind) {
  var a = obj(S.settings.actions);
  if (a.soon && a.soon[kind]) return a.soon[kind];
  if (!a.soon && SOON_FALLBACK[kind]) return SOON_FALLBACK[kind];
  return null;
}
function isSoon(kind) { return !!soonText(kind); }
function workerState() {
  var w = S.workers[0];
  if (!w) return { cls: '', label: 'Desk not seen yet', online: false };
  var age = Date.now() - parseDate(w.last_seen).getTime();
  if (age <= DESK_ONLINE_MS) return { cls: 'on', label: 'Desk online', online: true, w: w };
  return { cls: 'idle', label: 'Desk idle · ' + rel(w.last_seen), online: false, w: w };
}

// tabs
function tabOf(d) {
  // a deal sits in exactly one of: held (you put it aside), replied, or by verdict; Feed is a cross-cut
  if (d.status === 'held' || d.status === 'passed') return 'held';
  if (replied(d)) return 'replied';
  var v = verdictOf(d);
  return v === 'surface' ? 'surface' : 'pass';
}
function inTab(d, tab) {
  if (tab === 'all') return true;
  if (tab === 'feed') return isFeed(d);
  return tabOf(d) === tab;
}
function inwood() { return S.index.find(function (r) { return !r.is_feed && /2501 Inwood Pl/i.test(r.address || ''); }) || S.index.find(function (r) { return /2501 Inwood Pl/i.test(r.address || ''); }) || null; }
function sortList(list, tab) {
  var out = list.slice();
  if (tab === 'surface') {
    out.sort(function (a, b) { return (a.is_feed ? 1 : 0) - (b.is_feed ? 1 : 0) || (num(b.profit) || -Infinity) - (num(a.profit) || -Infinity); });
  } else {
    out.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  }
  if (S.demo) { var i = inwood(); if (i) { var at = out.findIndex(function (r) { return r.id === i.id; }); if (at > 0) out.unshift(out.splice(at, 1)[0]); } }
  return out;
}
function filtered() {
  var term = S.q.trim().toLowerCase();
  var list = S.index.filter(function (d) {
    if (!inTab(d, S.tab)) return false;
    if (!term) return true;
    return (String(d.address || '') + ' ' + String(d.zip || '') + ' ' + String(d.agent_name || '')).toLowerCase().indexOf(term) >= 0;
  });
  return sortList(list, S.tab);
}
function counts() {
  var c = { all: S.index.length, surface: 0, pass: 0, replied: 0, feed: 0, held: 0, insufficient: 0, drafts: 0 };
  S.index.forEach(function (d) {
    c[tabOf(d)]++;
    if (isFeed(d)) c.feed++;
    if (verdictOf(d) === 'insufficient') c.insufficient++;
    if (canSendDraft(d) && tabOf(d) !== 'held') c.drafts++;
  });
  return c;
}
function todayDeals() {
  var list = S.index.filter(function (d) { return tabOf(d) === 'surface'; });
  return sortList(list, 'surface').slice(0, 5);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// building blocks of a deal card
function chip(cls, text) { return h('span', { class: 'chip ' + cls }, text); }
function verdictChip(v) { return v ? chip(v, VERDICT_LABEL[v]) : chip('none', 'Not screened'); }
function tagEl(t) { return TAG_LABEL[t] ? h('span', { class: 'tag ' + t }, TAG_LABEL[t]) : null; }
function note1(label, text) { return h('p', { class: 'note1' }, h('b', null, label), text); }

function statusChips(d) {
  var out = [];
  if (d.status === 'sent') out.push(chip('ok', d.sent_at ? 'Replied · sent ' + fmtCT(d.sent_at) : 'Replied'));
  else if (d.status === 'bounced') out.push(chip('bad', d.sent_at ? 'Replied · bounced (sent ' + fmtCT(d.sent_at) + ')' : 'Replied · bounced'));
  else if (d.status === 'held') out.push(chip('warn', 'On hold'));
  else if (d.status === 'passed') out.push(chip('mute', 'Passed by you'));
  if (isFeed(d)) out.push(chip('line', 'MLS feed'));
  var offer = obj(obj(d.facts).offer);
  var pOffer = (S.byDeal.get(d.id) || []).find(function (a) { return a.kind === 'offer' && (a.status === 'queued' || a.status === 'running'); });
  var pSend = (S.byDeal.get(d.id) || []).find(function (a) { return a.kind === 'approve_send' && (a.status === 'queued' || a.status === 'running'); });
  if (pSend) out.push(chip('accent', 'Send queued'));
  else if (pOffer) out.push(chip('accent', 'Offer queued' + (num(obj(pOffer.params).price) ? ' · ' + usd(obj(pOffer.params).price) : '')));
  else if (offer.draft_id && offer.draft_id === d.reply_draft_id && !replied(d)) out.push(chip('ok', 'Offer draft ready' + (num(offer.price) ? ' · ' + usd(offer.price) : '')));
  else if (canSendDraft(d)) out.push(chip('ok', 'Draft in Gmail'));
  return out;
}

function moneyLine(d) {
  var s = obj(d.screen), profit = num(s.profit_per_lot), price = num(s.max_price_for_600k), ask = num(d.ask_price);
  var parts = h('div', { class: 'money1' });
  if (profit != null) parts.appendChild(h('span', { class: 'big' + (profit < 0 ? ' neg' : '') }, usdK(profit), h('span', { class: 'small' }, ' profit/lot')));
  if (price != null && price > 0) parts.appendChild(h('span', { class: 'small' }, 'max ', h('b', null, usdK(price))));
  if (ask != null) parts.appendChild(h('span', { class: 'small' }, 'ask ', h('b', null, usd(ask))));
  if (!parts.firstChild) {
    var reasons = arr(s.reasons);
    parts.appendChild(h('span', { class: 'small' }, reasons.length ? cap1(reasons[0]) : (Object.keys(s).length ? 'No profit or price quoted.' : 'Not screened yet.')));
  }
  return parts;
}

function compsInfo(d) {
  var sc = obj(obj(d.screen).comps);
  var n = num(sc.n) || 0, med = num(sc.median_psf), z = zip5(d.zip);
  var where = z ? ' in ' + z : '';
  var srcs = String(sc.source || '').split('+').filter(function (x) { return x && x !== 'none'; }).map(function (x) { return COMPS_SOURCE[x] || x.replace(/_/g, ' '); }).join(' + ');
  var line;
  if (!Object.keys(sc).length) return null;
  if (n === 0) line = 'no closed new builds found' + where;
  else if (med == null) line = n + ' closed new build' + (n === 1 ? '' : 's') + where + ', too few to quote a median';
  else {
    var wp = num(sc.weighted_psf);
    line = n + ' closed new builds' + where + ' · median $' + NF.format(med) + '/sf' + (wp ? ' · $' + NF.format(wp) + '/sf distance-weighted' : '') + ' · confidence ' + (sc.confidence || 'insufficient');
  }
  var box = h('div', { class: 'comps1' }, h('p', { class: 'lbl' }, 'Comps'), h('p', null, line, srcs ? ' · ' : '', srcs ? h('span', { class: 'muted' }, srcs) : null));
  var band = obj(sc.band), lo = num(band.lo), hi = num(band.hi);
  if (lo != null && hi != null) {
    var bits = [];
    if (num(band.planned_sf_per_unit)) bits.push(NF.format(band.planned_sf_per_unit) + ' sf per unit planned');
    bits.push('comps from ' + NF.format(lo) + ' to ' + NF.format(hi) + ' sf');
    if (num(band.n_before_band) != null) bits.push(n + ' kept of ' + Math.round(band.n_before_band) + ' considered');
    if (num(band.n_outliers_dropped)) bits.push(Math.round(band.n_outliers_dropped) + ' outlier' + (band.n_outliers_dropped === 1 ? '' : 's') + ' dropped');
    box.appendChild(note1('Band', bits.join(' · ')));
  }
  var rad = obj(sc.radius), rb = [];
  if (Object.keys(rad).length) {
    [['n_within_0_25', 'within 0.25 mi'], ['n_within_0_5', 'within 0.5 mi'], ['n_within_1_0', 'within 1.0 mi']].forEach(function (p) { if (num(rad[p[0]]) != null) rb.push(Math.round(rad[p[0]]) + ' ' + p[1]); });
    if (num(rad.n_no_coords)) rb.push(Math.round(rad.n_no_coords) + ' without coordinates');
    if (num(rad.max_mi) != null) rb.push('max ' + Number(rad.max_mi).toFixed(1) + ' mi');
    if (rb.length) box.appendChild(note1('Radius', rb.join(' · ')));
  }
  return box;
}

function gateChips(d) {
  var g = obj(obj(d.screen).gates), items = [];
  GATES.forEach(function (p) { if (g[p[0]]) items.push(h('li', { class: 'g ' + (GATE_CLASS[g[p[0]]] || 'mute') }, p[1] + ' ', h('b', null, g[p[0]]))); });
  var flag = String(obj(d.facts).tree_flag || '').toLowerCase();
  if (items.length && TREE_CLASS[flag]) items.push(h('li', { class: 'g ' + TREE_CLASS[flag] }, 'Trees ', h('b', null, flag)));
  return items.length ? h('ul', { class: 'gates', 'aria-label': 'Gates' }, items) : null;
}

function moneyBlock(d) {
  var s = obj(d.screen);
  if (!Object.keys(s).length) return null;
  var profit = num(s.profit_per_lot), price = num(s.max_price_for_600k), down = num(s.downturn_profit_per_lot), margin = num(s.margin_on_cost);
  var out = [];
  if (profit == null && price == null) out.push(h('p', { class: 'empty' }, 'No profit or price quoted.'));
  else {
    var units = s.best_units ? ' at ' + s.best_units + ' units' : '';
    var p = profit == null ? h('span', { class: 'v na' }, 'no ask, so not worked out') : h('span', { class: 'v' + (profit < 0 ? ' neg' : '') }, usdK(profit));
    var m, cap = null;
    if (price == null) m = h('span', { class: 'v na' }, 'not quoted');
    else if (price <= 0) m = h('span', { class: 'v na' }, 'none: even free land misses');
    else { m = h('span', { class: 'v' }, usdK(price)); cap = h('span', { class: 'cap' }, bindingCaption(s)); }
    out.push(h('div', { class: 'money' }, h('div', null, h('span', { class: 'lbl' }, 'Profit per lot' + units), p), h('div', null, h('span', { class: 'lbl' }, 'Max purchase price'), m, cap)));
  }
  if (margin != null && (profit != null || price != null)) out.push(note1('Margin', Math.round(margin * 100) + '% on all-in cost at the ask'));
  if (down != null && down < 0) out.push(h('p', { class: 'down' }, 'In a downturn this loses ' + usdK(Math.abs(down)) + ' per lot.'));
  else if (down != null && down > 0) out.push(h('p', { class: 'down ok' }, 'In a downturn profit is still ' + usdK(down) + ' per lot.'));
  else if (down === 0) out.push(h('p', { class: 'down ok' }, 'In a downturn it breaks even.'));
  return h('div', { class: 'stack' }, out);
}

function outcomeBlock(d) {
  var v = verdictOf(d), bullets = arr(d.reply_bullets).map(String).filter(function (b) { return b.trim(); });
  var kids = [], draft = String(d.reply_draft_id || '').trim(), inquire = safeUrl(d.inquire_url);
  var quote = bullets.length ? h('blockquote', null, h('ul', null, bullets.map(function (b) { return h('li', null, b); }))) : null;
  if (replied(d)) {
    kids.push(d.status === 'bounced' ? chip('bad', 'Replied · bounced') : chip('ok', d.sent_at ? 'Replied · sent ' + fmtCT(d.sent_at) : 'Replied'), quote);
  } else if (v === 'surface') {
    var sn = String(d.surface_note || '').trim();
    kids.push(h('p', { class: 'lbl' }, 'Surface note'), h('p', { class: 'snote' }, sn || 'No note recorded.'));
    if (draft) kids.push(h('p', { class: 'lbl' }, 'Draft'), draftLink(draft));
  } else if (v === 'pass' || v === 'insufficient') {
    if (draft) kids.push(draftLink(draft), quote);
    else if (inquire) kids.push(h('a', { class: 'btn sm', href: inquire, target: '_blank', rel: 'noopener noreferrer' }, 'Inquire on InvestorLift'), quote);
    else if (bullets.length && isFeed(d)) kids.push(chip('line', 'Listing feed · screened, no reply drafted'), quote);
    else if (bullets.length) kids.push(chip('line', 'Draft not created yet'), quote);
    else kids.push(chip('line', 'No reply drafted'));
  } else kids.push(chip('line', 'Not screened yet'));
  return h('div', { class: 'outcome' }, kids);
}
function draftLink(id) {
  return h('a', { class: 'btn sm', href: GMAIL_DRAFT + encodeURIComponent(id), target: '_blank', rel: 'noopener noreferrer' }, 'Open the Gmail draft ↗');
}
function linkRow(d) {
  var items = [], uw = uwUrls(d), lu = safeUrl(d.listing_url);
  if (uw.length) items.push(h('a', { class: 'btn sm primary', href: uw[uw.length - 1], target: '_blank', rel: 'noopener noreferrer' }, 'UW copy ↗'));
  if (lu) items.push(h('a', { class: 'btn sm', href: lu, target: '_blank', rel: 'noopener noreferrer' }, 'Listing ↗'));
  return items.length ? h('div', { class: 'links' }, items) : null;
}

function factsBlock(d) {
  var f = obj(d.facts), miss = function () { return h('span', { class: 'miss' }, 'not found'); };
  var lot = num(d.lot_sf), canopy = num(f.canopy_pct), arv = num(d.claimed_arv), ask = num(d.ask_price);
  var lotEl = lot != null ? [NF.format(lot) + ' sf', tagEl(tagOf(d, 'lot_sf')), canopy != null ? h('span', { class: 'canopy', title: 'share of the lot under tree canopy, City of Austin 2022 map' }, Math.round(canopy) + '% canopy') : null] : miss();
  var zon = String(d.zoning || '').trim();
  var flood = f.floodplain;
  return h('dl', { class: 'facts' },
    h('div', null, h('dt', null, 'Ask'), h('dd', null, ask != null ? usd(ask) : miss())),
    h('div', null, h('dt', null, 'Claimed ARV'), h('dd', null, arv != null ? [usd(arv), h('span', { class: 'theirs' }, 'their number')] : miss())),
    h('div', null, h('dt', null, 'Lot'), h('dd', null, lotEl)),
    h('div', null, h('dt', null, 'Zoning'), h('dd', null, zon ? [zon, tagEl(tagOf(d, 'zoning'))] : miss())),
    flood ? h('div', null, h('dt', null, 'Flood'), h('dd', null, String(flood))) : null,
    String(d.agent_name || '').trim() ? h('div', null, h('dt', null, 'Agent'), h('dd', null, d.agent_name)) : null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// comps table (read from the comps rows for the ZIP, narrowed the way the screen narrowed them)
async function loadComps(z) {
  if (S.comps.has(z)) return S.comps.get(z);
  var rows = null;
  try { rows = await q(tbl('comps').select('address,zip,psf,living_sf,close_price,lat,lon').eq('zip', z).limit(5000)); } catch (e) { rows = null; }
  S.comps.set(z, rows);
  return rows;
}
function compTable(d, rows) {
  var screen = obj(d.screen), sc = obj(screen.comps), f = obj(d.facts), pack = obj(S.settings.pack);
  if (rows == null) return { unavailable: true, rows: [] };
  var subject = (num(f.lat) != null && num(f.lon) != null) ? [Number(f.lat), Number(f.lon)] : null;
  var entries = rows.filter(function (r) { return (num(r.psf) || 0) > 0; }).map(function (r) {
    var has = num(r.lat) != null && num(r.lon) != null;
    return { r: r, mi: subject && has ? haversine(subject[0], subject[1], Number(r.lat), Number(r.lon)) : null };
  });
  var maxMi = num(obj(sc.radius).max_mi);
  if (subject && maxMi != null) entries = entries.filter(function (e) { return e.mi == null || e.mi <= maxMi; });
  var band = obj(sc.band), lo = num(band.lo), hi = num(band.hi), banded = lo != null && hi != null;
  if (banded) {
    entries = entries.filter(function (e) { var sf = num(e.r.living_sf) || 0; return sf > 0 && sf >= lo && sf <= hi; });
    var minC = num(pack.g1_min_comps), pct = num(pack.outlier_pct);
    if (minC != null && pct != null && entries.length >= minC) {
      var med = median(entries.map(function (e) { return Number(e.r.psf); }));
      entries = entries.filter(function (e) { return Math.abs(Number(e.r.psf) - med) <= pct * med; });
    }
  }
  entries.sort(function (a, b) { return (a.mi == null) - (b.mi == null) || (a.mi || 0) - (b.mi || 0) || Number(a.r.psf) - Number(b.r.psf); });
  return { rows: entries.slice(0, COMPS_CAP), total: entries.length, banded: banded, hasMiles: entries.slice(0, COMPS_CAP).some(function (e) { return e.mi != null; }) };
}
function compsBlock(d, host) {
  var z = zip5(d.zip);
  if (!z || !Object.keys(obj(d.screen)).length) { host.appendChild(h('p', { class: 'empty' }, 'No screen, so no comps to show.')); return; }
  host.appendChild(h('p', { class: 'muted' }, 'Loading the comps...'));
  loadComps(z).then(function (rows) {
    var t = compTable(d, rows); clear(host);
    if (t.unavailable) { host.appendChild(h('p', { class: 'empty' }, 'The comps table could not be read.')); return; }
    if (!t.rows.length) { host.appendChild(h('p', { class: 'empty' }, 'No comps rows ' + (t.banded ? 'in the size band' : 'for ' + z) + ' in the store.')); return; }
    var head = h('tr', null, h('th', null, 'Address'), h('th', { class: 'num' }, '$/sf'), h('th', { class: 'num' }, 'Sf'), h('th', { class: 'num' }, 'Price'), t.hasMiles ? h('th', { class: 'num' }, 'Miles') : null);
    var body = t.rows.map(function (e) {
      return h('tr', null, h('td', null, e.r.address || '-'), h('td', { class: 'num' }, '$' + NF.format(Number(e.r.psf))), h('td', { class: 'num' }, num(e.r.living_sf) ? NF.format(e.r.living_sf) : '-'),
        h('td', { class: 'num' }, num(e.r.close_price) ? usd(e.r.close_price) : '-'), t.hasMiles ? h('td', { class: 'num' }, e.mi != null ? e.mi.toFixed(2) : '-') : null);
    });
    var sc = obj(obj(d.screen).comps);
    var lead = t.rows.length === t.total ? 'All ' + t.total + ' comps, ' : t.rows.length + ' of ' + t.total + ' comps shown, ';
    host.appendChild(h('div', { class: 'tscroll' }, h('table', { class: 't' }, h('caption', { class: 'sr' }, 'Comps behind the screen'), h('thead', null, head), h('tbody', null, body))));
    host.appendChild(h('p', { class: 'cap' }, lead + (t.hasMiles ? 'nearest first, then $/sf.' : 'lowest $/sf first.')));
    if (num(sc.low_psf) != null && num(sc.median_psf) != null && num(sc.high_psf) != null) host.appendChild(h('p', { class: 'cap' }, 'Across the ' + (sc.n || 0) + ' comps the screen used: low $' + NF.format(sc.low_psf) + ', median $' + NF.format(sc.median_psf) + ', high $' + NF.format(sc.high_psf) + ' per sf.'));
    if (sc.notes) host.appendChild(h('p', { class: 'cap' }, redact(sc.notes)));
  });
}
function unitsBlock(d) {
  var s = obj(d.screen), bu = obj(s.by_units), keys = Object.keys(bu).sort(function (a, b) { return Number(a) - Number(b); });
  if (!keys.length) return null;
  var best = keys.map(function (k) { return s.best_units != null && String(s.best_units) === k; });
  var rowsDef = [['Buildable sf', 'buildable_sf', function (v) { return NF.format(v); }], ['Sales', 'sales', usdK], ['All-in cost', 'all_in_cost', usdK], ['Profit per lot', 'profit_per_lot', usdK]];
  var head = h('tr', null, h('th', null, 'Per lot'), keys.map(function (k, i) { return h('th', { class: 'num' }, k + ' units', best[i] ? ' ' : null, best[i] ? h('span', { class: 'tag we_found' }, 'chosen') : null); }));
  var body = rowsDef.map(function (r) {
    return h('tr', null, h('td', null, r[0]), keys.map(function (k, i) { var v = num(obj(bu[k])[r[1]]); return h('td', { class: 'num' + (best[i] ? ' best' : '') }, v != null ? r[2](v) : '-'); }));
  });
  return h('div', null, h('p', { class: 'lbl' }, 'Units compared'), h('div', { class: 'tscroll' }, h('table', { class: 't' }, h('thead', null, head), h('tbody', null, body))),
    h('p', { class: 'cap' }, 'Read from the stored screen. Sales, cost and profit are at the ask; blank where the comps were too thin to price.'));
}
var SRC_NAME = { austin_gis_zoning: 'City of Austin GIS', tcad_parcel_shape: 'TCAD parcel shape', agent_sent: 'agent sent', listing: 'MLS listing' };
function recordBlock(d) {
  var f = obj(d.facts), s = obj(d.screen), items = [];
  [['Zoning from', 'zoning_source'], ['Lot size from', 'lot_source']].forEach(function (p) { var v = String(f[p[1]] || '').trim(); if (v && v !== 'not_found') items.push([p[0], SRC_NAME[v] || v.replace(/_/g, ' ')]); });
  if (String(f.tcad_prop_id || '').trim()) items.push(['TCAD parcel', String(f.tcad_prop_id)]);
  if (num(f.geocode_score) != null) items.push(['Geocode score', String(f.geocode_score)]);
  if (fmtDate(s.screened_at)) items.push(['Screened', fmtDate(s.screened_at)]);
  if (f.alerted_at) items.push(['Alert emailed', fmtCT(f.alerted_at)]);
  if (!items.length) return null;
  return h('div', null, h('p', { class: 'lbl' }, 'Record'), h('dl', { class: 'rec' }, items.map(function (i) { return h('div', null, h('dt', null, i[0]), h('dd', null, i[1])); })));
}
function warnReasons(d) {
  var s = obj(d.screen), out = [];
  arr(s.warnings).filter(function (w) { return String(w).trim(); }).forEach(function (w) { out.push(h('p', { class: 'warn1' }, cap1(w))); });
  var reasons = arr(s.reasons).filter(function (r) { return String(r).trim(); });
  if (reasons.length) out.push(h('div', null, h('p', { class: 'lbl' }, 'Why'), h('ul', { class: 'why' }, reasons.map(function (r) { return h('li', null, cap1(r)); }))));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the actions: state of one button, the sheets, and the one place a row is inserted
function pendingText(a) {
  var online = workerState().online;
  if (a.status === 'running') return 'Working on it now.';
  return isSoon(a.kind) ? 'Queued for the desk · coming soon' : (online ? 'Queued for the desk. It starts within seconds.' : 'Queued for the desk. It runs on the next pass, or the moment the desk worker is started.');
}
function actState(a) {
  // -> {s, sub}: the status word the button carries and the line under its label
  if (!a) return null;
  var r = obj(a.result), msg = String(r.message || '').trim();
  if (a.status === 'queued') return { s: 'queued', sub: isSoon(a.kind) ? 'Queued for the desk · coming soon' : 'Queued for the desk' };
  if (a.status === 'running') return { s: 'running', sub: 'Working on it...' };
  if (a.status === 'done') return { s: 'done', sub: 'Ready · ' + rel(a.finished_at) };
  if (a.status === 'unsupported') return { s: 'unsupported', sub: 'Coming soon · your request is saved' };
  if (a.status === 'failed') return { s: 'failed', sub: msg ? msg : 'It did not work. Tap to try again.' };
  return null;
}

var inFlight = {};
async function requestAction(kind, dealId, params, opts) {
  opts = opts || {};
  var key = kind + '|' + (dealId || '') + '|' + JSON.stringify(params || {});
  if (inFlight[key]) return null;
  inFlight[key] = true;
  try {
    var r = await tbl('actions').insert({ deal_id: dealId || null, kind: kind, params: params || {} }).select('id,deal_id,kind,params,status,result,requested_by,requested_at,started_at,finished_at').single();
    if (r.error) {
      if (r.error.code === '23505') { toast('That request is already queued.'); return null; }
      if (r.error.code === '42501') { toast('Your role cannot do that. It needs the owner role.', 'bad'); return null; }
      toast(explain(r.error), 'bad'); return null;
    }
    indexActions([r.data].concat(S.actions));
    var online = workerState().online, soon = isSoon(kind);
    var base = opts.toast || (soon ? 'Queued for the desk · coming soon' : 'Queued for the desk.' + (online ? ' It starts within seconds.' : ''));
    toast(base + (!soon && !online ? ' The desk worker is not running right now, so it happens on the next pass.' : ''));
    render();
    refreshSoon();
    return r.data;
  } catch (e) {
    toast(explain(e), 'bad'); return null;
  } finally { setTimeout(function () { delete inFlight[key]; }, 1500); }
}
function ownerGate(kind) {
  if (OWNER_ONLY[kind] && S.member && S.member.role !== 'owner') { toast('This needs the owner role. Ask your admin.', 'bad'); return false; }
  return true;
}

function confirmSheet(o) {
  // o: {title, intro: Node[], confirmLabel, hold: bool, onConfirm}
  var sheet;
  var go = o.hold ? holdButton(o.confirmLabel, 1000, function () { sheet.close(); o.onConfirm(); })
                  : h('button', { class: 'btn primary block', type: 'button', onclick: function () { sheet.close(); o.onConfirm(); } }, o.confirmLabel);
  sheet = openSheet({ title: o.title, body: o.intro, footer: [o.hold ? h('p', { class: 'fine' }, 'Press and hold for one second to confirm.') : null, go, h('button', { class: 'btn quiet block', type: 'button', onclick: function () { sheet.close(); } }, 'Cancel')] });
  return sheet;
}
function soonSheet(kind, d, label) {
  var text = soonText(kind) || 'This is coming soon.';
  var sheet = openSheet({
    title: label, body: [h('p', { class: 'msg warn' }, 'Not live yet. Your request is saved.'), h('p', null, text), d ? h('p', { class: 'muted' }, 'For ' + titleOf(d) + '.') : null,
      h('p', { class: 'fine' }, 'The desk keeps your request. When this goes live, press the button again to run it.')],
    footer: [h('button', { class: 'btn primary block', type: 'button', onclick: async function () { sheet.close(); if (ownerGate(kind)) await requestAction(kind, d ? d.id : null, {}); } }, 'Save my request'),
             h('button', { class: 'btn quiet block', type: 'button', onclick: function () { sheet.close(); } }, 'Not now')]
  });
}

function offerSheet(d) {
  var s = obj(d.screen), prev = obj(obj(d.facts).offer), max = num(s.max_price_for_600k), ask = num(d.ask_price);
  var offerCfg = obj(S.settings.offer), terms = obj(offerCfg.terms), unset = offerCfg.unset || '[set in packs/offer.yaml]';
  var termKeys = arr(offerCfg.order).filter(function (k) { return terms[k]; });
  if (!termKeys.length) termKeys = Object.keys(terms);
  var maxR = max != null && max > 0 ? Math.round(max / 1000) * 1000 : null;       // the same nearest-$1,000 the Surface note and the replies quote
  var price = h('input', { class: 'price', id: 'offer-price', type: 'text', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Offer price', value: (num(prev.price) || maxR) ? NF.format(num(prev.price) || maxR) : '' });
  var warn = h('p', { class: 'warn1', hidden: true }, 'This is above the max purchase price.');
  function parsed() { var v = num(String(price.value).replace(/[^0-9.]/g, '')); return v; }
  price.addEventListener('input', function () { var v = parsed(); warn.hidden = !(v != null && maxR != null && v > maxR); });
  var fields = {}, termEls = [];
  termKeys.forEach(function (key) {
    var t = obj(terms[key]), opts = arr(t.options), isSet = t.owner_to_set === false, el;
    var prefill = isSet && t.value != null ? String(t.value) : (prev.terms && prev.terms[key] != null ? String(prev.terms[key]) : '');
    if (t.unit === 'choice') {
      var labels = obj(t.option_labels);
      el = h('select', { id: 'offer-' + key }, h('option', { value: '' }, isSet ? 'Use the pack value' : 'Not set'), opts.map(function (o) { return h('option', { value: String(o), selected: prefill === String(o) }, labels[o] || String(o)); }));
    } else {
      var dl = 'offer-list-' + key;
      el = h('input', { id: 'offer-' + key, type: 'text', inputmode: 'numeric', autocomplete: 'off', list: dl, placeholder: isSet ? '' : 'Not set', value: prefill ? NF.format(Number(prefill)) : '' });
      termEls.push(h('datalist', { id: dl }, opts.map(function (o) { return h('option', { value: NF.format(Number(o)) }); })));
    }
    fields[key] = { el: el, unit: t.unit };
    termEls.push(h('label', null, (t.label || key) + (t.unit === 'days' ? ' (days)' : t.unit === 'usd' ? ' ($)' : ''), el, !isSet ? h('span', { class: 'fine' }, 'Not set in packs/offer.yaml yet. Leave it empty and the draft says ' + unset + '. Or pick a value for this offer.') : null));
  });
  var to = d.agent_email ? 'To: ' + (d.agent_name ? d.agent_name + ' ' : '') + d.agent_email : null;
  var sheet = openSheet({
    title: 'Make an offer · ' + titleOf(d),
    body: [
      h('div', { class: 'stack' },
        maxR != null ? h('p', null, h('span', { class: 'lbl' }, 'Max purchase price'), h('br'), h('b', null, usd(maxR)), h('span', { class: 'muted' }, ' · ' + bindingCaption(s).replace('seller-facing · ', ''))) : h('p', { class: 'muted' }, 'No max purchase price from the screen.'),
        ask != null ? h('p', { class: 'muted' }, 'Their ask: ' + usd(ask)) : null),
      h('label', null, 'Your offer price', price), warn,
      termEls,
      to ? h('p', { class: 'muted' }, to) : h('p', { class: 'warn1' }, 'No agent email on file. The draft will have no recipient. Add the address in Gmail before you approve the send.'),
      h('p', { class: 'fine' }, 'This makes a Gmail draft for you to read. Nothing is sent until you press Approve & send.')
    ],
    footer: [h('button', { class: 'btn primary block', type: 'button', id: 'offer-go', onclick: async function () {
      var p = parsed();
      if (p == null || p <= 0) { toast('Enter an offer price.', 'bad'); price.focus(); return; }
      var tp = {};
      Object.keys(fields).forEach(function (k) { var v = String(fields[k].el.value || '').trim(); if (v) tp[k] = fields[k].unit === 'choice' ? v : String(v).replace(/[^0-9.]/g, ''); });
      sheet.close();
      if (!ownerGate('offer')) return;
      await requestAction('offer', d.id, { price: Math.round(p), terms: tp }, { toast: 'Queued. The Gmail draft appears here in a moment.' });
    } }, 'Queue the offer draft'), h('button', { class: 'btn quiet block', type: 'button', onclick: function () { sheet.close(); } }, 'Cancel')]
  });
  price.dispatchEvent(new Event('input'));
}

function approveSheet(d) {
  var offer = obj(obj(d.facts).offer), bullets = arr(d.reply_bullets).filter(function (b) { return String(b).trim(); });
  var draft = String(d.reply_draft_id || '').trim();
  var body = [h('p', null, 'This sends the Gmail draft for ', h('b', null, titleOf(d)), ' now. You cannot take it back.')];
  body.push(d.agent_email ? h('p', null, 'To: ', h('b', null, (d.agent_name ? d.agent_name + ' ' : '') + d.agent_email)) : h('p', { class: 'warn1' }, 'No agent email on file. If the Gmail draft has no recipient the desk will refuse and tell you.'));
  if (offer.draft_id && offer.draft_id === draft) {
    body.push(h('p', { class: 'lbl' }, 'Offer draft'));
    if (offer.subject) body.push(h('p', null, h('b', null, offer.subject)));
    body.push(offer.body ? h('div', { class: 'email' }, offer.body) : h('p', null, 'Offer at ' + usd(offer.price) + '.'));
    if (arr(offer.unset).length) body.push(h('p', { class: 'warn1' }, 'These terms are not set yet and read "[set in packs/offer.yaml]" in the draft: ' + arr(offer.unset).join(', ') + '. Edit the draft in Gmail first if you want them filled in.'));
  } else if (bullets.length) {
    body.push(h('p', { class: 'lbl' }, 'The reply'), h('div', { class: 'outcome' }, h('blockquote', null, h('ul', null, bullets.map(function (b) { return h('li', null, String(b)); })))));
  }
  body.push(draftLink(draft), h('p', { class: 'fine' }, 'The desk sends it on its next look at the queue, then shows Sent here.'));
  confirmSheet({ title: 'Approve & send', intro: body, confirmLabel: 'Hold to send', hold: true, onConfirm: async function () {
    if (!ownerGate('approve_send')) return;
    await requestAction('approve_send', d.id, { draft_id: draft }, { toast: 'Approved. The desk sends it on its next look.' });
  } });
}

function noteSheet(d) {
  var text = h('textarea', { id: 'note-text', maxlength: '1000', placeholder: 'What should the desk remember about this deal?', 'aria-label': 'Note' });
  var sheet = openSheet({ title: 'Add a note · ' + titleOf(d), body: [h('label', null, 'Note', text)],
    footer: [h('button', { class: 'btn primary block', type: 'button', onclick: async function () {
      var v = text.value.trim(); if (!v) { toast('Write a note first.', 'bad'); text.focus(); return; }
      sheet.close(); await requestAction('note', d.id, { text: v }, { toast: 'Note saved.' });
    } }, 'Save note'), h('button', { class: 'btn quiet block', type: 'button', onclick: function () { sheet.close(); } }, 'Cancel')] });
}
function rfqSheet(d) {
  var sel = h('select', { id: 'rfq-role' }, RFQ_ROLES.map(function (r) { return h('option', { value: r }, cap1(r)); }));
  var sheet = openSheet({ title: 'Vendor RFQ · ' + titleOf(d), body: [h('p', null, 'A short brief for one trade, with the lot facts. No pricing, no ask, no profit, no agent details.'), h('label', null, 'Who is it for?', sel)],
    footer: [h('button', { class: 'btn primary block', type: 'button', onclick: async function () { var role = sel.value; sheet.close(); if (ownerGate('make_rfq')) await requestAction('make_rfq', d.id, { role: role }); } }, 'Make the RFQ'),
             h('button', { class: 'btn quiet block', type: 'button', onclick: function () { sheet.close(); } }, 'Cancel')] });
}
function uwSheet(d, again) {
  confirmSheet({ title: 'UW copy · ' + titleOf(d), intro: [h('p', null, 'Makes a private copy of the Origin Underwriting Master Template in your Drive and fills in the inputs and the closed comps for this deal.'),
    h('p', { class: 'muted' }, 'It never changes the master. The copy takes a minute.')], confirmLabel: again ? 'Make another copy' : 'Make the copy', onConfirm: async function () { if (ownerGate('make_uw_copy')) await requestAction('make_uw_copy', d.id, again ? { new_copy: true } : {}); } });
}

// show what a finished action made
async function openArtifact(art) {
  var sheet = openSheet({ title: art.title || art.name || 'Document', full: true, body: [h('p', { class: 'muted' }, 'Opening...')] });
  try {
    var row = S.artifacts.get(art.id);
    if (!row) { row = await q(tbl('artifacts').select('id,name,content_type,body').eq('id', art.id).single()); S.artifacts.set(art.id, row); }
    var frame = h('iframe', { class: 'doc', title: art.title || row.name, sandbox: '' });
    frame.srcdoc = String(row.body);                         // sandboxed with no permissions: no scripts, no access to this page
    var blob = new Blob([row.body], { type: 'text/html' }), url = URL.createObjectURL(blob);
    var save = h('a', { class: 'btn sm', href: url, download: row.name || 'document.html' }, 'Download .html');
    clear(sheet.body); sheet.body.classList.add('doc');
    sheet.body.appendChild(h('div', { class: 'links bar1' }, save));
    sheet.body.appendChild(frame);
  } catch (e) { clear(sheet.body); sheet.body.appendChild(h('p', { class: 'msg bad' }, explain(e))); }
}
function resultSheet(a, d) {
  var r = obj(a.result), body = [h('p', null, r.message || 'Done.')];
  arr(r.links).forEach(function (l) { var u = safeUrl(l.url); if (u) body.push(h('a', { class: 'btn primary block', href: u, target: '_blank', rel: 'noopener noreferrer' }, (l.label || 'Open') + ' ↗')); });
  arr(r.artifacts).forEach(function (art) { body.push(h('button', { class: 'btn primary block', type: 'button', onclick: function () { openArtifact(art); } }, 'Open ' + (art.title || art.name))); });
  if (r.draft_id) body.push(draftLink(r.draft_id));
  openSheet({ title: (KIND_LABEL[a.kind] || a.kind) + (d ? ' · ' + titleOf(d) : ''), body: body });
}

// the whole set of buttons for one deal
function actionTile(d, o) {
  // o: {kind, label, hint, cls, tap}
  var a = latest(d.id, o.kind), st = actState(a);
  var sub = st ? st.sub : o.hint;
  var btn = h('button', { class: 'act' + (o.cls ? ' ' + o.cls : ''), type: 'button', 'data-kind': o.kind, 'data-s': st ? st.s : null, 'aria-disabled': o.disabled ? 'true' : null,
    onclick: function () { o.tap(a); } }, h('b', null, o.label), h('small', null, sub));
  return btn;
}
function docTap(d, kind, sheetFn) {
  return function (a) {
    if (a && a.status === 'done') {
      var r = obj(a.result);
      if (arr(r.artifacts).length === 1 && !arr(r.links).length) return openArtifact(r.artifacts[0]);
      return resultSheet(a, d);
    }
    if (a && (a.status === 'queued' || a.status === 'running')) return toast(pendingText(a));
    if (!ownerGate(kind)) return;
    if (a && a.status === 'unsupported') return soonSheet(kind, d, KIND_LABEL[kind]);
    if (sheetFn) return sheetFn();
    return requestAction(kind, d.id, {});
  };
}

function actionPanel(d, compact) {
  var fin = replied(d), held = d.status === 'held' || d.status === 'passed';
  var offerA = latest(d.id, 'offer'), sendA = latest(d.id, 'approve_send');
  var offer = obj(obj(d.facts).offer);

  // 1  the two decisions that matter
  var sendSub = fin ? (d.status === 'sent' ? 'Sent ' + (fmtCT(d.sent_at) || '') : 'Bounced') :
    (sendA && (sendA.status === 'queued' || sendA.status === 'running')) ? (sendA.status === 'running' ? 'Sending...' : 'Send queued') :
    (sendA && sendA.status === 'failed' && Date.now() - parseDate(sendA.requested_at) < 6 * 3600e3) ? obj(sendA.result).message || 'It did not send.' :
    canSendDraft(d) ? 'Sends the Gmail draft' : 'No draft yet. Make an offer first.';
  var send = h('button', { class: 'act okk', type: 'button', 'data-kind': 'approve_send', 'data-s': sendA && !fin ? sendA.status : null, 'aria-disabled': canSendDraft(d) ? null : 'true',
    onclick: function () {
      if (fin) return toast('This deal is already replied (' + d.status + ').');
      if (sendA && (sendA.status === 'queued' || sendA.status === 'running')) return toast(pendingText(sendA));
      if (!canSendDraft(d)) return toast('There is no Gmail draft on this deal yet. Make an offer, and the desk makes one for you to read.');
      if (!ownerGate('approve_send')) return;
      approveSheet(d);
    } }, h('b', null, 'Approve & send'), h('small', null, sendSub));
  var offerSub = fin ? 'Already replied' : (offerA && (offerA.status === 'queued' || offerA.status === 'running')) ? (offerA.status === 'running' ? 'Making the draft...' : 'Queued · the draft is coming') :
    (offerA && offerA.status === 'failed' && Date.now() - parseDate(offerA.requested_at) < 6 * 3600e3) ? obj(offerA.result).message || 'It did not work.' :
    (offer.draft_id && offer.draft_id === d.reply_draft_id) ? 'Draft ready · ' + usd(offer.price) + ' · tap to revise' :
    (num(obj(d.screen).max_price_for_600k) > 0 ? 'Drafts at up to ' + usdK(obj(d.screen).max_price_for_600k) : 'Pick a price, get a draft');
  var offerBtn = h('button', { class: 'act primary', type: 'button', 'data-kind': 'offer', 'data-s': offerA && !fin ? offerA.status : null,
    onclick: function () {
      if (fin) return toast('This deal is already replied. Make the offer from Gmail.');
      if (offerA && (offerA.status === 'queued' || offerA.status === 'running')) return toast(pendingText(offerA));
      if (!ownerGate('offer')) return;
      offerSheet(d);
    } }, h('b', null, 'Make an offer'), h('small', null, offerSub));

  // 2  hold / pass / reopen / note
  var small = [];
  function quick(kind, label, hint) {
    var a = latest(d.id, kind), st = actState(a);
    small.push(h('button', { class: 'act', type: 'button', 'data-kind': kind, 'data-s': st && (st.s === 'queued' || st.s === 'running') ? st.s : null,
      onclick: function () {
        if (a && (a.status === 'queued' || a.status === 'running')) return toast(pendingText(a));
        if (kind === 'note') return noteSheet(d);
        if (fin) return toast('This deal is already replied (' + d.status + ').');
        requestAction(kind, d.id, {}, { toast: kind === 'hold' ? 'Putting it on hold.' : kind === 'pass' ? 'Passing on it.' : 'Reopening.' });
      } }, h('b', null, label), h('small', null, st && (st.s === 'queued' || st.s === 'running') ? st.sub : hint)));
  }
  if (held) { quick('reopen', 'Reopen', 'Back in the queue'); quick('note', 'Note', 'Write it down'); }
  else { quick('hold', 'Hold', 'Set it aside'); quick('pass', 'Pass', 'Not for us'); quick('note', 'Note', 'Write it down'); }

  // 3  the rest of the tools
  var tools = [
    { kind: 'make_dossier', label: 'Dossier', hint: 'The full deal file', tap: docTap(d, 'make_dossier') },
    { kind: 'make_lender_packet', label: 'Lender packet', hint: 'Loan request, sources and uses', tap: docTap(d, 'make_lender_packet') },
    { kind: 'make_rfq', label: 'Vendor RFQ', hint: 'Brief for a trade', tap: docTap(d, 'make_rfq', function () { rfqSheet(d); }) },
    { kind: 'make_permit_intake', label: 'Permit intake', hint: 'The 60-day path', tap: docTap(d, 'make_permit_intake') },
    { kind: 'make_uw_copy', label: 'UW copy', hint: uwUrls(d).length ? 'Open the copy, or make another' : 'Origin sheet, filled in',
      tap: function (a) {
        var existing = uwUrls(d);
        if (a && a.status === 'done') return resultSheet(a, d);
        if (a && (a.status === 'queued' || a.status === 'running')) return toast(pendingText(a));
        if (existing.length && !a) return openSheet({ title: 'UW copy · ' + titleOf(d), body: [h('p', null, 'This deal already has an underwriting copy.'), h('a', { class: 'btn primary block', href: existing[existing.length - 1], target: '_blank', rel: 'noopener noreferrer' }, 'Open the copy ↗'),
          h('button', { class: 'btn block', type: 'button', onclick: function () { sheetStack.forEach(function (s) { s.close(); }); if (ownerGate('make_uw_copy')) uwSheet(d, true); } }, 'Make another copy')] });
        if (!ownerGate('make_uw_copy')) return;
        uwSheet(d, existing.length > 0);
      } },
    { kind: 'rescreen', label: 'Re-screen · what if', hint: 'Change the ask, units or $/sf', tap: function (a) { if (a && (a.status === 'queued' || a.status === 'running')) return toast(pendingText(a)); soonSheet('rescreen', d, 'Re-screen · what if'); } },
    { kind: 'call_contact', label: 'Call this agent (AI)', hint: 'Coming soon', tap: function (a) { if (a && (a.status === 'queued')) return toast(pendingText(a)); soonSheet('call_contact', d, 'Call this agent (AI)'); } },
    { kind: 'email_contact', label: 'Email this agent', hint: 'Coming soon', tap: function (a) { if (a && (a.status === 'queued')) return toast(pendingText(a)); soonSheet('email_contact', d, 'Email this agent'); } },
    { kind: 'add_to_call_list', label: 'Add to call list', hint: 'Coming soon', tap: function (a) { if (a && (a.status === 'queued')) return toast(pendingText(a)); soonSheet('add_to_call_list', d, 'Add to call list'); } }
  ];
  var grid = h('div', { class: 'tiles' }, tools.map(function (t) { return actionTile(d, t); }));
  var panel = h('div', { class: 'acts', 'data-deal': d.id },
    h('h4', null, 'Decide'),
    h('div', { class: 'row2' }, send, offerBtn),
    h('div', { class: small.length === 3 ? 'row3' : 'row2' }, small),
    h('h4', null, 'Work this deal'),
    grid);
  return panel;
}

function timeline(d) {
  var list = (S.byDeal.get(d.id) || []).slice(0, 30);
  if (!list.length) return h('p', { class: 'empty' }, 'Nothing has been asked of the desk on this deal yet.');
  return h('ul', { class: 'hist' }, list.map(function (a) {
    var r = obj(a.result), st = a.status;
    var chipCls = st === 'done' ? 'ok' : st === 'failed' ? 'bad' : st === 'unsupported' ? 'warn' : 'accent';
    var word = st === 'unsupported' ? 'coming soon' : st === 'queued' ? 'queued' : st === 'running' ? 'working' : st;
    var extra = [];
    if (a.kind === 'note' && obj(a.params).text) extra.push(h('p', null, '"' + String(obj(a.params).text) + '"'));
    if (a.kind === 'offer' && num(obj(a.params).price)) extra.push(h('p', { class: 'muted' }, 'Price ' + usd(obj(a.params).price)));
    if (r.message) extra.push(h('p', { class: st === 'failed' ? 'down' : '' }, String(r.message)));
    var acts = [];
    arr(r.artifacts).forEach(function (art) { acts.push(h('button', { class: 'btn sm', type: 'button', onclick: function () { openArtifact(art); } }, 'Open ' + (art.title || art.name))); });
    arr(r.links).forEach(function (l) { var u = safeUrl(l.url); if (u) acts.push(h('a', { class: 'btn sm', href: u, target: '_blank', rel: 'noopener noreferrer' }, (l.label || 'Open') + ' ↗')); });
    if (r.draft_id) acts.push(draftLink(r.draft_id));
    return h('li', null, h('div', { class: 'line' }, h('b', null, KIND_LABEL[a.kind] || a.kind), chip(chipCls, word), h('span', { class: 'when' }, (a.requested_by || '').split('@')[0] + ' · ' + (fmtCT(a.requested_at) || ''))), extra, acts.length ? h('div', { class: 'links' }, acts) : null);
  }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the card
function summaryBody(d) {
  var kids = [factsBlock(d), compsInfo(d), gateChips(d), moneyBlock(d), warnReasons(d), outcomeBlock(d), linkRow(d)];
  return kids;
}
function dealCard(row, pin) {
  var ix = S.idx.get(row.id) || row, d = S.rows.get(row.id);
  var open = S.open.has(row.id);
  if (!d) {
    // the full row has not arrived yet: show what the light list knows
    return h('article', { class: 'card v-' + (row.verdict || 'none'), 'data-id': row.id },
      h('button', { class: 'head', type: 'button', onclick: function () { S.open.add(row.id); ensureRows([row.id]).then(render); render(); } },
        h('div', { class: 't1' }, h('h3', null, titleOf(row)), verdictChip(row.verdict)),
        h('div', { class: 'meta' }, h('span', null, 'Loading the details...'))));
  }
  var v = verdictOf(d), raw = S.raws.get(d.raw_id), received = raw && raw.received_at;
  var date = fmtDate(received || d.created_at);
  var src = sourceKey(d);
  var head = h('button', { class: 'head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onclick: function () { if (S.open.has(d.id)) S.open.delete(d.id); else S.open.add(d.id); render(); } },
    h('div', { class: 't1' }, h('h3', null, titleOf(d)), h('span', { class: 'chips' }, verdictChip(v), h('span', { class: 'chev' }, icon('chev')))),
    h('div', { class: 'meta' }, h('span', { class: 'src' }, SOURCE_LABEL[src] || 'Unknown source'), date ? h('span', null, (received ? 'received ' : 'added ') + date) : null, zip5(d.zip) ? h('span', { class: 'mono' }, zip5(d.zip)) : null),
    moneyLine(d),
    h('div', { class: 'chips' }, statusChips(d)));
  var card = h('article', { class: 'card v-' + (v || 'none') + (pin ? ' pin' : ''), id: 'd-' + d.id, 'data-id': d.id, 'data-open': open ? 'true' : 'false' }, head);
  if (open) {
    card.appendChild(h('div', { class: 'body' }, summaryBody(d), actionPanel(d, true), h('a', { class: 'btn block', href: '#/deal/' + d.id }, 'Open the full deal')));
  }
  return card;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// screens
function header() {
  var ws = workerState(), name = S.org && S.org.name ? S.org.name : '';
  return h('header', { class: 'top' }, h('div', { class: 'col' },
    h('a', { class: 'brand', href: '#/today', 'aria-label': 'Acquiro, home' }, h('b', null, 'Acquiro'), name ? h('span', null, name) : null),
    h('div', { class: 'tools' },
      h('a', { class: 'dot ' + ws.cls, href: '#/settings', title: ws.w ? 'Last seen ' + (fmtCT(ws.w.last_seen) || '') + ' on ' + ws.w.host : 'No desk worker has reported in yet' }, ws.label),
      h('button', { class: 'iconbtn', id: 'refresh', type: 'button', 'aria-label': 'Refresh', onclick: function () { refreshAll(); } }, icon('refresh')))));
}
function bottomBar() {
  var c = counts(), r = S.route.name;
  function item(href, ic, label, on, n) { return h('a', { href: href, 'aria-current': on ? 'page' : null }, icon(ic), label, n ? h('span', { class: 'n' }, n) : null); }
  return h('nav', { class: 'bar', 'aria-label': 'Main' }, h('div', { class: 'col' },
    item('#/today', 'today', 'Today', r === 'today', c.surface || 0),
    item('#/deals', 'deals', 'Deals', r === 'deals' || r === 'deal', 0),
    item('#/feed', 'feed', 'Feed', r === 'feed', 0),
    item('#/more', 'more', 'More', ['more', 'settings', 'buybox', 'runs', 'people', 'outreach'].indexOf(r) >= 0, 0)));
}
function shell(content) {
  var host = app();
  var main = h('main', { id: 'main', tabindex: '-1' }, h('div', { class: 'col' }, content));
  var y = window.scrollY;
  var focusId = document.activeElement && document.activeElement.id, selStart = null, selEnd = null;
  if (focusId && document.activeElement.selectionStart != null) { selStart = document.activeElement.selectionStart; selEnd = document.activeElement.selectionEnd; }
  clear(host); host.appendChild(header()); host.appendChild(main); host.appendChild(bottomBar());
  if (focusId) { var el = document.getElementById(focusId); if (el) { el.focus({ preventScroll: true }); if (selStart != null && el.setSelectionRange) { try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text input */ } } } }
  window.scrollTo(0, y);
}

function screenToday() {
  var c = counts(), kids = [h('h1', { class: 'h1' }, 'Today'), h('p', { class: 'sub' }, c.all + ' deals · ' + c.surface + ' Surface · ' + c.replied + ' replied' + (c.drafts ? ' · ' + c.drafts + ' draft' + (c.drafts === 1 ? '' : 's') + ' ready' : ''))];
  var run = S.actions.filter(function (a) { return a.status === 'queued' || a.status === 'running'; });
  var bad = S.actions.filter(function (a) { return a.status === 'failed' && Date.now() - parseDate(a.requested_at) < 3 * 86400e3; }).slice(0, 8);
  var ws = workerState();
  if (run.length && !ws.online) kids.push(h('p', { class: 'msg warn' }, run.length + ' request' + (run.length === 1 ? ' is' : 's are') + ' waiting for the desk. They run on the next pass, or the moment the desk worker is started.'));

  var top = todayDeals();
  kids.push(h('section', { class: 'sec' }, h('h2', null, 'Needs your yes', h('span', { class: 'k' }, c.surface + ' Surface')),
    top.length ? h('div', { class: 'stack' }, top.map(function (r) { return dealCard(r); })) : h('p', { class: 'empty' }, 'No Surface deals right now. The next one that clears the profit line lands here.'),
    c.surface > top.length ? h('p', null, h('a', { class: 'btn block', href: '#/deals/surface' }, 'See all ' + c.surface + ' Surface deals')) : null));

  var drafts = S.index.filter(function (d) { return canSendDraft(d) && tabOf(d) !== 'held' && !(S.idx.get(d.id) || {}).is_feed && verdictOf(d) !== 'surface'; }).slice(0, 5);
  if (drafts.length) kids.push(h('section', { class: 'sec' }, h('h2', null, 'Drafts ready to send', h('span', { class: 'k' }, drafts.length)), h('div', { class: 'stack' }, drafts.map(function (r) { return dealCard(r); }))));

  kids.push(h('section', { class: 'sec' }, h('h2', null, 'Running now', h('span', { class: 'k' }, run.length)),
    run.length ? actionList(run.slice(0, 10)) : h('p', { class: 'empty' }, 'Nothing is queued or running.')));
  if (bad.length) kids.push(h('section', { class: 'sec' }, h('h2', null, 'Needs attention', h('span', { class: 'k' }, bad.length)), actionList(bad)));
  kids.push(h('section', { class: 'sec' }, h('h2', null, 'Desk tools'), deskTools()));
  shell(kids);
}
function actionList(list) {
  return h('ul', { class: 'hist' }, list.map(function (a) {
    var d = S.idx.get(a.deal_id) || S.rows.get(a.deal_id), r = obj(a.result), st = a.status;
    var chipCls = st === 'done' ? 'ok' : st === 'failed' ? 'bad' : st === 'unsupported' ? 'warn' : 'accent';
    var word = st === 'unsupported' ? 'coming soon' : st === 'queued' ? (isSoon(a.kind) ? 'queued · coming soon' : 'queued') : st === 'running' ? 'working' : st;
    var acts = [];
    arr(r.artifacts).forEach(function (art) { acts.push(h('button', { class: 'btn sm', type: 'button', onclick: function () { openArtifact(art); } }, 'Open ' + (art.title || art.name))); });
    arr(r.links).forEach(function (l) { var u = safeUrl(l.url); if (u) acts.push(h('a', { class: 'btn sm', href: u, target: '_blank', rel: 'noopener noreferrer' }, (l.label || 'Open') + ' ↗')); });
    return h('li', null, h('div', { class: 'line' }, h('b', null, KIND_LABEL[a.kind] || a.kind), chip(chipCls, word), h('span', { class: 'when' }, rel(a.requested_at))),
      d ? h('a', { href: '#/deal/' + d.id }, titleOf(d)) : null, r.message ? h('p', { class: st === 'failed' ? 'down' : 'muted' }, String(r.message)) : null, acts.length ? h('div', { class: 'links' }, acts) : null);
  }));
}

function screenDeals() {
  var c = counts(), list = filtered();
  var tabs = [['surface', 'Surface'], ['pass', 'Pass'], ['replied', 'Replied'], ['feed', 'Feed'], ['held', 'Held'], ['all', 'All']];
  var bar = h('div', { class: 'filters' },
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter deals' }, tabs.map(function (t) {
      return h('button', { type: 'button', 'aria-pressed': S.tab === t[0] ? 'true' : 'false', onclick: function () { S.tab = t[0]; S.shown = PAGE; location.hash = '#/deals/' + t[0]; } }, t[1], h('span', { class: 'k' }, c[t[0]] != null ? c[t[0]] : 0));
    })));
  var search = h('input', { class: 'search', id: 'deal-search', type: 'search', placeholder: 'Search address, ZIP or agent', value: S.q, 'aria-label': 'Search deals', autocomplete: 'off', oninput: function (e) { S.q = e.target.value; S.shown = PAGE; ensureRows(visibleIds()).then(render); render(); } });
  var shown = list.slice(0, S.shown);
  var pinId = S.demo ? (inwood() || {}).id : null;
  var cards = shown.length ? h('div', { class: 'stack' }, shown.map(function (r) { return dealCard(r, r.id === pinId); })) : h('p', { class: 'empty' }, S.loadedOnce ? 'No deals here.' : 'Loading the deals...');
  var more = list.length > S.shown ? h('button', { class: 'btn block', type: 'button', onclick: function () { S.shown += PAGE; ensureRows(visibleIds()).then(render); render(); } }, 'Show ' + Math.min(PAGE, list.length - S.shown) + ' more · ' + (list.length - S.shown) + ' left') : null;
  shell([h('h1', { class: 'h1' }, 'Deals'), h('p', { class: 'sub' }, c.all + ' deals · ' + c.surface + ' Surface · ' + c.insufficient + ' insufficient · ' + c.replied + ' replied'), search, bar, h('div', { class: 'sec' }, cards, more)]);
}

function screenDeal() {
  var id = S.route.id, d = S.rows.get(id), ix = S.idx.get(id);
  if (!d) {
    shell([h('a', { class: 'back', href: '#/deals' }, icon('back'), 'Deals'), S.loadedOnce && !ix ? h('p', { class: 'empty' }, 'This deal is not in your workspace.') : h('p', { class: 'muted' }, 'Loading the deal...')]);
    return;
  }
  var v = verdictOf(d), s = obj(d.screen), profit = num(s.profit_per_lot), price = num(s.max_price_for_600k);
  var tabs = [['underwriting', 'Underwriting'], ['comps', 'Comps'], ['documents', 'Documents'], ['timeline', 'Timeline'], ['source', 'Source']];
  var tab = S.route.tab && tabs.some(function (t) { return t[0] === S.route.tab; }) ? S.route.tab : 'underwriting';
  var pane = h('div', { class: 'pane' });
  if (tab === 'underwriting') {
    summaryBody(d).forEach(function (x) { add(pane, x); });
    add(pane, unitsBlock(d)); add(pane, recordBlock(d));
    add(pane, h('p', { class: 'lbl' }, 'Actions')); add(pane, actionPanel(d));
  } else if (tab === 'comps') {
    add(pane, compsInfo(d)); var host = h('div'); add(pane, host); compsBlock(d, host); add(pane, unitsBlock(d));
  } else if (tab === 'documents') {
    add(pane, documentsPane(d));
  } else if (tab === 'timeline') {
    add(pane, timeline(d));
  } else {
    sourcePane(d, pane);
  }
  var head = h('div', { class: 'dhead' }, h('a', { class: 'back', href: '#/deals' }, icon('back'), 'Deals'),
    h('div', { class: 't1' }, h('h1', null, titleOf(d)), verdictChip(v)),
    profit != null || price != null ? h('div', { class: 'money1' }, profit != null ? h('span', { class: 'big' + (profit < 0 ? ' neg' : '') }, usdK(profit), h('span', { class: 'small' }, ' profit/lot')) : null, price > 0 ? h('span', { class: 'small' }, 'max ', h('b', null, usdK(price))) : null) : null,
    h('div', { class: 'chips' }, statusChips(d)),
    h('div', { class: 'dtabs', role: 'tablist' }, tabs.map(function (t) { return h('button', { type: 'button', role: 'tab', 'aria-selected': t[0] === tab ? 'true' : 'false', onclick: function () { location.hash = '#/deal/' + id + '/' + t[0]; } }, t[1]); })));
  shell([head, pane]);
}
function documentsPane(d) {
  var kids = [h('p', { class: 'muted' }, 'Everything the desk has made for this deal. To make a fresh one, use the buttons at the bottom.')];
  var docs = (S.byDeal.get(d.id) || []).filter(function (a) { return a.status === 'done' && (arr(obj(a.result).artifacts).length || arr(obj(a.result).links).length); });
  var uw = uwUrls(d);
  if (uw.length) kids.push(h('div', null, h('p', { class: 'lbl' }, 'Underwriting copies'), h('div', { class: 'links' }, uw.map(function (u, i) { return h('a', { class: 'btn sm', href: u, target: '_blank', rel: 'noopener noreferrer' }, 'UW copy ' + (i + 1) + ' ↗'); }))));
  if (docs.length) kids.push(h('div', null, h('p', { class: 'lbl' }, 'Documents'), h('ul', { class: 'hist' }, docs.map(function (a) {
    var r = obj(a.result);
    return h('li', null, h('div', { class: 'line' }, h('b', null, KIND_LABEL[a.kind] || a.kind), h('span', { class: 'when' }, fmtCT(a.finished_at || a.requested_at))),
      h('div', { class: 'links' }, arr(r.artifacts).map(function (art) { return h('button', { class: 'btn sm primary', type: 'button', onclick: function () { openArtifact(art); } }, 'Open ' + (art.title || art.name)); }),
        arr(r.links).map(function (l) { var u = safeUrl(l.url); return u ? h('a', { class: 'btn sm', href: u, target: '_blank', rel: 'noopener noreferrer' }, (l.label || 'Open') + ' ↗') : null; })));
  }))));
  else if (!uw.length) kids.push(h('p', { class: 'empty' }, 'No documents yet. Ask the desk for a dossier, a lender packet, an RFQ or a permit intake.'));
  var bullets = arr(d.reply_bullets).filter(function (b) { return String(b).trim(); });
  kids.push(h('div', null, h('p', { class: 'lbl' }, 'Reply'), outcomeBlock(d)));
  kids.push(actionPanel(d));
  return kids;
}
function sourcePane(d, pane) {
  var raw = S.raws.get(d.raw_id);
  add(pane, h('p', { class: 'lbl' }, 'The email'));
  var host = h('div', null, h('p', { class: 'muted' }, 'Loading the email...')); add(pane, host);
  if (d.raw_id) {
    q(tbl('deals_raw_redacted').select('id,subject,sender,received_at,source,body_text,attachment_names').eq('id', d.raw_id).maybeSingle()).then(function (r) {
      clear(host);
      if (!r) { host.appendChild(h('p', { class: 'empty' }, 'The email is not available.')); return; }
      host.appendChild(h('dl', { class: 'rec' }, [['From', r.sender || '-'], ['Received', fmtCT(r.received_at) || '-'], ['Subject', r.subject || '-'], ['Source', SOURCE_LABEL[r.source] || r.source || '-']].map(function (i) { return h('div', null, h('dt', null, i[0]), h('dd', null, i[1])); })));
      host.appendChild(h('div', { class: 'email' }, redact(r.body_text) || '(no text)'));
      var names = arr(r.attachment_names); if (names.length) host.appendChild(h('p', { class: 'cap' }, 'Attachments: ' + names.join(', ')));
      host.appendChild(h('p', { class: 'cap' }, 'Links in the email that carry a sign-in token are cut out of this copy.'));
    }).catch(function (e) { clear(host); host.appendChild(h('p', { class: 'msg bad' }, explain(e))); });
  } else host.replaceChildren(h('p', { class: 'empty' }, 'This deal has no stored email.'));
  [['The screen', d.screen], ['The facts', d.facts], ['Where each field came from', d.field_sources]].forEach(function (p) {
    var json = p[1] == null ? '(none)' : redact(JSON.stringify(typeof p[1] === 'string' ? obj(p[1]) : p[1], null, 2));
    add(pane, h('details', { class: 'more' }, h('summary', null, p[0]), h('div', null, h('pre', { class: 'json' }, json))));
  });
  add(pane, h('p', { class: 'fine' }, 'Deal ' + d.id));
}

function screenFeed() {
  var items = [];
  S.actions.slice(0, 80).forEach(function (a) { items.push({ t: a.requested_at, a: a }); });
  S.runs.forEach(function (r) { items.push({ t: r.finished_at || r.started_at, run: r }); });
  items.sort(function (x, y) { return String(y.t).localeCompare(String(x.t)); });
  var list = items.slice(0, 60).map(function (it) {
    if (it.a) return actionList([it.a]).firstChild;
    var r = it.run, errs = arr(r.errors);
    return h('li', null, h('div', { class: 'line' }, h('b', null, 'Pass'), chip(errs.length ? 'warn' : 'ok', errs.length ? errs.length + ' error' + (errs.length === 1 ? '' : 's') : 'clean'), h('span', { class: 'when' }, rel(it.t))),
      h('p', { class: 'muted' }, (r.raw_seen || 0) + ' seen · ' + (r.deals_new || 0) + ' new · ' + (r.surfaced || 0) + ' Surface · ' + (r.drafted || 0) + ' drafted'));
  });
  shell([h('h1', { class: 'h1' }, 'Feed'), h('p', { class: 'sub' }, 'Passes, and everything you asked the desk to do.'), list.length ? h('ul', { class: 'hist' }, list) : h('p', { class: 'empty' }, 'Nothing yet.')]);
}

function toolButton(kind, label, hint, sheetFn) {
  var a = S.actions.find(function (x) { return x.kind === kind && !x.deal_id; }), st = actState(a);
  return h('button', { class: 'act', type: 'button', 'data-kind': kind, 'data-s': st ? st.s : null, onclick: function () {
    if (a && (a.status === 'queued' || a.status === 'running')) return toast(pendingText(a));
    if (!ownerGate(kind)) return;
    if (isSoon(kind)) return soonSheet(kind, null, label);
    if (sheetFn) return sheetFn();
    requestAction(kind, null, {}, kind === 'ping' ? { toast: 'Asking the desk worker to answer.' } : undefined);
  } }, h('b', null, label), h('small', null, st ? (a.status === 'done' && obj(a.result).message ? obj(a.result).message : st.sub) : hint));
}
function deskTools() {
  return h('div', { class: 'tiles' },
    toolButton('run_pass', 'Run a pass', 'Passes run on the schedule'),
    toolButton('feed_pull', 'Pull the MLS feed', 'Coming soon'),
    toolButton('refresh_buybox', 'Refresh buy box', 'Coming soon'),
    toolButton('sync_close', 'Sync Close', 'Coming soon'),
    toolButton('ping', 'Test the desk', 'Checks the worker answers'),
    h('a', { class: 'act', href: '#/people' }, h('b', null, 'Call list'), h('small', null, 'Agents you asked to call')));
}
function screenMore() {
  shell([h('h1', { class: 'h1' }, 'More'),
    h('div', { class: 'stack' },
      h('a', { class: 'act', href: '#/settings' }, h('b', null, 'Settings'), h('small', null, 'Workspace, desk worker, offer terms, what is not live yet')),
      h('a', { class: 'act', href: '#/buybox' }, h('b', null, 'Buy box & packs'), h('small', null, 'The ZIPs and the numbers every screen uses (read only)')),
      h('a', { class: 'act', href: '#/runs' }, h('b', null, 'Runs'), h('small', null, 'Every pass: seen, new, errors')),
      h('a', { class: 'act', href: '#/people' }, h('b', null, 'People & call list'), h('small', null, 'Agents you asked to call')),
      h('a', { class: 'act', href: '#/outreach' }, h('b', null, 'Outreach'), h('small', null, 'Emails, texts and AI calls (coming soon)'))),
    h('section', { class: 'sec' }, h('h2', null, 'Desk tools'), deskTools())]);
}
function screenSettings() {
  var ws = workerState(), pack = obj(S.settings.pack), offer = obj(S.settings.offer), terms = obj(offer.terms), soon = obj(obj(S.settings.actions).soon);
  var kv = function (rows) { return h('dl', { class: 'rec' }, rows.map(function (r) { return h('div', null, h('dt', null, r[0]), h('dd', null, r[1])); })); };
  var counts1 = {}; S.actions.forEach(function (a) { counts1[a.kind] = (counts1[a.kind] || 0) + 1; });
  shell([h('a', { class: 'back', href: '#/more' }, icon('back'), 'More'), h('h1', { class: 'h1' }, 'Settings'),
    h('section', { class: 'sec' }, h('h2', null, 'Workspace'), kv([['Name', S.org ? S.org.name : '-'], ['You', S.email], ['Role', S.member ? S.member.role : '-']]),
      h('p', null, h('button', { class: 'btn block', type: 'button', onclick: signOut }, 'Sign out'))),
    h('section', { class: 'sec' }, h('h2', null, 'Desk worker'),
      ws.w ? kv([['Status', ws.label], ['Host', ws.w.host || '-'], ['Revision', ws.w.git_rev || '-'], ['Last seen', fmtCT(ws.w.last_seen) || '-'], ['Last pass', ws.w.last_pass ? fmtCT(ws.w.last_pass) : 'none yet'], ['Surface alerts', ws.w.alerts_on ? 'on' : 'off']])
        : h('p', { class: 'empty' }, 'No desk worker has reported in. Start one with python -m acquiro.actions --watch, or run a pass.'),
      h('div', { class: 'stack' }, toolButton('ping', 'Test the desk', 'Checks the worker answers'))),
    h('section', { class: 'sec' }, h('h2', null, 'Offer terms'), Object.keys(terms).length ? h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'These come from packs/offer.yaml. A term that is not set yet shows as "' + (offer.unset || '[set in packs/offer.yaml]') + '" in the Gmail draft.'),
      h('div', { class: 'tscroll' }, h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', null, 'Term'), h('th', null, 'Placeholder'), h('th', null, 'Status'))),
        h('tbody', null, (arr(offer.order).length ? offer.order : Object.keys(terms)).map(function (k) { var t = obj(terms[k]); return h('tr', null, h('td', null, t.label || k), h('td', null, String(t.value == null ? '-' : t.value)), h('td', null, t.owner_to_set === false ? chip('ok', 'set') : chip('warn', 'not set yet'))); }))))) : h('p', { class: 'empty' }, 'The offer terms have not been published yet. They appear after the first pass or desk worker run.')),
    h('section', { class: 'sec' }, h('h2', null, 'Not live yet'), Object.keys(soon).length ? h('ul', { class: 'hist' }, Object.keys(soon).map(function (k) {
      return h('li', null, h('div', { class: 'line' }, h('b', null, KIND_LABEL[k] || k), chip('warn', 'coming soon'), counts1[k] ? h('span', { class: 'when' }, counts1[k] + ' request' + (counts1[k] === 1 ? '' : 's')) : null), h('p', { class: 'muted' }, soon[k]));
    })) : h('p', { class: 'empty' }, 'Nothing listed.')),
    h('section', { class: 'sec' }, h('h2', null, 'Pack numbers'), Object.keys(pack).length ? kv(packRows(pack)) : h('p', { class: 'empty' }, 'Not published yet.'))]);
}
function packRows(pack) {
  var rows = [];
  if (num(pack.target_profit_per_lot)) rows.push(['Profit target', usd(pack.target_profit_per_lot) + ' per lot']);
  if (num(pack.min_margin_on_cost)) rows.push(['Minimum margin', Math.round(pack.min_margin_on_cost * 100) + '% on all-in cost']);
  if (arr(pack.zips).length) rows.push(['We buy in', pack.zips.join(', ')]);
  if (arr(pack.watch_zips).length) rows.push(['Watch list', pack.watch_zips.join(', ')]);
  if (num(pack.min_buildable_sf)) rows.push(['Buildable', NF.format(pack.min_buildable_sf) + '+ sf']);
  if (num(pack.min_median_psf)) rows.push(['Comps floor', '$' + NF.format(pack.min_median_psf) + '/sf']);
  if (num(pack.g1_min_comps)) rows.push(['Minimum comps', String(pack.g1_min_comps)]);
  return rows;
}
function screenBuybox() {
  var pack = obj(S.settings.pack);
  shell([h('a', { class: 'back', href: '#/more' }, icon('back'), 'More'), h('h1', { class: 'h1' }, 'Buy box & packs'), h('p', { class: 'sub' }, 'Read only. The screen reads these from packs/lot.yaml.'),
    Object.keys(pack).length ? h('dl', { class: 'rec' }, packRows(pack).map(function (r) { return h('div', null, h('dt', null, r[0]), h('dd', null, r[1])); })) : h('p', { class: 'empty' }, 'Not published yet.'),
    h('section', { class: 'sec' }, h('h2', null, 'Change the buy box'), h('p', { class: 'muted' }, 'Proposing and applying changes from the desk is coming soon. scripts/buybox_refresh.py proposes them monthly and you approve.'),
      h('div', { class: 'stack' }, toolButton('refresh_buybox', 'Refresh buy box', 'Coming soon')))]);
}
function screenRuns() {
  shell([h('a', { class: 'back', href: '#/more' }, icon('back'), 'More'), h('h1', { class: 'h1' }, 'Runs'),
    S.runs.length ? h('div', { class: 'tscroll' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['When', 'Mode', 'Seen', 'New', 'Surface', 'Errors'].map(function (x, i) { return h('th', { class: i > 1 ? 'num' : null }, x); }))),
      h('tbody', null, S.runs.map(function (r) { var e = arr(r.errors).length; return h('tr', null, h('td', null, fmtCT(r.started_at) || '-'), h('td', null, r.mode || '-'), h('td', { class: 'num' }, r.raw_seen || 0), h('td', { class: 'num' }, r.deals_new || 0), h('td', { class: 'num' }, r.surfaced || 0), h('td', { class: 'num' }, e ? chip('warn', String(e)) : '0')); })))) : h('p', { class: 'empty' }, 'No runs yet.')]);
}
function screenPeople() {
  var calls = S.actions.filter(function (a) { return a.kind === 'add_to_call_list' || a.kind === 'call_contact' || a.kind === 'email_contact'; });
  shell([h('a', { class: 'back', href: '#/more' }, icon('back'), 'More'), h('h1', { class: 'h1' }, 'People & call list'),
    h('p', { class: 'msg warn' }, 'Not live yet. Your requests are saved.'), h('p', { class: 'muted' }, soonText('add_to_call_list') || 'The call list is coming soon.'),
    h('section', { class: 'sec' }, h('h2', null, 'Requests so far', h('span', { class: 'k' }, calls.length)), calls.length ? actionList(calls.slice(0, 40)) : h('p', { class: 'empty' }, 'Open a deal and press Add to call list, Call this agent or Email this agent. They show up here.'))]);
}
function screenOutreach() {
  shell([h('a', { class: 'back', href: '#/more' }, icon('back'), 'More'), h('h1', { class: 'h1' }, 'Outreach'),
    h('p', { class: 'msg warn' }, 'Not live yet.'), h('p', null, 'Emails, texts and AI calls to agents will plan here first and send only after your approval. Texts and calls stay behind their own gates.'),
    h('p', { class: 'muted' }, 'Today the desk drafts reply emails in Gmail for you to send, and the Approve & send button on a deal sends one draft at a time.')]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// router and render
function parseRoute() {
  var hash = location.hash.replace(/^#\/?/, ''), parts = hash.split('/').filter(Boolean), name = parts[0] || '';
  if (!name) return S.demo ? { name: 'deals', tab: 'surface' } : { name: 'today' };
  if (name === 'deal' && parts[1]) return { name: 'deal', id: parts[1], tab: parts[2] };
  if (name === 'deals') return { name: 'deals', tab: parts[1] };
  if (['today', 'feed', 'more', 'settings', 'buybox', 'runs', 'people', 'outreach'].indexOf(name) >= 0) return { name: name };
  return { name: 'today' };
}
function onRoute() {
  if (!S.started) return;
  var prev = S.route.name + (S.route.id || '');
  S.route = parseRoute();
  if (S.route.name === 'deals' && S.route.tab && ['surface', 'pass', 'replied', 'feed', 'held', 'all'].indexOf(S.route.tab) >= 0) { if (S.tab !== S.route.tab) S.shown = PAGE; S.tab = S.route.tab; }
  document.body.classList.remove('locked');
  if (prev !== S.route.name + (S.route.id || '')) window.scrollTo(0, 0);
  ensureRows(visibleIds()).then(render).catch(function () { render(); });
  render();
}
function demoSetup() {
  if (!S.demo || S.demoDone || !S.loadedOnce) return;
  var i = inwood();
  if (!i) { S.demoDone = true; return; }
  S.demoDone = true;
  S.open.add(i.id);
  if (S.route.name === 'deals' && S.tab !== 'surface') S.tab = 'surface';
  setTimeout(function () { var el = document.getElementById('d-' + i.id); if (el) el.scrollIntoView({ block: 'start' }); }, 80);
}
function render() {
  if (!S.started) return;
  demoSetup();
  var r = S.route.name;
  try {
    if (r === 'today') screenToday();
    else if (r === 'deals') screenDeals();
    else if (r === 'deal') screenDeal();
    else if (r === 'feed') screenFeed();
    else if (r === 'more') screenMore();
    else if (r === 'settings') screenSettings();
    else if (r === 'buybox') screenBuybox();
    else if (r === 'runs') screenRuns();
    else if (r === 'people') screenPeople();
    else if (r === 'outreach') screenOutreach();
    else screenToday();
  } catch (e) {
    if (window.console) console.error(e);
    clear(app()).appendChild(h('div', { class: 'login' }, h('div', { class: 'box' }, h('div', { class: 'wm' }, 'Acquiro'), h('p', { class: 'msg bad' }, 'Something went wrong drawing this screen. ' + (e && e.message ? e.message : '')),
      h('button', { class: 'btn primary block', type: 'button', onclick: function () { location.hash = '#/today'; location.reload(); } }, 'Reload'))));
  }
}
window.addEventListener('hashchange', onRoute);

// ---------------------------------------------------------------------------------------------------------------------------------
// start
async function start(session) {
  if (S.started || S.starting) { S.session = session; return; }
  S.starting = true;
  S.session = session; S.email = String(session.user.email || '').toLowerCase();
  showSplash('Opening your desk');
  try {
    var m = await q(tbl('members').select('email,org_id,role').maybeSingle());
    if (!m) { S.starting = false; renderNoAccess(); return; }
    S.member = m;
    await loadOrg();
  } catch (e) {
    S.starting = false; fatal('Could not open the desk. ' + explain(e)); return;
  }
  S.started = true; S.starting = false;
  S.route = parseRoute();
  if (S.route.name === 'deals' && S.route.tab) S.tab = S.route.tab;
  render();
  await refreshAll();
  startLive();
  if (location.search) { try { history.replaceState(null, '', location.pathname + (S.demo ? '?demo=1' : '') + location.hash); } catch (e) { /* keep the URL */ } }
}

async function boot() {
  S.demo = new URLSearchParams(location.search).get('demo') === '1';
  showSplash();
  var problem = urlProblem();
  try { await loadSdk(); } catch (e) { fatal('The sign-in library did not load. Check your connection and try again.'); return; }
  S.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    db: { schema: 'acquiro' },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'acquiro-desk-auth' }
  });
  S.sb.auth.onAuthStateChange(function (event, session) {
    setTimeout(function () {
      if (event === 'SIGNED_OUT') { if (S.started) { stopLive(); S.started = false; } renderLogin(); }
      else if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) { if (!S.started) start(session); else S.session = session; }
    }, 0);
  });
  var r = await S.sb.auth.getSession();
  if (r.data && r.data.session) { await start(r.data.session); if (problem) toast(problem); return; }
  if (!S.started && !S.starting) renderLogin({ problem: problem });
}

boot();
})();
