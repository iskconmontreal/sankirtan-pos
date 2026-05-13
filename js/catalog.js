/* Sankirtan POS — Catalog Module
   Books: fetched from Goloka API (with localStorage cache + sample fallback)
   Devotees: fetched from GET /api/sankirtan/distributors (with localStorage cache)
*/

import { CONFIG, SAMPLE_BOOKS, CATEGORY_LABELS, CATEGORY_POINTS, CATEGORY_ORDER } from './config.js';

export const Catalog = {
  books:    [],
  devotees: [], // [{ id, name, spiritual_name, email }]

  // ── Books ────────────────────────────────────────────────

  async loadBooks(force = false) {
    if (force) localStorage.removeItem(CONFIG.STORAGE_KEYS.CATALOG_CACHE);

    if (!force) {
      const cached = Catalog._readCache(CONFIG.STORAGE_KEYS.CATALOG_CACHE);
      if (cached) {
        Catalog.books = cached;
        return { source: 'cache', count: cached.length };
      }
    }

    const cfg = Catalog._loadConfig();
    const url  = cfg.goloka_url || CONFIG.GOLOKA_URL;
    const key  = cfg.write_key  || CONFIG.SANKIRTAN_WRITE_KEY;

    if (url && key) {
      try {
        const resp = await fetch(`${url}/api/sankirtan/books`, {
          headers: { 'Authorization': `Bearer ${key}` },
          cache:   'no-store',
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const books = await resp.json();
        const active = books
          .filter(b => b.active !== false)
          .map(b => ({ ...b, points_per_unit: b.points_per_unit ?? CATEGORY_POINTS[b.category] ?? 0 }));
        Catalog.books = active;
        Catalog._writeCache(CONFIG.STORAGE_KEYS.CATALOG_CACHE, active);
        return { source: 'api', count: active.length };
      } catch (err) {
        console.warn('[Catalog] Books fetch failed:', err.message);
        const cached = Catalog._readCache(CONFIG.STORAGE_KEYS.CATALOG_CACHE);
        if (cached) {
          Catalog.books = cached;
          return { source: 'cache', count: cached.length };
        }
      }
    }

    Catalog.books = SAMPLE_BOOKS.slice();
    return { source: 'sample', count: Catalog.books.length };
  },

  // ── Distributors ──────────────────────────────────────────

  async loadDistributors(force = false) {
    if (force) localStorage.removeItem(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE);

    if (!force) {
      const cached = Catalog._readCache(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE);
      if (cached) {
        Catalog.devotees = cached;
        return { source: 'cache', count: cached.length };
      }
    }

    const cfg = Catalog._loadConfig();
    const url  = cfg.goloka_url || CONFIG.GOLOKA_URL;
    const key  = cfg.write_key  || CONFIG.SANKIRTAN_WRITE_KEY;

    if (url && key) {
      try {
        const resp = await fetch(`${url}/api/sankirtan/distributors`, {
          headers: { 'Authorization': `Bearer ${key}` },
          cache:   'no-store',
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const distributors = await resp.json();
        Catalog.devotees = distributors;
        Catalog._writeCache(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE, distributors);
        return { source: 'api', count: distributors.length };
      } catch (err) {
        console.warn('[Catalog] Distributors fetch failed:', err.message);
        const cached = Catalog._readCache(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE);
        if (cached) {
          Catalog.devotees = cached;
          return { source: 'cache', count: cached.length };
        }
      }
    }

    Catalog.devotees = [];
    return { source: 'empty', count: 0 };
  },

  filterDevotees(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return Catalog.devotees.slice();
    return Catalog.devotees.filter(d => {
      const display = (d.spiritual_name || d.name || '').toLowerCase();
      const legal   = (d.name || '').toLowerCase();
      return display.includes(q) || legal.includes(q);
    });
  },

  // ── Grouped books ─────────────────────────────────────────

  groupedBooks() {
    const byCategory = {};
    Catalog.books.forEach(book => {
      const cat = book.category || 'S1';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(book);
    });

    return CATEGORY_ORDER
      .filter(cat => byCategory[cat]?.length > 0)
      .map(cat => {
        const pts = CATEGORY_POINTS[cat] ?? 0;
        const ptsLabel = pts === Math.floor(pts) ? pts : pts.toFixed(2);
        return {
          category: cat,
          label: CATEGORY_LABELS[cat] || cat,
          points: parseFloat(ptsLabel),
          books: byCategory[cat]
            .sort((a, b) => a.title.localeCompare(b.title))
            .map(b => ({ ...b, qty: 0 })),
        };
      });
  },

  // ── localStorage helpers ────────────────────────────────

  _loadConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.CONFIG) || '{}'); }
    catch (_) { return {}; }
  },

  _writeCache(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }
    catch (_) {}
  },

  _readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { data } = JSON.parse(raw);
      return Array.isArray(data) && data.length > 0 ? data : null;
    } catch (_) { return null; }
  },
};
