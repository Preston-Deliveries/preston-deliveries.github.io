/*
  PDS Contract 1161: phone notification sender (Cloudflare Worker)

  The app calls this with the signed in person's Firebase sign in token.
  This code checks who they are, decides who should get the notification,
  and sends it through Firebase Cloud Messaging using the "send only" key.

  Secret needed in Cloudflare (Settings, Variables and Secrets):
    SA_JSON  = the whole contents of the pds notify key file (type: Secret)

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
  enquiry:  { who: 'admin',  to: 'login',  title: 'New customer enquiry', body: 'There’s a new customer enquiry about one of your deliveries. Tap to view.', url: '' },
  report:   { who: 'member', to: 'admins', title: 'New report', body: 'A driver has sent a report. Tap to view.', url: '#reports' },
  feedback: { who: 'member', to: 'admins', title: 'New feedback', body: 'A driver has sent feedback. Tap to view.', url: '#feedback' },
  uniform:  { who: 'member', to: 'admins', title: 'New uniform order', body: 'A driver has ordered uniform. Tap to view.', url: '#uniform' }
};

export default {
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
      const role = await roleOf(me.email, idToken);
      if (!role) return out({ error: 'No access' }, 403);
      if (K.who === 'admin' && role !== 'admin') return out({ error: 'Admins only' }, 403);

      /* the admin's settings: each type on or off, and quiet hours */
      const cfg = await getDoc('pushcfg/main', idToken).catch(() => null) || {};
      if (cfg.off && cfg.off.includes(b.kind)) return out({ ok: true, sent: 0, skipped: 'This type is switched off' });
      const safety = b.kind === 'urgent' && b.safety === true;
      if (!safety && b.kind !== 'test' && inQuietHours(cfg)) return out({ ok: true, sent: 0, skipped: 'Quiet hours' });

      /* the message: drivers can never set the words themselves */
      const msg = K.title ? { title: K.title, body: K.body, url: K.url }
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
      const phones = await findPhones(filter, idToken);
      if (!phones.length) return out({ ok: true, sent: 0, skipped: 'Nobody has notifications turned on yet' });

      /* send */
      const access = await googleAccess(env);
      let sent = 0; const dead = [];
      await Promise.all(phones.map(async p => {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: {
            token: p.token,
            data: { title: msg.title, body: msg.body, url: msg.url || '', kind: b.kind },
            webpush: { headers: { Urgency: 'high', TTL: '86400' } }
          } })
        });
        if (r.ok) sent++;
        else if (r.status === 404 || r.status === 400) dead.push(p.id);
      }));
      return out({ ok: true, sent, of: phones.length, dead });
    } catch (e) {
      return out({ error: 'Could not send', detail: String(e && e.message || e).slice(0, 200) }, 500);
    }
  }
};

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
async function findPhones(filter, idToken) {
  const q = { structuredQuery: { from: [{ collectionId: 'push' }], limit: 500 } };
  if (filter) q.structuredQuery.where = filter;
  const r = await fetch(`${FS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + idToken, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  if (!r.ok) throw new Error('Could not read phone list (' + r.status + ')');
  const rows = await r.json();
  return rows.filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), token: val(x.document.fields.token) })).filter(p => p.token);
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
let accessCache = { exp: 0, tok: null };
async function googleAccess(env) {
  if (accessCache.tok && Date.now() < accessCache.exp - 60e3) return accessCache.tok;
  const sa = JSON.parse(env.SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64uEnc(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64uEnc(new Uint8Array(sig)) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google key was not accepted');
  accessCache = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return accessCache.tok;
}
function b64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function b64uEnc(bytes) { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
