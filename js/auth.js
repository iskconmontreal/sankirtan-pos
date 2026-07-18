/* Sankirtan POS — Auth Module
   Token storage and OAuth capture, adapted from Mandir's lib/auth.js.
   The logged-in user IS the distributor: sessions are attributed server-side
   to the JWT, so there is no devotee picker and no shared write key.
*/

import { CONFIG } from './config.js';

const K = CONFIG.STORAGE_KEYS;

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg/.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : 'Unknown';
  return `${browser} on ${os}`;
}

export const auth = {
  get token() { return localStorage.getItem(K.TOKEN); },
  get user() { try { return JSON.parse(localStorage.getItem(K.USER)); } catch { return null; } },
  get refreshToken() { return localStorage.getItem(K.REFRESH); },

  get deviceId() {
    let id = localStorage.getItem(K.DEVICE);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(K.DEVICE, id); }
    return id;
  },
  get deviceLabel() { return deviceLabel(); },

  get userId() {
    const u = this.user;
    if (u?.id) return u.id;
    if (u?.user_id) return u.user_id;
    try { return JSON.parse(atob(this.token.split('.')[1])).user_id || null; } catch { return null; }
  },

  get permissions() {
    try { return JSON.parse(atob(this.token.split('.')[1])).permissions || []; }
    catch { return []; }
  },

  can(perm) { return this.permissions.includes(perm); },

  get active() { return !!this.token; },

  displayName() {
    const u = this.user;
    const m = u?.meta || {};
    return m.spiritual_name || m.name || u?.email || '';
  },

  save(token, user, refreshToken) {
    localStorage.setItem(K.TOKEN, token);
    if (user) localStorage.setItem(K.USER, JSON.stringify(user));
    if (refreshToken) localStorage.setItem(K.REFRESH, refreshToken);
  },

  // Auth keys ONLY — never touches the pending queue, archive, or draft.
  clear() {
    localStorage.removeItem(K.TOKEN);
    localStorage.removeItem(K.USER);
    localStorage.removeItem(K.REFRESH);
  },

  // Capture tokens from the URL fragment after the Google OAuth redirect:
  //   #token=…&refresh=…&user=<double-encoded JSON>
  capture() {
    const hash = window.location.hash;
    if (!hash) return false;
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get('token');
    if (!token) return false;
    const user = params.get('user');
    let parsed = null;
    try { parsed = user ? JSON.parse(decodeURIComponent(user)) : null; } catch (_) {}
    this.save(token, parsed, params.get('refresh') || undefined);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  },
};
