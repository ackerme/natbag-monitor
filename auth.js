// auth.js – התחברות לחשבון (Amazon Cognito, Hosted UI + Authorization Code + PKCE)
//
// • אין סוד בדפדפן: PKCE מחליף את ה-client secret (קוד חד-פעמי + אימות שהבקשה הגיעה מאותו דפדפן).
// • state אקראי נגד CSRF בהתחברות.
// • הטוקנים נשמרים ב-sessionStorage – נמחקים כשסוגרים את הלשונית.
// • ההגדרות (כתובת ה-API, דף ההתחברות, מזהה האפליקציה) מגיעות מהשרת: GET /config.
(function () {
  const PROXY = 'https://ivm4jwhxpy5vr5hw6lrdy7uyl40zcvnq.lambda-url.us-east-1.on.aws/';
  const K = { tok: 'natbag.tokens', pkce: 'natbag.pkce' };
  let cfgP = null;

  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => new URL('account.html', location.href.replace(/[?#].*$/, '')).href;

  function config() {
    if (!cfgP) cfgP = fetch(PROXY + 'config').then(r => r.ok ? r.json() : { accounts: false }).catch(() => ({ accounts: false }));
    return cfgP;
  }

  function claims(jwt) {
    try {
      const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch { return null; }
  }

  const read = () => { try { return JSON.parse(sessionStorage.getItem(K.tok) || 'null'); } catch { return null; } };
  const write = (t) => { try { t ? sessionStorage.setItem(K.tok, JSON.stringify(t)) : sessionStorage.removeItem(K.tok); } catch {} };

  async function tokenRequest(params) {
    const c = await config();
    const r = await fetch(c.authDomain + '/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, ...params }),
    });
    if (!r.ok) throw new Error('התחברות נכשלה (' + r.status + ')');
    const j = await r.json();
    const old = read() || {};
    const t = { id: j.id_token, refresh: j.refresh_token || old.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 };
    write(t);
    return t;
  }

  async function login() {
    const c = await config();
    if (!c.accounts) throw new Error('חשבונות עדיין לא מופעלים בשרת');
    const verifier = rand(48), state = rand(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    sessionStorage.setItem(K.pkce, JSON.stringify({ verifier, state }));
    const u = new URL(c.authDomain + '/oauth2/authorize');
    u.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri(), scope: 'openid email',
      code_challenge_method: 'S256', code_challenge: challenge, state }).toString();
    location.assign(u.href);
  }

  /** בדף החזרה: מחליף את ה-code בטוקנים (פעם אחת) ומנקה את הכתובת */
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return false;
    history.replaceState(null, '', location.pathname);
    if (q.has('error')) throw new Error(q.get('error_description') || q.get('error'));
    const saved = JSON.parse(sessionStorage.getItem(K.pkce) || 'null');
    sessionStorage.removeItem(K.pkce);
    if (!saved || saved.state !== q.get('state')) throw new Error('בקשת התחברות לא תקינה – נסו שוב');
    await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: saved.verifier });
    return true;
  }

  async function idToken() {
    const t = read();
    if (!t) return null;
    if (Date.now() < t.exp) return t.id;
    if (!t.refresh) { write(null); return null; }
    try { return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })).id; }
    catch { write(null); return null; }
  }

  async function user() {
    const id = await idToken();
    const c = id && claims(id);
    if (!c) return null;
    const g = c['cognito:groups'] || [];
    return { email: c.email || '', admin: g.includes('admin') };
  }

  async function logout() {
    const c = await config(), t = read();
    write(null);
    if (t?.refresh) {   // ביטול ה-refresh token בשרת – לא רק מחיקה מהדפדפן
      fetch(c.authDomain + '/oauth2/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh, client_id: c.clientId }) }).catch(() => {});
    }
    const u = new URL(c.authDomain + '/logout');
    u.search = new URLSearchParams({ client_id: c.clientId, logout_uri: redirectUri() }).toString();
    setTimeout(() => location.assign(u.href), 150);
  }

  async function api(method, path, body) {
    const [c, id] = await Promise.all([config(), idToken()]);
    if (!id) throw Object.assign(new Error('צריך להתחבר'), { status: 401 });
    const r = await fetch(c.userApi + path, {
      method, headers: { Authorization: 'Bearer ' + id, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || ('שגיאה ' + r.status)), { status: r.status });
    return j;
  }

  window.NatbagAuth = { config, login, logout, handleRedirect, user, api, signedIn: () => !!read() };
})();
