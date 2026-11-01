/*
  PDS Contract 1161: phone notification sender (Cloudflare Worker)

  The app calls this with the signed in person's Firebase sign in token.
  This code checks who they are, decides who should get the notification,
  and sends it through Firebase Cloud Messaging using the "send only" key.

  Secret needed in Cloudflare (Settings, Variables and Secrets):
    SA_JSON  = the whole contents of the pds notify key file (type: Secret)

  Scheduled alerts: a Cron Trigger (every minute, "* * * * *") runs scheduled() below.
  It sends any alert in the schedalerts collection whose time has come. For this the key's
  service account also needs the "Cloud Datastore User" role in Google Cloud.

  No driver or customer details are stored here.
*/

const PROJECT = 'preston-deliveries';
const ORIGINS = ['https://preston-deliveries.github.io'];
const OWNERS = ['jozza721@gmail.com', 'jozza21@gmail.com'];
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

/* What each kind of notification is, who may send it, and who gets it */
const KINDS = {
  urgent:   { who: 'admin',  to: 'chosen' },   // Send a notification button on Home
  test:     { who: 'admin',  to: 'self'   },   // Check it works on my devices
  update:   { who: 'admin',  to: 'chosen' },   // a new update posted (everyone)
  enquiry:  { who: 'admin',  to: 'login',  title: 'New customer enquiry', body: 'There is a new customer enquiry about one of your deliveries. Tap to view.', url: '' },
  report:   { who: 'member', to: 'admins', title: 'New report', body: 'A driver has sent a report. Tap to view.', url: '#reports' },
  feedback: { who: 'member', to: 'admins', title: 'New feedback', body: 'A driver has sent feedback. Tap to view.', url: '#feedback' },
  uniform:  { who: 'member', to: 'admins', title: 'New uniform order', body: 'A driver has ordered uniform. Tap to view.', url: '#uniform' },
  leave:    { who: 'member', to: 'admins', title: 'Day off request', body: 'A driver has asked for time off. Tap to view.', url: '#leave' },
  invoice:  { who: 'member', to: 'admins', title: 'New invoice', body: 'A driver has submitted an invoice. Tap to view.', url: '#invoices' },
  clockon:  { who: 'member', to: 'admins', title: 'Clocked on', body: 'A driver has clocked on.', url: '#timesheets', notMe: true },
  clockoff: { who: 'member', to: 'admins', title: 'Clocked off', body: 'A driver has clocked off.', url: '#timesheets', notMe: true }
};
/* what each driver message says when we know who sent it (drivers can never write the words themselves) */
const WHO_SAYS = {
  report: n => n + ' has sent a report. Tap to view.',
  feedback: n => n + ' has sent feedback. Tap to view.',
  uniform: n => n + ' has ordered uniform. Tap to view.',
  leave: n => n + ' has asked for time off. Tap to view.',
  invoice: n => n + ' has submitted an invoice. Tap to view.'
};
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDay = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return ''; const d = new Date(s + 'T12:00:00Z'); return DN[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MN[d.getUTCMonth()]; };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runScheduled(env)); },
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin'
    };
    const out = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method === 'GET' && new URL(req.url).searchParams.has('check')) {
      /* runs the scheduled alert check now and says what happened (no message text is shown) */
      try { return out(await runScheduled(env)); } catch (e) { return out({ ok: false, error: String(e && e.message || e).slice(0, 300) }); }
    }
    if (req.method !== 'POST') return out({ ok: true, service: 'pds notify' });
    if (!ORIGINS.includes(origin)) return out({ error: 'Not allowed' }, 403);

    try {
      const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const me = await verifyIdToken(idToken);
      if (!me) return out({ error: 'Please sign in again' }, 401);

      const b = await req.json().catch(() => ({}));
      const K = KINDS[b.kind];
      if (!K) return out({ error: 'Unknown notification type' }, 400);

      /* who is sending */
      const acc = OWNERS.includes(me.email) ? null : await getDoc('access/' + encodeURIComponent(me.email), idToken).catch(() => null);
      const role = await roleOf(me.email, idToken);
      if (!role) return out({ error: 'No access' }, 403);
      if (K.who === 'admin' && role !== 'admin') return out({ error: 'Admins only' }, 403);

      /* the admin's settings: each type on or off, and quiet hours */
      const cfg = await getDoc('pushcfg/main', idToken).catch(() => null) || {};
      if (cfg.off && cfg.off.includes(b.kind)) return out({ ok: true, sent: 0, skipped: 'This type is switched off' });
      const safety = b.kind === 'urgent' && b.safety === true;
      /* quiet hours only hold back messages going to drivers; messages to the office always go straight away */
      if (!safety && b.kind !== 'test' && K.to !== 'admins' && inQuietHours(cfg)) return out({ ok: true, sent: 0, skipped: 'Quiet hours' });

      /* the message: drivers can never set the words themselves */
      const nm = clip(acc && acc.name, 40);
      let mb = K.body;
      if (nm && WHO_SAYS[b.kind]) mb = WHO_SAYS[b.kind](nm);
      if ((b.kind === 'clockon' || b.kind === 'clockoff') && /^\d{2}:\d{2}$/.test(String(b.t || ''))) {
        const [h, m] = b.t.split(':').map(Number); const tm = ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? 'am' : 'pm');
        mb = (nm || 'A driver') + (b.kind === 'clockon' ? ' clocked on at ' : ' clocked off at ') + tm + (niceDay(b.day) ? ' on ' + niceDay(b.day) : '') + '.';
      }
      if (b.kind === 'leave' && niceDay(b.from)) { const f = niceDay(b.from), t = niceDay(b.to); mb = (nm || 'A driver') + ' has asked for ' + (t && t !== f ? f + ' to ' + t : f) + ' off. Tap to view.'; }
      const msg = K.title ? { title: K.title, body: mb, url: K.url }
        : { title: clip(b.title, 60) || 'Preston Delivery Service', body: clip(b.body, 180), url: safeUrl(b.url) };
      if (!msg.body) return out({ error: 'Message is empty' }, 400);

      /* who gets it */
      let filter = null;
      if (K.to === 'admins') filter = eq('role', 'admin');
      else if (K.to === 'self') filter = eq('email', me.email);
      else if (K.to === 'staff') { if (!b.staff) return out({ error: 'Pick a driver' }, 400); filter = eq('staff', String(b.staff)); }
      else if (K.to === 'login') { if (!b.login) return out({ error: 'No driver' }, 400); filter = eq('login', String(b.login).toUpperCase()); }
      else if (K.to === 'chosen') {
        if (b.staff) filter = eq('staff', String(b.staff));
        else if (b.pc) filter = { fieldFilter: { field: { fieldPath: 'pcs' }, op: 'ARRAY_CONTAINS', value: { stringValue: String(b.pc) } } };
        else filter = null; // everyone
      }
      let phones = await findPhones(filter, idToken);
      if (K.notMe) phones = phones.filter(p => p.email !== me.email);
      if (!phones.length) return out({ ok: true, sent: 0, skipped: 'Nobody has notifications turned on yet' });

      /* send */
      /* send: the first batch now, any more phones over the next minute or two (Cloudflare's per run call limit) */
      const access = await googleAccess(env, 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging');
      const sent = await sendMany(phones.map(p => p.token), { title: msg.title, body: msg.body, url: msg.url || '', kind: b.kind }, access, budget(36));
      return out({ ok: true, sent, of: phones.length, later: Math.max(0, phones.length - sent) });
    } catch (e) {
      return out({ error: 'Could not send', detail: String(e && e.message || e).slice(0, 200) }, 500);
    }
  }
};


/* ---------- scheduled alerts ---------- */
const QLD = 10 * 3600e3; // Queensland is UTC+10 all year
function nextAt(a, after) {
  const [hh, mm] = String(a.time || '06:00').split(':').map(Number);
  const days = Array.isArray(a.days) ? a.days.map(Number) : [];
  if (!days.length) return null; // one off: nothing after it has been sent
  const q = new Date(after + QLD);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth(), q.getUTCDate() + i, hh, mm) - QLD);
    if (d.getTime() > after && days.includes(new Date(d.getTime() + QLD).getUTCDay())) return d.toISOString();
  }
  return null;
}
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
  return { stringValue: String(v) };
}
/* Cloudflare's free plan allows about 50 outside calls per run. Every call made while sending scheduled things is
   counted here, and anything that doesn't fit waits for the next minute's run instead of failing. */
const budget = n => ({ left: n });
const bf = (B, url, opts) => { if (B) { if (B.left <= 0) return Promise.reject(new Error('over budget')); B.left--; } return fetch(url, opts); };
async function fsPatch(path, obj, token, mask, mustExist, B) {
  /* mustExist: never create a document that was deleted in the meantime */
  const q = mask ? '?' + mask.map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&') + (mustExist ? '&currentDocument.exists=true' : '') : '';
  const r = await bf(B, `${FS}/${path}${q}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, toFs(x)])) }) });
  if (!r.ok) throw new Error('Could not save ' + path + ' (' + r.status + ')');
}
async function fsDelete(path, token, B) { const r = await bf(B, `${FS}/${path}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); return r.ok; }
const fcmBody = (tok, d) => JSON.stringify({ message: { token: tok, data: d, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } });
/* send one message to many phones. What doesn't fit in this run is saved and sent over the next minutes. Returns how many went now. */
async function sendMany(tokens, data, token, B) {
  const room = Math.max(0, (B ? B.left : 40) - 3);
  const now = tokens.slice(0, room), rest = tokens.slice(room);
  let ok = 0;
  await Promise.all(now.map(t => bf(B, `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: fcmBody(t, data) }).then(r => { if (r.ok) ok++; }).catch(() => null)));
  if (rest.length) {
    const id = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await fsPatch('schedalerts/' + id, { type: 'outbox', tokens: rest, msg: data, next: new Date().toISOString(), active: true }, token, null, false, B);
  }
  return ok;
}
async function runScheduled(env) {
  const B = budget(45);
  const rep = { ok: true, now: new Date().toISOString(), due: 0, sent: 0, phones: 0, waiting: 0, errors: [] };
  const token = await googleAccess(env, 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging', B);
  /* only what is due now: an empty check costs one read a minute */
  const nowIso = new Date().toISOString();
  const q = { structuredQuery: { from: [{ collectionId: 'schedalerts' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'next' }, op: 'GREATER_THAN', value: { stringValue: '' } } },
    { fieldFilter: { field: { fieldPath: 'next' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: nowIso } } }
  ] } }, limit: 50 } };
  const r = await bf(B, `${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  if (!r.ok) throw new Error('Could not read scheduled alerts (' + r.status + ')');
  const now = Date.now();
  const due = (await r.json()).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), ...Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, val(v)])) }))
    .filter(a => a.active === true);
  rep.due = due.length;
  for (const a of due) {
    if (B.left < 8) { rep.waiting++; continue; }
    try {
      if (a.type === 'outbox') {
        /* the rest of a big send: next batch of phones */
        const toks = Array.isArray(a.tokens) ? a.tokens : [];
        const room = Math.max(0, B.left - 3), go = toks.slice(0, room), rest = toks.slice(room);
        if (rest.length) await fsPatch('schedalerts/' + a.id, { tokens: rest }, token, ['tokens'], true, B); else await fsDelete('schedalerts/' + a.id, token, B);
        await Promise.all(go.map(t => bf(B, `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: fcmBody(t, a.msg || {}) }).catch(() => null)));
        rep.phones += go.length; continue;
      }
      if (!(Date.parse(a.next) > now - 6 * 3600e3)) { await fsPatch('schedalerts/' + a.id, { next: nextAt(a, now) || '', active: !!nextAt(a, now) }, token, ['next', 'active'], true, B); continue; }
      const nx = nextAt(a, now);
      /* mark it first so a slow send can never go out twice */
      await fsPatch('schedalerts/' + a.id, { next: nx || '', active: !!nx, lastSent: new Date(now).toISOString() }, token, ['next', 'active', 'lastSent'], false, B);
      const body = clip(a.body, 180); if (!body) continue;
      const day = new Date(now + QLD).toISOString().slice(0, 10);
      await fsPatch('updates/alert~' + now.toString(36) + a.id.slice(0, 4), { kind: 'alert', body, day, at: new Date(now).toISOString(), to: a.to || '', toName: a.toName || 'Everyone', ding: !!a.ding, sched: a.id }, token, null, false, B);
      rep.sent++;
      if (!a.ding) continue;
      const to = String(a.to || '');
      let filter = null;
      if (to.startsWith('st:')) filter = eq('staff', to.slice(3));
      else if (to.startsWith('pc:')) filter = { fieldFilter: { field: { fieldPath: 'pcs' }, op: 'ARRAY_CONTAINS', value: { stringValue: to.slice(3) } } };
      const phones = await findPhones(filter, token, B);
      rep.phones += phones.length;
      await sendMany(phones.map(p => p.token), { title: 'PDS Alert', body, url: '#home', kind: 'urgent' }, token, B);
    } catch (e) { rep.errors.push(String(e && e.message || e).slice(0, 200)); }
  }
  try { await runTasks(token, rep, B); } catch (e) { rep.errors.push('tasks: ' + String(e && e.message || e).slice(0, 200)); }
  rep.callsLeft = B.left;
  console.log('scheduled alerts', JSON.stringify(rep));
  return rep;
}

/* ---------- task reminders: ding the person a task is for ---------- */
async function runTasks(token, rep, B) {
  if (B.left < 6) return;
  const nowIso = new Date().toISOString();
  const q = { structuredQuery: { from: [{ collectionId: 'tasks' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'next' }, op: 'GREATER_THAN', value: { stringValue: '' } } },
    { fieldFilter: { field: { fieldPath: 'next' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: nowIso } } }
  ] } }, limit: 60 } };
  const r = await bf(B, `${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  if (!r.ok) throw new Error('Could not read tasks (' + r.status + ')');
  const rows = (await r.json()).filter(x => x.document);
  rep.tasks = rows.length;
  for (const x of rows) {
    /* each task needs about 5 calls; whatever doesn't fit is picked up next minute */
    if (B.left < 6) { rep.waiting++; continue; }
    try {
      const t = { id: x.document.name.split('/').pop(), ...Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, val(v)])) };
      const list = Array.isArray(t.rems) ? t.rems : [];
      const due = list.filter(m => !m.sent && m.at <= nowIso);
      const later = list.map(m => (!m.sent && m.at <= nowIso) ? { ...m, sent: true } : m);
      const next = (later.find(m => !m.sent) || {}).at || '';
      if (!t.title || !t.who) continue;
      await fsPatch('tasks/' + t.id, { rems: later, next }, token, ['rems', 'next'], true, B);
      if (t.status === 'done') continue;
      /* only send the latest one if several are due at once (e.g. the worker was off for a while) */
      const ding = due.filter(m => Date.parse(m.at) > Date.now() - 6 * 3600e3 && m.k !== 'over').pop();
      if (ding) {
        const phones = await findPhones(emailIs(t.who), token, B);
        rep.phones += phones.length;
        await sendMany(phones.map(p => p.token), { title: 'Task: ' + clip(t.title, 100), body: 'Due ' + (t.whenTxt || '') + '. Tap to see it.', url: '#home', kind: 'urgent' }, token, B);
        await fsPatch('tasks/' + t.id, { lastDing: new Date().toISOString(), lastPhones: phones.length }, token, ['lastDing', 'lastPhones'], true, B).catch(() => null);
      }
    } catch (e) { rep.errors.push('task: ' + String(e && e.message || e).slice(0, 200)); }
  }
}
/* the owner signs in with either of two emails, so a task for one reaches the phones signed in with the other too */
function emailIs(e) {
  e = String(e || '').toLowerCase();
  if (OWNERS.includes(e)) return { fieldFilter: { field: { fieldPath: 'email' }, op: 'IN', value: { arrayValue: { values: OWNERS.map(x => ({ stringValue: x })) } } } };
  return eq('email', e);
}

/* ---------- helpers ---------- */
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const safeUrl = u => /^#[a-z0-9/_-]{0,60}$/i.test(String(u || '')) ? u : '';
const eq = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: { stringValue: v } } });

function inQuietHours(cfg) {
  const from = cfg.quietFrom ?? 20, to = cfg.quietTo ?? 5; // 8pm to 5am by default
  if (cfg.quiet === false) return false;
  const h = (new Date().getUTCHours() + 10) % 24; // Queensland time
  return from > to ? (h >= from || h < to) : (h >= from && h < to);
}

/* Firestore, read as the person who is signed in (so the app's own security rules still apply) */
function val(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)]));
  return null;
}
async function getDoc(path, idToken) {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: 'Bearer ' + idToken } });
  if (!r.ok) return null;
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, val(x)]));
}
async function roleOf(email, idToken) {
  if (OWNERS.includes(email)) return 'admin';
  const a = await getDoc('access/' + encodeURIComponent(email), idToken);
  return a ? (a.role === 'admin' ? 'admin' : 'driver') : null;
}
async function findPhones(filter, idToken, B) {
  const q = { structuredQuery: { from: [{ collectionId: 'push' }], limit: 500 } };
  if (filter) q.structuredQuery.where = filter;
  const r = await bf(B, `${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  if (!r.ok) throw new Error('Could not read phone list (' + r.status + ')');
  const rows = await r.json();
  return rows.filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), token: val(x.document.fields.token), email: String(val(x.document.fields.email) || '').toLowerCase() })).filter(p => p.token);
}

/* Check the Firebase sign in token is real, current and for this project */
let jwkCache = { at: 0, keys: null };
async function verifyIdToken(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return null;
  const dec = s => JSON.parse(new TextDecoder().decode(b64u(s)));
  const head = dec(parts[0]), body = dec(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== 'RS256' || body.aud !== PROJECT || body.iss !== 'https://securetoken.google.com/' + PROJECT) return null;
  if (!(body.exp > now) || !(body.iat <= now + 60) || !body.sub || body.email_verified !== true || !body.email) return null;
  if (!jwkCache.keys || Date.now() - jwkCache.at > 3600e3) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    jwkCache = { at: Date.now(), keys: (await r.json()).keys };
  }
  const jwk = jwkCache.keys.find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  return ok ? { uid: body.sub, email: String(body.email).toLowerCase() } : null;
}

/* Get a short lived Google access token from the send only key */
const accessCache = {};
async function googleAccess(env, scope = 'https://www.googleapis.com/auth/firebase.messaging', B) {
  const c = accessCache[scope];
  if (c && c.tok && Date.now() < c.exp - 60e3) return c.tok;
  const sa = JSON.parse(env.SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64uEnc(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await bf(B, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64uEnc(new Uint8Array(sig)) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google key was not accepted');
  accessCache[scope] = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}
function b64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function b64uEnc(bytes) { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
