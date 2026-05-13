/* Sankirtan POS — Goloka REST Client */

import { CONFIG } from './config.js';

function _headers() {
  return {
    'Authorization': `Bearer ${CONFIG.SANKIRTAN_WRITE_KEY}`,
    'Content-Type':  'application/json',
  };
}

function _base() {
  return CONFIG.GOLOKA_URL.replace(/\/$/, '');
}

export const DB = {
  isConfigured() {
    return !!(CONFIG.GOLOKA_URL && CONFIG.SANKIRTAN_WRITE_KEY);
  },

  // GET /api/sankirtan/books
  async getBooks() {
    const resp = await fetch(`${_base()}/api/sankirtan/books`, {
      headers: _headers(),
      cache:   'no-store',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  },

  // POST /api/sankirtan/sessions
  async postSession(payload) {
    const resp = await fetch(`${_base()}/api/sankirtan/sessions`, {
      method:  'POST',
      headers: _headers(),
      body:    JSON.stringify(payload),
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const e = await resp.json(); msg = e.error || e.message || msg; } catch (_) {}
      throw new Error(msg);
    }
    return resp.json();
  },

  // GET /api/sankirtan/leaderboard?period=month
  async getLeaderboard(period = 'month') {
    const resp = await fetch(
      `${_base()}/api/sankirtan/leaderboard?period=${encodeURIComponent(period)}`,
      { headers: _headers(), cache: 'no-store' }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  },

  // GET /api/sankirtan/distributors
  async getDistributors() {
    const resp = await fetch(`${_base()}/api/sankirtan/distributors`, {
      headers: _headers(),
      cache:   'no-store',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  },

  // Test connection: GET /api/sankirtan/books, return { ok, message }
  async testConnection() {
    try {
      const resp = await fetch(`${_base()}/api/sankirtan/books`, {
        headers: _headers(),
        cache:   'no-store',
      });
      if (!resp.ok) return { ok: false, message: `✗ HTTP ${resp.status}` };
      const books = await resp.json();
      const count = Array.isArray(books) ? books.filter(b => b.active !== false).length : 0;
      return { ok: true, message: `✓ Connected — ${count} active book(s) in catalog` };
    } catch (err) {
      return { ok: false, message: `✗ ${err.message}` };
    }
  },
};
