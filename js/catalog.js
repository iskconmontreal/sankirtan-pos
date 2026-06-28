/* Sankirtan POS — Catalog Module
   Books: fetched from Goloka API (with localStorage cache + sample fallback)
   Devotees: fetched from GET /api/sankirtan/distributors (with localStorage cache)
*/

import { CONFIG, CATEGORY_POINTS, SIZE_LABELS, SIZE_ORDER, COVER_LABELS, COVER_ORDER, LANG_ORDER } from './config.js';

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
          .map(b => ({ ...b, points_per_unit: b.points_per_unit ?? CATEGORY_POINTS[b.category] ?? 0, books_per_unit: b.books_per_unit ?? 1 }));
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

    Catalog.books = [];
    return { source: 'empty', count: 0 };
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

  languages() {
    const seen = new Set();
    Catalog.books.forEach(b => { if (b.language) seen.add(b.language); });
    const indexOf = (v) => {
      const i = LANG_ORDER.findIndex(x => x.toLowerCase() === String(v).toLowerCase());
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...seen].sort((a, b) => {
      const ia = indexOf(a), ib = indexOf(b);
      return ia !== ib ? ia - ib : String(a).localeCompare(String(b));
    });
  },

  // Resolve a stack's component books (each item is { book_id }).
  _stackComponents(stack) {
    return (stack.items || [])
      .map(it => Catalog.books.find(b => b.id === it.book_id))
      .filter(Boolean);
  },
  // A stack's language(s) and availability are derived from its components.
  _stackLangs(stack) {
    const langs = [];
    Catalog._stackComponents(stack).forEach(c => { if (c.language && !langs.includes(c.language)) langs.push(c.language); });
    return langs;
  },
  _stackStock(stack) {
    const comps = Catalog._stackComponents(stack);
    return comps.length ? Math.min(...comps.map(c => c.stock || 0)) : 0;
  },
  // Stacks for a language (matched if ANY component is in it), as picker rows.
  stacks(language) {
    return Catalog.books
      .filter(b => b.is_stack)
      .filter(b => !language || Catalog._stackLangs(b).includes(language))
      .map(b => ({ ...b, stock: Catalog._stackStock(b), qty: 0 }))
      .sort((a, b) => a.title.localeCompare(b.title));
  },

  groupedBooks(language) {
    const source = language
      ? Catalog.books.filter(b => b.language === language)
      : Catalog.books;

    const bySize = {};
    source.forEach(book => {
      const cat = book.category || '';
      const coverKey = cat[0];
      const size = parseInt(cat[1], 10);
      if (book.is_stack || !COVER_LABELS[coverKey] || !SIZE_LABELS[size]) return;
      if (!bySize[size]) bySize[size] = {};
      if (!bySize[size][coverKey]) bySize[size][coverKey] = [];
      bySize[size][coverKey].push(book);
    });

    const groups = SIZE_ORDER
      .filter(size => bySize[size])
      .map(size => {
        const pts = CATEGORY_POINTS['S' + size] ?? 0;
        return {
          sizeKey: size,
          label:   SIZE_LABELS[size],
          points:  pts,
          covers: COVER_ORDER
            .filter(c => bySize[size][c]?.length > 0)
            .map(c => ({
              coverKey: c,
              label:    COVER_LABELS[c],
              books:    bySize[size][c]
                .sort((a, b) => a.title.localeCompare(b.title))
                .map(b => ({ ...b, qty: 0 })),
            })),
        };
      });

    // Stacks ride the same group shape (one synthetic cover, no sublabel) so the
    // picker, totals, and qty controls work unchanged. Shown under each language
    // a component belongs to.
    const stacks = Catalog.stacks(language);
    if (stacks.length) {
      groups.push({ sizeKey: 'stack', label: 'Stacks', points: null, covers: [{ coverKey: 'stack', label: '', books: stacks }] });
    }
    return groups;
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
