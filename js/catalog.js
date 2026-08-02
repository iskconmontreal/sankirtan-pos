/* Sankirtan POS — Catalog Module
   Books: fetched from Goloka API with the logged-in user's JWT
   (localStorage cache fallback for offline).
*/

import { CONFIG, CATEGORY_POINTS, SIZE_LABELS, SIZE_ORDER, COVER_LABELS, COVER_ORDER, LANG_ORDER } from './config.js';
import { DB } from './db.js';

// A "set" is a multi-volume boxed title. The catalog has no flag for it — the
// convention is that the title says so. Whole-word match so "Sunset"/"Asset"
// can't false-positive.
const SET_TITLE_RE = /\bsets?\b/i;

// Books → picker rows: title-sorted, qty zeroed (state.js re-hydrates the qtys).
const _rows = (books) => books
  .sort((a, b) => a.title.localeCompare(b.title))
  .map(b => ({ ...b, qty: 0 }));

// Cover blocks → one flat, title-sorted row list for a group.
//
// The picker used to nest a "Soft cover" / "Hard cover" sub-header above each
// block, which put the only thing distinguishing two identical titles far away
// from the rows themselves. Instead every row carries its own cover pill, and
// the two variants of a title sit next to each other where the difference is
// readable at a glance. The pill is dropped entirely when a group has just one
// cover — there is nothing to disambiguate.
const _flatRows = (blocks) => {
  const filled = blocks.filter(b => b.books.length > 0);
  const showPill = filled.length > 1;
  return filled
    .flatMap(({ coverKey, label, books }) => books.map(b => ({
      ...b,
      qty: 0,
      coverKey,
      coverPill: showPill && label ? label.toUpperCase() : '',
    })))
    .sort((a, b) =>
      a.title.localeCompare(b.title) ||
      COVER_ORDER.indexOf(a.coverKey) - COVER_ORDER.indexOf(b.coverKey));
};

export const Catalog = {
  books: [],

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

    try {
      const books = await DB.getBooks();
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

    Catalog.books = [];
    return { source: 'empty', count: 0 };
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

  // Every active book reaches the picker: `active` is the only thing allowed to
  // hide a title. Excluded from the BBT score ≠ excluded from distribution, and a
  // book with no size tier yet (S0/H0, page count still missing) is still being
  // handed out. Those land in their own groups instead of being dropped.
  groupedBooks(language) {
    const source = language
      ? Catalog.books.filter(b => b.language === language)
      : Catalog.books;

    const bySize = {};
    const sets   = [];
    const other  = {};  // coverKey → books, for titles with no scored tier
    source.forEach(book => {
      if (book.is_stack) return;  // stacks have their own group, below
      const cat = book.category || '';
      const coverKey = cat[0];
      const size = parseInt(cat[1], 10);
      if (SET_TITLE_RE.test(book.title || '')) {
        sets.push(book);
      } else if (book.exclude_from_bbt || !COVER_LABELS[coverKey] || !SIZE_LABELS[size]) {
        const key = COVER_LABELS[coverKey] ? coverKey : '?';
        if (!other[key]) other[key] = [];
        other[key].push(book);
      } else {
        if (!bySize[size]) bySize[size] = {};
        if (!bySize[size][coverKey]) bySize[size][coverKey] = [];
        bySize[size][coverKey].push(book);
      }
    });

    const groups = SIZE_ORDER
      .filter(size => bySize[size])
      .map(size => ({
        sizeKey: size,
        label:   SIZE_LABELS[size],
        points:  CATEGORY_POINTS['S' + size] ?? 0,
        books:   _flatRows(COVER_ORDER.map(c => ({
          coverKey: c, label: COVER_LABELS[c], books: _rows(bySize[size][c] || []),
        }))),
      }));

    // Sets (boxed multi-volume titles) — one block, no cover pill. Matched on
    // the book's own language like any other row, so the French Srimad-Bhagavatam
    // Set only shows under French.
    if (sets.length) {
      groups.push({ sizeKey: 'sets', label: 'Sets', points: null, books: _rows(sets) });
    }

    // Everything else the BBT doesn't score: excluded titles, and books still
    // waiting on a page count (S0/H0). Distributed all the same.
    const otherBooks = _flatRows([...COVER_ORDER, '?'].map(c => ({
      coverKey: c, label: COVER_LABELS[c] || '', books: _rows(other[c] || []),
    })));
    if (otherBooks.length) {
      groups.push({ sizeKey: 'other', label: 'Other titles — not scored', points: null, books: otherBooks });
    }

    // Stacks ride the same group shape so the picker, totals, and qty controls
    // work unchanged. Shown under each language a component belongs to.
    const stacks = Catalog.stacks(language);
    if (stacks.length) {
      groups.push({ sizeKey: 'stack', label: 'Stacks', points: null, books: stacks });
    }
    return groups;
  },

  // ── localStorage helpers ────────────────────────────────

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
