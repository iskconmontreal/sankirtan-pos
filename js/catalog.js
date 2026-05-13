/* Sankirtan POS — Catalog Module
   Books: fetched from Goloka API (with localStorage cache + sample fallback)
   Devotees: fetched from Google Sheet CSV (with localStorage cache)
*/

import { CONFIG, SAMPLE_BOOKS, CATEGORY_LABELS, CATEGORY_POINTS, CATEGORY_ORDER } from './config.js';

export const Catalog = {
  books:    [],
  devotees: [],

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

  // ── Devotees ─────────────────────────────────────────────

  async loadDevotees(force = false) {
    if (force) localStorage.removeItem(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE);

    if (!force) {
      const cached = Catalog._readCache(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE);
      if (cached) {
        Catalog.devotees = cached;
        return { source: 'cache', count: cached.length };
      }
    }

    const cfg = Catalog._loadConfig();
    const url = cfg.devotee_sheet_url || CONFIG.DEVOTEE_SHEET_CSV_URL;

    if (url) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        const names = Catalog._parseDevoteeCSV(text);
        Catalog.devotees = names;
        Catalog._writeCache(CONFIG.STORAGE_KEYS.DEVOTEES_CACHE, names);
        return { source: 'sheet', count: names.length };
      } catch (err) {
        console.warn('[Catalog] Devotee sheet fetch failed:', err.message);
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

  _parseDevoteeCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = Catalog._parseLine(lines[0]).map(h =>
      h.trim().replace(/^﻿/, '').toLowerCase()
    );

    // Accept "name", "spiritual name", or "devotee" as the name column
    const nameIdx = ['name', 'spiritual name', 'devotee', 'nom'].reduce((found, key) => {
      if (found >= 0) return found;
      return headers.indexOf(key);
    }, -1);

    const idx = nameIdx >= 0 ? nameIdx : 0;

    const names = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = Catalog._parseLine(lines[i]);
      const name = (cols[idx] || '').trim();
      if (name) names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  },

  _parseLine(line) {
    const fields = [];
    let current  = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
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

  filterDevotees(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return Catalog.devotees.slice();
    return Catalog.devotees.filter(d => d.toLowerCase().includes(q));
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
