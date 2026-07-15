/* Sankirtan POS — Sessions Module
   Tracks the current in-progress session entries (qty per book)
   and persists pending (failed) submissions to localStorage.
*/

import { CONFIG } from './config.js';

function _newKey() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'k_' + Date.now() + '_' + Math.random().toString(36).slice(2);
}

export const Sessions = {
  // Current in-progress entries: [{ book_id, qty, title, category, points_per_unit, cost_cents }]
  entries: [],

  // Idempotency key for the *current* in-progress session. Rotated on clear()
  // so each fresh session gets its own. Sent as `Idempotency-Key` on POST and
  // persisted alongside any pending payload so retries can't double-record.
  idempotencyKey: _newKey(),

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
        cost_cents:         book.cost_cents,
        retail_price_cents: book.retail_price_cents,
        books_per_unit:     book.books_per_unit || 1,
      });
    }
  },

  getQty(book_id) {
    const entry = Sessions.entries.find(e => e.book_id === book_id);
    return entry ? entry.qty : 0;
  },

  clear() {
    Sessions.entries = [];
    Sessions.idempotencyKey = _newKey();
  },

  getIdempotencyKey() {
    return Sessions.idempotencyKey;
  },

  getTotalBooks() {
    // A stack contributes its component count (books_per_unit) per unit sold.
    return Sessions.entries.reduce((sum, e) => sum + e.qty * (e.books_per_unit || 1), 0);
  },

  getTotalPoints() {
    const raw = Sessions.entries.reduce((sum, e) => sum + e.qty * (e.points_per_unit || 0), 0);
    return Math.round(raw * 100) / 100;
  },

  getSuggestedCents() {
    return Sessions.entries.reduce((sum, e) => sum + e.qty * (e.retail_price_cents || 0), 0);
  },

  toApiBooks() {
    return Sessions.entries
      .filter(e => e.qty > 0)
      .map(e => ({ book_id: e.book_id, qty: e.qty }));
  },

  // ── Pending (failed) submissions ──────────────────────

  savePending(payload, idempotency_key) {
    const pending = Sessions.getPending();
    pending.push({
      id: Date.now(),
      payload,
      idempotency_key: idempotency_key || _newKey(),
      saved_at: new Date().toISOString(),
    });
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

  // ── Submitted archive (durable) ───────────────────────
  // Every acked session is KEPT on the device (payload + idempotency key), so the
  // POS can always re-push ALL books distributed after a Goloka crash/restore.
  // Goloka's idempotency keys make re-pushes duplicate-safe. Never pruned by age;
  // only a high safety cap protects the storage quota — and pruning is reported,
  // never silent (returns 'pruned' / 'error' so the UI can warn).

  ARCHIVE_CAP: 1000,

  saveRecent(result, payload, idempotency_key) {
    const recent = Sessions.getRecent();
    recent.unshift({ ...result, payload, idempotency_key, saved_at: new Date().toISOString() });
    let entries = recent.slice(0, Sessions.ARCHIVE_CAP);
    let status  = entries.length < recent.length ? 'pruned' : 'ok';
    try {
      localStorage.setItem(CONFIG.STORAGE_KEYS.RECENT, JSON.stringify(entries));
      return status;
    } catch (_) {
      // Quota hit — drop the oldest half rather than lose the new session.
      try {
        entries = entries.slice(0, Math.ceil(entries.length / 2));
        localStorage.setItem(CONFIG.STORAGE_KEYS.RECENT, JSON.stringify(entries));
        return 'pruned';
      } catch (_) { return 'error'; }
    }
  },

  getRecent() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.RECENT);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  },

  // True if this session key is already recorded somewhere durable (queued in
  // PENDING or archived after a confirmed submit) — used to skip stale drafts.
  hasRecordOf(idempotency_key) {
    if (!idempotency_key) return false;
    return Sessions.getPending().some(p => p.idempotency_key === idempotency_key)
        || Sessions.getRecent().some(r => r.idempotency_key === idempotency_key);
  },
};
