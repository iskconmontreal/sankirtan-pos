/* Sankirtan POS — Goloka REST Client
   All requests carry the logged-in user's JWT. On a 401 the client silently
   exchanges the refresh token for a new JWT and retries once; if that fails
   the error carries `authExpired: true` so callers can queue the work and
   show the login step (auth keys are cleared, the offline queue is NOT).
*/

import { CONFIG } from './config.js';
import { auth } from './auth.js';

function _base() {
  return CONFIG.GOLOKA_URL.replace(/\/$/, '');
}

function _headers(extra) {
  const h = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    ...extra,
  };
  if (auth.token) h['Authorization'] = `Bearer ${auth.token}`;
  return h;
}

async function _shapeError(resp) {
  let msg = `HTTP ${resp.status}`;
  try { const e = await resp.json(); msg = e.error || e.message || msg; } catch (_) {}
  const err = new Error(msg);
  err.status = resp.status;
  return err;
}

// Single-flight refresh: concurrent 401s share one /auth/refresh round-trip.
let _refreshPromise = null;

async function _tryRefresh() {
  const rt = auth.refreshToken;
  if (!rt) return false;
  try {
    const resp = await fetch(`${_base()}/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body:    JSON.stringify({ refresh_token: rt }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.token) return false;
    auth.save(data.token, data.user, data.refresh_token);
    return true;
  } catch (_) {
    return false;
  }
}

async function _request(path, opts = {}, retried = false) {
  const resp = await fetch(`${_base()}${path}`, {
    ...opts,
    headers: _headers(opts.headers),
  });
  if (resp.status === 401 && auth.refreshToken && !retried) {
    if (!_refreshPromise) _refreshPromise = _tryRefresh().finally(() => { _refreshPromise = null; });
    if (await _refreshPromise) return _request(path, opts, true);
    auth.clear();
    const err = new Error('Signed out — please sign in again');
    err.status = 401;
    err.authExpired = true;
    throw err;
  }
  if (resp.status === 401 || resp.status === 403) {
    const err = await _shapeError(resp);
    if (resp.status === 401) { auth.clear(); err.authExpired = true; }
    throw err;
  }
  if (!resp.ok) throw await _shapeError(resp);
  return resp;
}

export const DB = {
  // ── Auth ──────────────────────────────────────────────

  // POST /auth/login — returns {step:'password_required'|'otp_required'} or {token,…}
  async login(email, password) {
    const resp = await _request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password:     password || '',
        device_id:    auth.deviceId,
        device_label: auth.deviceLabel,
      }),
    });
    return resp.json();
  },

  // POST /auth/verify-otp — returns {token, user, refresh_token}
  async verifyOtp(email, otp) {
    const resp = await _request('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({
        email,
        otp,
        device_id:    auth.deviceId,
        device_label: auth.deviceLabel,
      }),
    });
    return resp.json();
  },

  // GET /auth/google — returns {url} to navigate to. The callback returns the
  // browser to this page with tokens in the URL fragment (auth.capture()).
  async googleUrl() {
    const redirect = window.location.href.split('#')[0].split('?')[0];
    const resp = await _request(`/auth/google?redirect=${encodeURIComponent(redirect)}&device_id=${encodeURIComponent(auth.deviceId)}`);
    return resp.json();
  },

  // POST /auth/logout — revoke this device's refresh token (best-effort).
  async logout() {
    try {
      await _request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ device_id: auth.deviceId }),
      });
    } catch (_) {}
  },

  // ── Sankirtan ─────────────────────────────────────────

  // GET /api/sankirtan/books
  async getBooks() {
    const resp = await _request('/api/sankirtan/books', { cache: 'no-store' });
    return resp.json();
  },

  // POST /api/sankirtan/sessions — attributed server-side to the JWT user.
  // `idempotency_key` is optional. When supplied, sent as `Idempotency-Key` so
  // a retry of the same session can't create a duplicate row server-side.
  async postSession(payload, idempotency_key) {
    const headers = {};
    if (idempotency_key) headers['Idempotency-Key'] = idempotency_key;
    const resp = await _request('/api/sankirtan/sessions', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return resp.json();
  },

  // Re-push a stored session (disaster recovery). Same POST as postSession, but
  // also reports whether Goloka already had it: the server sets `Idempotent-Replay:
  // true` when it replays an existing session instead of creating a new one.
  // (Header may be CORS-hidden — callers can fall back to comparing session ids.)
  async repostSession(payload, idempotency_key) {
    const resp = await _request('/api/sankirtan/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotency_key },
      body: JSON.stringify(payload),
    });
    return {
      result:   await resp.json(),
      replayed: resp.headers.get('Idempotent-Replay') === 'true',
    };
  },

  // GET /api/sankirtan/leaderboard?period=month
  async getLeaderboard(period = 'month') {
    const resp = await _request(
      `/api/sankirtan/leaderboard?period=${encodeURIComponent(period)}`,
      { cache: 'no-store' }
    );
    return resp.json();
  },
};
