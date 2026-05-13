/* Sankirtan POS — Sessions Module
   Tracks the current in-progress session entries (qty per book)
   and persists pending (failed) submissions to localStorage.
*/

import { CONFIG } from './config.js';

export const Sessions = {
  // Current in-progress entries: [{ book_id, qty, title, category, points_per_unit, cost_cents }]
  entries: [],

  // ── Current session ───────────────────────────────────

  setQty(book_id, qty, book) {
    const existing = Sessions.entries.find(e => e.book_id === book_id);
    if (qty <= 0) {
      Sessions.entries = Sessions.entries.filter(e => e.book_id !== book_id);
      return;
    }
    if (existing) {
      existing.qty = qty;
    } else if (book) {
      Sessions.entries.push({
        book_id,
        qty,
        title:           book.title,
        category:        book.category,
        points_per_unit: book.points_per_unit,
        cost_cents:      book.cost_cents,
      });
    }
  },

  getQty(book_id) {
    const entry = Sessions.entries.find(e => e.book_id === book_id);
    return entry ? entry.qty : 0;
  },

  clear() {
    Sessions.entries = [];
  },

  getTotalBooks() {
    return Sessions.entries.reduce((sum, e) => sum + e.qty, 0);
  },

  getTotalPoints() {
    const raw = Sessions.entries.reduce((sum, e) => sum + e.qty * (e.points_per_unit || 0), 0);
    return Math.round(raw * 100) / 100;
  },

  getSuggestedCents() {
    return Sessions.entries.reduce((sum, e) => sum + e.qty * (e.cost_cents || 0), 0);
  },

  toApiBooks() {
    return Sessions.entries
      .filter(e => e.qty > 0)
      .map(e => ({ book_id: e.book_id, qty: e.qty }));
  },

  // ── Pending (failed) submissions ──────────────────────

  savePending(payload) {
    const pending = Sessions.getPending();
    pending.push({ id: Date.now(), payload, saved_at: new Date().toISOString() });
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.PENDING, JSON.stringify(pending)); }
    catch (_) {}
  },

  getPending() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.PENDING);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  },

  removePending(id) {
    const filtered = Sessions.getPending().filter(p => p.id !== id);
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.PENDING, JSON.stringify(filtered)); }
    catch (_) {}
  },

  // ── Recent sessions (for landing context) ────────────

  saveRecent(result) {
    const recent = Sessions.getRecent();
    recent.unshift({ ...result, saved_at: new Date().toISOString() });
    const trimmed = recent.slice(0, 10);
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.RECENT, JSON.stringify(trimmed)); }
    catch (_) {}
  },

  getRecent() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.RECENT);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  },
};
