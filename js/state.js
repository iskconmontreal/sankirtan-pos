/* Sankirtan POS — Reactive State (Sprae)
   Multi-step wizard: login → landing → books → collection → confirm → leaderboard
   The logged-in user is the distributor; sessions are attributed server-side.
*/

import sprae from './vendor/sprae.js';
import { CONFIG, LANG_LABELS, COVER_LABELS, PAYMENT_METHODS, PRIMARY_PAYMENT_COUNT, ANCHOR_LANGUAGES } from './config.js';
import { Catalog } from './catalog.js';
import { Sessions } from './sessions.js';
import { DB } from './db.js';
import { auth } from './auth.js';

// ── Module-level non-reactive ──────────────────────────────
let _toastTimer       = null;
let _confirmTimer     = null;

// ── Helpers ────────────────────────────────────────────────
function _todayLabel() {
  return new Date().toLocaleDateString('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function _todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parse a dollar-string field into integer cents (0 for blank/invalid).
function _toCents(v) {
  return Math.round(parseFloat(v || 0) * 100) || 0;
}

// Local calendar day for a date-ish value, as YYYY-MM-DD. occurred_at is stored
// day-resolution (…T00:00:00Z), so compare on the date part rather than parsing
// to a local Date, which would shift the day west of UTC.
function _dayKey(value) {
  return String(value).slice(0, 10);
}

// YYYY-MM-DD from a Date's *local* parts. toISOString() would shift the day for
// any timezone east of UTC, silently breaking the streak there.
function _localDayKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function _daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// "today" / "yesterday" / "3 days ago" / a date once it stops being relatable.
function _relativeDay(occurredAt) {
  const then = _dayKey(occurredAt);
  const days = Math.round((Date.parse(_todayISO()) - Date.parse(then)) / 86400000);
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)  return `${days} days ago`;
  return new Date(then + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

// Consecutive calendar days with at least one session, counting back from today
// (or from yesterday — a devotee who has not been out yet today has not broken
// the streak until the day ends).
function _streakDays(dates) {
  const days = new Set(dates.map(_dayKey));
  if (days.size === 0) return 0;
  const cursor = new Date(_todayISO() + 'T00:00:00');   // local midnight today
  if (!days.has(_localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(_localDayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// Calendar month `offset` months back. `to` is the FIRST day of the next month:
// goloka compares occurred_at (RFC3339) to the raw string, so "2026-08-31" would
// sort before "2026-08-31T00:00:00Z" and drop the last day's sessions.
function _monthRange(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const next  = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  const sameYear = start.getFullYear() === now.getFullYear();
  return {
    from:  _localDayKey(start),
    to:    _localDayKey(next),
    label: start.toLocaleDateString('en-CA',
      sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' }),
  };
}

// Sessions → leaderboard rows, matching the shape of GET /leaderboard so the
// cards, sorting and table work identically for a past month.
function _aggregateSessions(sessions) {
  const by = new Map();
  for (const s of sessions) {
    const name = s.distributor_name || '—';
    const row = by.get(name) || {
      distributor_name: name, distributor_id: s.distributor_id || 0,
      books: 0, points: 0,
      collected_cents: 0, cost_cents: 0, session_count: 0, bbt_pct: null,
    };
    row.books           += s.total_books || 0;
    row.points          += s.total_points || 0;
    row.collected_cents += s.collected_cents || 0;
    row.cost_cents      += s.total_cost_cents || 0;
    row.session_count   += 1;
    by.set(name, row);
  }
  return [...by.values()].map(r => ({
    ...r,
    points:  Math.round(r.points * 100) / 100,
    bbt_pct: r.collected_cents > 0 ? (r.cost_cents / r.collected_cents) * 100 : null,
  }));
}

function _readView() {
  try { return localStorage.getItem(CONFIG.STORAGE_KEYS.LB_VIEW) === 'individual' ? 'individual' : 'group'; }
  catch (_) { return 'group'; }
}

// Group rows carry their devotees in `members`; everything else is already one.
function _splitGroups(rows) {
  return rows.flatMap(r => (r.is_group && r.members?.length ? r.members : [r]));
}

function _readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}

// ── Sprae state ────────────────────────────────────────────
export const state = sprae(document.body, {

  // Navigation
  step:      'landing',
  prevStep:  'landing',
  stepTitle: '',

  // Date
  todayLabel: _todayLabel(),

  // Auth — login wizard sub-steps: email → password | otp
  authStep:    'email',
  authEmail:   '',
  authPassword: '',
  authOtp:     '',
  authError:   '',
  authLoading: false,
  emailFormOpen: false,   // the email form is behind a link; Google leads
  userName:    '',   // display name of the logged-in devotee

  // Books / catalog. The language filter is remembered across sessions — most
  // devotees stay in one language, and re-picking it every time cost a tap.
  bookGroups:       [],
  bookLanguages:    [],
  selectedLanguage: localStorage.getItem(CONFIG.STORAGE_KEYS.LANGUAGE) || '',
  sizeOrder:        localStorage.getItem(CONFIG.STORAGE_KEYS.SIZE_ORDER) === 'asc' ? 'asc' : 'desc',
  langSheetOpen:    false,
  searchQuery:      '',
  searchResults:    [],
  catalogLoading:   false,
  catalogNotice:    '',
  totalBooks:     0,
  totalPoints:    0,
  suggestedCents: 0,

  // Collection. methodDollars stays the single source of truth for the payload:
  // the simple (non-split) UI is a veneer that writes the one typed amount into
  // the selected method, so submitSession's payload building is unchanged.
  paymentMethods: PAYMENT_METHODS,
  methodDollars:  { Cash: '', Card: '', Cheque: '', Interac: '', 'Bank Transfer': '', Other: '' },
  collectedCents: 0,
  totalDollars:     '',
  selectedMethod:   'Cash',
  splitOpen:        false,
  allMethodsOpen:   false,
  sessionLocation:  '',
  sessionNote:      '',
  locationOpen:     false,
  submitting:       false,

  summaryOpen:      false,
  clearConfirm:     false,
  bbtInfoOpen:      false,

  // Confirmation
  confirmResult:    null,
  confirmCountdown: 0,
  confirmCollected: '',

  // Leaderboard
  leaderboardPeriod:   'month',
  leaderboardRows:     [],      // rendered rows, derived from the raw ones by the active view
  leaderboardRawRows:  [],      // as returned by the API, groups still folded
  leaderboardLoading:  false,
  leaderboardSortBy:   'points',
  leaderboardSortDir:  'desc',
  // Devotees sharing a group (meta.group in goloka) come back as one merged row.
  // 'group' keeps it merged, 'individual' splits it back into devotees.
  leaderboardView:     _readView(),
  expandedGroups:      [],      // group names currently showing their members
  monthOffset:         0,   // 0 = current month, 1 = last month, …
  lastDevotee:         '',

  // Home stats, all derived from the leaderboard + own sessions.
  statsLoading:        false,
  myBooksYear:         0,
  myPointsYear:        0,
  myRank:              0,
  streakDays:          0,
  lastSessionLabel:    '',
  lastSessionBooks:    0,
  templeBooksMonth:    0,
  templeLocations:     [],
  templeDevoteesMonth: 0,
  showAllLeaders:      false,

  archiveCount:  0,     // sessions stored on this device (submitted archive)
  repushing:     false,
  repushStatus:  '',

  // UI
  isOffline:    false,
  storageError: false,   // true if the in-progress count could not be saved to the device
  archiveWarning: '',    // set when the submitted archive was pruned / failed to save
  pendingCount: 0,
  pendingError: '',
  toastVisible: false,
  toastText:    '',

  // ── Navigation ─────────────────────────────────────────

  goto(step) {
    this.prevStep = this.step;
    this.step     = step;
    window.scrollTo(0, 0);
  },

  goBack() {
    const backMap = {
      books:       'landing',
      collection:  'books',
      confirm:     'landing',
      leaderboard: 'landing',
    };
    this.goto(backMap[this.step] || 'landing');
  },

  headerTitle() {
    return { books: 'Books distributed', collection: 'Collection', leaderboard: 'Leaderboard' }[this.step]
      || 'Sankirtan POS';
  },

  headerSub() {
    if (this.step === 'books')      return this.userName;
    if (this.step === 'collection') return `${this.userName} · ${this.totalBooks} ${this.totalBooks === 1 ? 'book' : 'books'} · ${this.totalPoints} pts`;
    return 'ISKCON Montréal';
  },

  // ── Landing ────────────────────────────────────────────

  async startSession() {
    const discarded = Sessions.getTotalBooks();

    // Clear the draft too — otherwise a reload before the first tap (iOS evicts
    // backgrounded tabs on screen-lock) resurrects the previous count.
    Sessions.clear();
    this._clearDraft();
    this.sessionLocation = '';
    this.sessionNote     = '';
    this.goto('books');

    // Refresh book groups (reload if bookGroups is empty)
    if (this.bookGroups.length === 0) {
      await this._loadBooks();
    } else {
      // Reset qtys for a fresh session
      this.bookGroups = this.bookGroups.map(group => ({
        ...group,
        books: group.books.map(b => ({ ...b, qty: 0 })),
      }));
    }
    this._syncTotals();

    if (discarded > 0) {
      this._showToast(`Started fresh — previous count of ${discarded} book(s) discarded.`);
    }
  },

  // ── Books ──────────────────────────────────────────────

  async _loadBooks() {
    this.catalogLoading = true;
    this.catalogNotice  = '';
    try {
      const result = await Catalog.loadBooks(false);
      this._refreshLanguages();
      if (result.source === 'empty') {
        this.catalogNotice = 'Could not load book catalog — check your connection.';
      } else if (result.source === 'cache') {
        this.catalogNotice = 'Showing cached catalog.';
      }
    } catch (err) {
      this.catalogNotice = 'Could not load catalog: ' + err.message;
    }
    this.catalogLoading = false;
  },

  // Background catalog revalidation, for stock changed by OTHER devices on the
  // same account: this device only force-refreshes after its own submit, so a
  // second phone's submission would otherwise stay invisible until re-login.
  // Called on app resume / reconnect (see the auto-sync block at the bottom).
  // Throttled, and re-renders only when the server data actually changed.
  _catalogRefreshing: false,
  _catalogRefreshedAt: 0,
  async refreshCatalog() {
    if (this._catalogRefreshing || !navigator.onLine || !auth.active) return;
    if (Date.now() - this._catalogRefreshedAt < 30000) return;
    this._catalogRefreshing = true;
    try {
      if (await Catalog.refreshBooks()) {
        this._refreshLanguages();
        this._syncTotals();   // re-hydrate the in-progress qtys after the rebuild
      }
      this._catalogRefreshedAt = Date.now();
    } finally {
      this._catalogRefreshing = false;
    }
  },

  incQty(book) {
    const newQty = (Sessions.getQty(book.id) || 0) + 1;
    Sessions.setQty(book.id, newQty, book);
    this._syncTotals();
    this._saveDraft();
    // Stacks are virtual bundles with no stock of their own (component stock is
    // tracked server-side), so they never trigger an over-stock warning.
    if (!book.is_stack && typeof book.stock === 'number' && newQty > book.stock) {
      this._showToast(`Warning: "${book.title}" is over stock (${book.stock}). Distribution will still be recorded.`);
    }
  },

  decQty(book) {
    const newQty = Math.max(0, (Sessions.getQty(book.id) || 0) - 1);
    Sessions.setQty(book.id, newQty, book);
    this._syncTotals();
    this._saveDraft();
  },

  _syncTotals() {
    this.totalBooks    = Sessions.getTotalBooks();
    this.totalPoints   = Sessions.getTotalPoints();
    this.suggestedCents = Sessions.getSuggestedCents();
    // Re-hydrate bookGroups with updated qtys so Sprae re-renders
    this.bookGroups = this.bookGroups.map(group => ({
      ...group,
      books: group.books.map(b => ({ ...b, qty: Sessions.getQty(b.id) })),
    }));
    if (this.searchQuery) this._runSearch();
  },

  // Totals-only refresh for the numeric qty input: updates the scalar totals
  // WITHOUT rebuilding bookGroups (which would re-render the list and reset the
  // input's cursor while typing). Sessions stays the source of truth.
  _syncTotalsOnly() {
    this.totalBooks     = Sessions.getTotalBooks();
    this.totalPoints    = Sessions.getTotalPoints();
    this.suggestedCents = Sessions.getSuggestedCents();
  },

  // ── Draft persistence (crash-proof in-progress count) ──
  // The in-progress count is mirrored to localStorage on every change so a page
  // reload or tab eviction (iOS Safari on screen-lock) can't wipe it. Per the
  // safety rule, the draft is removed ONLY after a session is confirmed submitted
  // to Goloka (see submitSession's success branch) — never on start/reset/offline.

  _saveDraft() {
    const draft = {
      step:             this.step,
      selectedLanguage: this.selectedLanguage,
      sessionLocation:  this.sessionLocation,
      sessionNote:      this.sessionNote,
      methodDollars:    this.methodDollars,
      totalDollars:     this.totalDollars,
      selectedMethod:   this.selectedMethod,
      splitOpen:        this.splitOpen,
      entries:          Sessions.entries,
      idempotencyKey:   Sessions.getIdempotencyKey(),
      saved_at:         new Date().toISOString(),
    };
    try {
      localStorage.setItem(CONFIG.STORAGE_KEYS.DRAFT, JSON.stringify(draft));
      if (this.storageError) this.storageError = false;
    } catch (_) {
      this.storageError = true;   // fail loud — never lose a count silently
    }
  },

  _clearDraft() {
    try { localStorage.removeItem(CONFIG.STORAGE_KEYS.DRAFT); } catch (_) {}
  },

  // Surface archive save problems — pruning or failure must never be silent.
  _reportArchive(status) {
    if (status === 'pruned') {
      this.archiveWarning = '⚠ Device archive is full — oldest submitted sessions were removed to make space. Consider backing up soon.';
    } else if (status === 'error') {
      this.archiveWarning = '⚠ Could not keep a copy of the submitted session on this device (storage full).';
    }
  },

  // Restore a saved in-progress count after a reload/eviction. Returns true if a
  // draft with recorded books was recovered.
  _restoreDraft() {
    let draft;
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.DRAFT);
      if (!raw) return false;
      draft = JSON.parse(raw);
    } catch (_) { return false; }
    if (!draft || !Array.isArray(draft.entries) || draft.entries.length === 0) return false;

    // If this draft's session is already recorded somewhere durable (queued in
    // PENDING or archived after a confirmed submit), restoring it would resurrect
    // an already-recorded count. The data is safe elsewhere — discard the draft
    // and say so, instead of risking a confusing duplicate.
    if (draft.idempotencyKey && Sessions.hasRecordOf(draft.idempotencyKey)) {
      this._clearDraft();
      this._showToast('Previous count was already submitted — starting fresh.');
      return false;
    }

    // Rehydrate the session into memory
    Sessions.entries = draft.entries;
    if (draft.idempotencyKey) Sessions.idempotencyKey = draft.idempotencyKey;

    // Restore wizard context
    this.sessionLocation = draft.sessionLocation || '';
    this.sessionNote     = draft.sessionNote     || '';
    if (draft.methodDollars)    this.methodDollars    = draft.methodDollars;
    if (draft.selectedLanguage) this.selectedLanguage = draft.selectedLanguage;
    if (draft.selectedMethod)   this.selectedMethod   = draft.selectedMethod;
    this.totalDollars = draft.totalDollars || '';
    // Fall back to inferring the split view from the amounts themselves, so a
    // draft written before these fields existed still restores coherently.
    const funded = Object.values(draft.methodDollars || {}).filter(v => _toCents(v) > 0).length;
    this.splitOpen      = draft.splitOpen ?? funded > 1;
    this.allMethodsOpen = this.splitOpen;

    // Rebuild the book list for the saved language and overlay the saved qtys
    this._rebuildGroups();
    this._syncTotals();
    this._syncCollected();

    // Land the user back where they were
    this.goto(draft.step === 'collection' ? 'collection' : 'books');
    this._showToast('✓ Recovered your in-progress count.');
    return true;
  },

  // Set a book's qty from the free-text numeric field (digits only).
  setBookQty(book, value) {
    const digits = String(value).replace(/\D+/g, '');
    const qty = digits ? parseInt(digits, 10) : 0;
    Sessions.setQty(book.id, qty, book);
    this._syncTotalsOnly();
    this._saveDraft();
    if (!book.is_stack && typeof book.stock === 'number' && qty > book.stock) {
      this._showToast(`Warning: "${book.title}" is over stock (${book.stock}). Distribution will still be recorded.`);
    }
  },

  _refreshLanguages() {
    this.bookLanguages = Catalog.languages();
    if (!this.selectedLanguage || !this.bookLanguages.includes(this.selectedLanguage)) {
      this.selectedLanguage = this.bookLanguages[0] || '';
    }
    this._rebuildGroups();
  },

  _rebuildGroups() {
    this.bookGroups = Catalog.groupedBooks(this.selectedLanguage, this.sizeOrder);
    if (this.searchQuery) this._runSearch();
  },

  onSearchInput(e) {
    this.searchQuery = e.target.value;
    this._runSearch();
  },

  clearSearch() {
    this.searchQuery   = '';
    this.searchResults = [];
  },

  _runSearch() {
    this.searchResults = Catalog.search(this.searchQuery)
      .map(b => ({ ...b, qty: Sessions.getQty(b.id) }));
  },

  toggleSizeOrder() {
    this.sizeOrder = this.sizeOrder === 'desc' ? 'asc' : 'desc';
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.SIZE_ORDER, this.sizeOrder); } catch (_) {}
    this._rebuildGroups();
    this._syncTotals();
  },

  setLanguage(lang) {
    this.selectedLanguage = lang;
    this.langSheetOpen    = false;
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.LANGUAGE, lang); } catch (_) {}
    this._rebuildGroups();
    this._syncTotals();
    this._saveDraft();
  },

  // English/French/Spanish are permanent; a fourth pill appears when the
  // selected language isn't one of them.
  primaryLanguages() {
    const anchors = ANCHOR_LANGUAGES.filter(l => this.bookLanguages.includes(l));
    if (this.selectedLanguage && !anchors.includes(this.selectedLanguage)) {
      return [...anchors, this.selectedLanguage];
    }
    return anchors;
  },

  overflowLanguages() {
    const top = this.primaryLanguages();
    return this.bookLanguages.filter(l => !top.includes(l));
  },

  openLangSheet()  { this.langSheetOpen = true; },
  closeLangSheet() { this.langSheetOpen = false; },

  langLabel(lang) {
    return LANG_LABELS[String(lang).toLowerCase()] || lang;
  },

  // ── Book row display ───────────────────────────────────
  // One meta line per row: price, then availability. Titles with no price show
  // availability alone — a missing price is a catalog gap, not a reason to hide
  // a book that is being handed out.

  bookMeta(book) {
    const parts = [];
    if (book.retail_price_cents) parts.push('$' + (book.retail_price_cents / 100).toFixed(0));
    if (book.is_stack) {
      // Say "stack of 10", not "10 books": one tap on this row adds ten to the
      // total, and a bare book count made that jump look like a miscount.
      parts.push('stack of ' + book.books_per_unit);
    } else if (typeof book.stock === 'number') {
      // Depth matters: −1 is drift, −10 means the recorded stock is wrong.
      if (book.stock < 0)       parts.push('out of stock (−' + Math.abs(book.stock) + ')');
      else if (book.stock === 0) parts.push('out of stock');
      else if (book.stock <= 3) parts.push('last ' + book.stock);
      else                      parts.push(String(book.stock));
    }
    return parts.join(' · ');
  },

  // Dimmed, but "+" stays live: an inaccurate stock count is recoverable,
  // a lost count is not.
  bookOut(book) {
    return !book.is_stack && typeof book.stock === 'number' && book.stock <= 0;
  },

  // ── Session summary ────────────────────────────────────
  // Exactly what will be POSTed, one row per counted title. Stacks are why it
  // exists: one tap adds books_per_unit, so the total can outrun the taps.

  sessionLines() {
    return Sessions.entries
      .filter(e => e.qty > 0)
      .map(e => {
        const per = e.books_per_unit || 1;
        // Drafts written before language was snapshotted fall back to the catalog.
        const lang = e.language || Catalog.books.find(b => b.id === e.book_id)?.language || '';
        return {
          title:  e.title,
          language: lang ? this.langLabel(lang) : '',
          // Soft and hard variants share a title, so the summary needs the same
          // disambiguation the picker rows carry.
          cover:  COVER_LABELS[String(e.category || '')[0]] ? COVER_LABELS[String(e.category)[0]].toUpperCase() : '',
          qty:    e.qty,
          per,
          books:  e.qty * per,
          points: Math.round(e.qty * (e.points_per_unit || 0) * 100) / 100,
          isStack: per > 1,
        };
      })
      .sort((a, b) => b.books - a.books);
  },

  openSummary()  { this.summaryOpen = true;  this.clearConfirm = false; },
  closeSummary() { this.summaryOpen = false; this.clearConfirm = false; },

  askClearCount()    { this.clearConfirm = true; },
  cancelClearCount() { this.clearConfirm = false; },

  // Escape hatch for a wrong count — otherwise the only way back to zero was
  // decrementing every row by hand.
  clearCount() {
    const cleared = this.totalBooks;
    this.clearConfirm = false;
    Sessions.clear();
    this._clearDraft();
    this.summaryOpen = false;
    this.bookGroups = this.bookGroups.map(group => ({
      ...group,
      books: group.books.map(b => ({ ...b, qty: 0 })),
    }));
    this._syncTotals();
    this.goto('books');
    this._showToast(`Count cleared — ${cleared} book(s) removed.`);
  },

  // ── Collection ─────────────────────────────────────────

  gotoCollection() {
    if (this.totalBooks === 0) return;
    this._syncCollected();
    this._saveDraft();
    this.goto('collection');
    setTimeout(() => {
      const input = document.querySelector('.method-input-wrap .actual-input');
      if (input) { input.focus(); input.select(); }
    }, 100);
  },

  onLocationInput(e) {
    this.sessionLocation = e.target.value;
    this._saveDraft();
  },

  onNoteInput(e) {
    this.sessionNote = e.target.value;
    this._saveDraft();
  },

  // Total collected = sum of every method input. Invoked from the method inputs'
  // :oninput as a scope method so `this` is the Sprae state (mirrors _syncTotals).
  _syncCollected() {
    let total = 0;
    for (const k in this.methodDollars) total += _toCents(this.methodDollars[k]);
    this.collectedCents = total;
  },

  // ── Amount & method ────────────────────────────────────
  // One amount by one method is the default; splitting is opt-in.

  visibleMethods() {
    return this.allMethodsOpen ? this.paymentMethods : this.paymentMethods.slice(0, PRIMARY_PAYMENT_COUNT);
  },

  hiddenMethodCount() {
    return this.allMethodsOpen ? 0 : this.paymentMethods.length - PRIMARY_PAYMENT_COUNT;
  },

  showAllMethods() { this.allMethodsOpen = true; },

  onTotalInput(e) {
    this.totalDollars = e.target.value;
    this._applySingleAmount();
    this._saveDraft();
  },

  selectMethod(method) {
    this.selectedMethod = method;
    if (!this.splitOpen) this._applySingleAmount();
    this._saveDraft();
  },

  // Non-split: the whole amount belongs to one method.
  _applySingleAmount() {
    const next = {};
    for (const k of Object.keys(this.methodDollars)) next[k] = '';
    next[this.selectedMethod] = this.totalDollars;
    this.methodDollars = next;
    this._syncCollected();
  },

  toggleSplit() {
    if (this.splitOpen) {
      // Collapse folds the split into the selected method so the total holds.
      this.totalDollars = this.collectedCents ? (this.collectedCents / 100).toFixed(2) : '';
      this.splitOpen = false;
      this._applySingleAmount();
    } else {
      this.splitOpen = true;
      this.allMethodsOpen = true;
    }
    this._saveDraft();
  },

  onMethodInput(e, method) {
    this.methodDollars[method] = e.target.value;
    this._syncCollected();
    this._saveDraft();
  },

  // ── Location ───────────────────────────────────────────
  // Spots the whole temple has used recently, from goloka, so a devotee heading
  // to a street or festival someone else covered gets the same chip. Falls back
  // to this device's archive offline.

  recentLocations() {
    if (this.templeLocations.length > 0) return this.templeLocations;
    const seen = [];
    for (const entry of Sessions.getRecent()) {
      const loc = ((entry.payload && entry.payload.location) || '').trim();
      if (loc && !seen.includes(loc)) seen.push(loc);
      if (seen.length >= 4) break;
    }
    return seen;
  },

  setLocation(loc) {
    this.sessionLocation = this.sessionLocation === loc ? '' : loc;
    this.locationOpen = false;
    this._saveDraft();
  },

  openLocationInput() { this.locationOpen = true; },

  // ── Submission ─────────────────────────────────────────

  async submitSession() {
    if (this.submitting) return;

    // Writing requires sankirtan:create (sankirtan:view is read-only). Catch it
    // here with a clear message instead of letting the API return a bare 403.
    if (!auth.can('sankirtan:create')) {
      this._showToast('This account can only view — ask your sankirtan leader for the Book Distributor role to submit sessions.');
      return;
    }

    this._syncCollected();

    if (this.totalBooks === 0) {
      this._showToast('Count at least one book before submitting.');
      return;
    }

    // $0 is allowed: goloka accepts a session with no payment lines.

    // One payment line per method with a positive amount; collected_cents is
    // derived server-side as the sum of these lines.
    const payments = [];
    for (const m of Object.keys(this.methodDollars)) {
      const cents = _toCents(this.methodDollars[m]);
      if (cents > 0) payments.push({ method: m, amount_cents: cents });
    }

    // No distributor field: Goloka attributes the session to the JWT user.
    const payload = {
      occurred_at: _todayISO(),
      location:    this.sessionLocation.trim() || undefined,
      note:        this.sessionNote.trim() || undefined,
      books:       Sessions.toApiBooks(),
      payments,
    };

    const key = Sessions.getIdempotencyKey();

    this.submitting = true;
    const booksSubmitted = this.totalBooks;
    try {
      const result = await DB.postSession(payload, key);
      // Archive the acked session (payload + key kept on-device forever) so the
      // POS can always re-push ALL books distributed if Goloka ever loses data.
      this._reportArchive(Sessions.saveRecent(result, payload, key));
      this.archiveCount = Sessions.getRecent().length;
      Sessions.clear();
      this._clearDraft();   // the count is in Goloka AND in the on-device archive
      this.confirmResult    = result;
      this.confirmCollected = '$' + (this.collectedCents / 100).toFixed(2);
      this.lastDevotee      = this.userName;
      this.goto('confirm');
      this._startConfirmCountdown();
      this._showToast(`✓ ${booksSubmitted} book(s) registered in Goloka — copy kept on this device.`);
      // Refresh catalog so next session sees the decremented stock.
      Catalog.loadBooks(true).then(() => this._refreshLanguages());
      this.loadHomeStats();   // the submission just changed rank, streak and totals
    } catch (err) {
      console.warn('[DB] postSession failed:', err.message);
      Sessions.savePending(payload, key, auth.userId);
      this.pendingCount = Sessions.getPending().length;
      this.isOffline    = true;
      if (err.authExpired) {
        // Session expired mid-submit: the count is queued under this user and
        // will flush automatically right after they sign back in.
        this.pendingError = '';
        this._showToast(`✗ Signed out — ${booksSubmitted} book(s) kept SAFE on this device. Sign in to submit.`);
        this._showLogin();
      } else if (err.status) {
        // "Server said no" (status set) vs "network down" (no status).
        this.pendingError = `${err.message} (HTTP ${err.status})`;
        this._showToast(`✗ Goloka rejected the session: ${err.message} — ${booksSubmitted} book(s) kept SAFE on this device.`);
      } else {
        this.pendingError = '';
        this._showToast(`✗ Goloka unreachable — ${booksSubmitted} book(s) kept SAFE on this device. Will resubmit automatically.`);
      }
    }
    this.submitting = false;
  },

  // ── Confirmation countdown ─────────────────────────────

  _startConfirmCountdown() {
    clearInterval(_confirmTimer);
    this.confirmCountdown = 5;
    _confirmTimer = setInterval(() => {
      this.confirmCountdown -= 1;
      if (this.confirmCountdown <= 0) {
        clearInterval(_confirmTimer);
        this._resetToLanding();
      }
    }, 1000);
  },

  _resetToLanding() {
    this.sessionLocation  = '';
    this.sessionNote      = '';
    this.methodDollars    = { Cash: '', Card: '', Cheque: '', Interac: '', 'Bank Transfer': '', Other: '' };
    this.collectedCents   = 0;
    this.totalDollars     = '';
    this.splitOpen        = false;
    this.allMethodsOpen   = false;
    this.locationOpen     = false;
    this.clearConfirm     = false;
    this.confirmResult    = null;
    this.confirmCountdown = 0;
    this.goto('landing');
  },

  // ── Pending retry ──────────────────────────────────────

  async retryPending() {
    const pending = Sessions.getPending();
    if (pending.length === 0) { this.pendingCount = 0; this.pendingError = ''; return; }

    let succeeded = 0;
    let foreign   = 0;
    let lastErr   = null;
    for (const item of pending) {
      // The server attributes every submission to whoever holds the JWT, so a
      // session queued by a different user must wait for its owner to sign in.
      // Legacy items queued before the login rollout carry no user_id and flush
      // under the current user.
      if (item.user_id && auth.userId && item.user_id !== auth.userId) { foreign++; continue; }
      // Legacy pending items queued before the idempotency rollout don't carry
      // a key. Mint one inline so the request can flow through Goloka's new
      // required-header check; otherwise the row would be stuck forever.
      const key = item.idempotency_key || crypto.randomUUID();
      try {
        const result = await DB.postSession(item.payload, key);
        this._reportArchive(Sessions.saveRecent(result, item.payload, key));
        Sessions.removePending(item.id);
        succeeded++;
      } catch (err) {
        console.warn('[Retry] Failed for id', item.id, err.message);
        lastErr = err;
        if (err.authExpired) break;   // no point retrying the rest without a session
      }
    }

    this.pendingCount = Sessions.getPending().length;
    this.archiveCount = Sessions.getRecent().length;
    if (this.pendingCount === 0) { this.isOffline = false; this.pendingError = ''; }
    else if (lastErr) {
      this.pendingError = lastErr.status
        ? `${lastErr.message} (HTTP ${lastErr.status})`
        : lastErr.message;
    }

    if (lastErr && lastErr.authExpired) {
      this._showToast('✗ Signed out — queued session(s) kept on this device. Sign in to submit.');
      this._showLogin();
      return;
    }
    if (succeeded > 0 && this.pendingCount === 0) {
      this._showToast(`✓ ${succeeded} queued session(s) now registered in Goloka.`);
    } else if (succeeded > 0) {
      this._showToast(`✓ ${succeeded} now registered in Goloka, ${this.pendingCount} still kept on this device — see banner.`);
    } else if (foreign > 0 && foreign === pending.length) {
      this._showToast(`${foreign} pending session(s) belong to another account — that devotee must sign in to submit them.`);
    } else if (lastErr) {
      const detail = lastErr.status ? `${lastErr.message} (HTTP ${lastErr.status})` : lastErr.message;
      this._showToast(`✗ Retry failed: ${detail}`);
    } else {
      this._showToast('✗ Still offline — will retry later.');
    }
  },

  // Wipe the pending queue. For when a queued payload is permanently rejected
  // by Goloka (schema drift, deleted distributor, etc.) and the user has
  // accepted the donation is lost from the POS's perspective.
  discardPending() {
    Sessions.getPending().forEach(p => Sessions.removePending(p.id));
    this.pendingCount = 0;
    this.pendingError = '';
    this.isOffline    = false;
    this._showToast('Pending session(s) discarded.');
  },

  // ── Home stats ─────────────────────────────────────────
  // Derived from two endpoints the POS already reads. Never awaited: the
  // landing screen must work before these resolve, or offline.

  async loadHomeStats() {
    if (this.statsLoading) return;
    this.statsLoading = true;
    const me = this.userName;

    const [year, month, sessions, templeSessions] = await Promise.all([
      DB.getLeaderboard('year').catch(() => null),
      DB.getLeaderboard('month').catch(() => null),
      DB.getSessions({ distributor: me, from: _daysAgoISO(90) }).catch(() => null),
      DB.getSessions({ from: _daysAgoISO(30) }).catch(() => null),
    ]);

    // Home stats are personal — split groups so my own totals show, not my group's.
    if (year && Array.isArray(year.results)) {
      const rows = _splitGroups(year.results).sort((a, b) => b.points - a.points);
      const i = rows.findIndex(r => this.isMe(r));
      const mine = i === -1 ? null : rows[i];
      this.myBooksYear  = mine ? mine.books : 0;
      this.myPointsYear = mine ? Math.round(mine.points * 100) / 100 : 0;
      this.myRank       = i === -1 ? 0 : i + 1;
    }

    if (month && Array.isArray(month.results)) {
      this.templeBooksMonth    = month.results.reduce((s, r) => s + (r.books || 0), 0);
      this.templeDevoteesMonth = _splitGroups(month.results).length;
    }

    if (Array.isArray(sessions)) {
      const mySessions = sessions.filter(s => s.distributor_name === me);
      const last = mySessions[0];
      this.lastSessionLabel = last ? _relativeDay(last.occurred_at) : '';
      this.lastSessionBooks = last ? last.total_books : 0;
      this.streakDays       = _streakDays(mySessions.map(s => s.occurred_at));
    }

    if (Array.isArray(templeSessions)) {
      const seen = [];
      for (const session of templeSessions) {
        const loc = (session.location || '').trim();
        if (loc && !seen.includes(loc)) seen.push(loc);
        if (seen.length >= 4) break;
      }
      this.templeLocations = seen;
    }

    this.statsLoading = false;
  },

  // ── Leaderboard ────────────────────────────────────────

  gotoLeaderboard() {
    this.goto('leaderboard');
    this.loadLeaderboard();
  },

  async loadLeaderboard() {
    this.leaderboardLoading = true;
    this.leaderboardRows    = [];
    try {
      // A past month has no endpoint of its own — aggregate its sessions into
      // the same row shape the leaderboard endpoint returns.
      let rows;
      if (this.leaderboardPeriod === 'month' && this.monthOffset > 0) {
        const { from, to } = _monthRange(this.monthOffset);
        rows = _aggregateSessions(await DB.getSessions({ from, to }) || []);
      } else {
        rows = (await DB.getLeaderboard(this.leaderboardPeriod)).results;
      }
      this.leaderboardRawRows = rows;
      this.expandedGroups     = [];
      this._applyLeaderboardView();   // derives the rows, then sorts and ranks them
    } catch (err) {
      console.warn('[Leaderboard] Failed:', err.message);
      this._showToast('Could not load leaderboard: ' + err.message);
    }
    this.leaderboardLoading = false;
  },

  setPeriod(period) {
    this.leaderboardPeriod = period;
    this.showAllLeaders    = false;
    if (period !== 'month') this.monthOffset = 0;
    this.loadLeaderboard();
  },

  // ── Group / individual view ────────────────────────────

  _applyLeaderboardView() {
    this.leaderboardRows = this.leaderboardView === 'individual'
      ? _splitGroups(this.leaderboardRawRows)
      : this.leaderboardRawRows;
    this.applyLeaderboardSort();
  },

  setLeaderboardView(view) {
    if (this.leaderboardView === view) return;
    this.leaderboardView = view;
    this.expandedGroups  = [];
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.LB_VIEW, view); } catch (_) {}
    this._applyLeaderboardView();
  },

  hasGroups() {
    return this.leaderboardRawRows.some(r => r.is_group);
  },

  isGroupExpanded(row) {
    return this.expandedGroups.includes(row.distributor_name);
  },

  toggleGroup(row) {
    if (!row.is_group) return;
    const name = row.distributor_name;
    this.expandedGroups = this.isGroupExpanded(row)
      ? this.expandedGroups.filter(n => n !== name)
      : [...this.expandedGroups, name];
  },

  // Concrete beats relative: "August" and "2026" say what you are looking at,
  // where "This Month" / "This Year" need a second of thought.
  periodLabel(period) {
    if (period === 'month') return _monthRange(this.monthOffset).label;
    if (period === 'year')  return String(new Date().getFullYear());
    return 'All time';
  },

  // Step back through months; never past the current one.
  stepMonth(delta) {
    const next = this.monthOffset + delta;
    if (next < 0) return;
    this.monthOffset       = next;
    this.leaderboardPeriod = 'month';
    this.showAllLeaders    = false;
    this.loadLeaderboard();
  },

  // Rows carry the distributor's user id; match on that, since a devotee folded
  // into a group no longer appears under their own name.
  isMe(row) {
    const id = Number(auth.userId);
    if (id && row.distributor_id) return row.distributor_id === id;
    return row.distributor_name === this.userName;
  },

  myLeaderRow() {
    return this.leaderboardRows.find(r => this.isMe(r)) || null;
  },

  // The group I distribute under, when the board is merged and I'm inside one.
  myGroupRow() {
    if (this.leaderboardView !== 'group') return null;
    return this.leaderboardRows.find(r => r.is_group && (r.members || []).some(m => this.isMe(m))) || null;
  },

  // My own totals, whether or not a group is hiding them.
  myOwnRow() {
    const group = this.myGroupRow();
    if (group) return group.members.find(m => this.isMe(m)) || null;
    return this.myLeaderRow();
  },

  // The ranked row I sit in: my own, or the group standing in for me.
  myRankRow() {
    return this.myLeaderRow() || this.myGroupRow();
  },

  topLeaders() {
    return this.showAllLeaders ? this.leaderboardRows : this.leaderboardRows.slice(0, 8);
  },

  hiddenLeaderCount() {
    return Math.max(0, this.leaderboardRows.length - this.topLeaders().length);
  },

  revealAllLeaders() { this.showAllLeaders = true; },

  openBbtInfo()  { this.bbtInfoOpen = true; },
  closeBbtInfo() { this.bbtInfoOpen = false; },

  leaderboardBooks() {
    return this.leaderboardRows.reduce((s, r) => s + (r.books || 0), 0);
  },

  // Counts devotees, not group rows, so the caption reads the same in both views.
  leaderboardDevotees() {
    return _splitGroups(this.leaderboardRawRows).length;
  },

  // Intuitive first-click direction: names A→Z; "more is better" metrics high→low;
  // BBT % low→high (lower = more goes to the temple).
  lbDefaultDir(col) { return (col === 'distributor_name' || col === 'bbt_pct') ? 'asc' : 'desc'; },

  lbSortArrow(col) {
    if (this.leaderboardSortBy !== col) return '';
    return this.leaderboardSortDir === 'asc' ? ' ↑' : ' ↓';
  },

  sortLeaderboard(col) {
    if (this.leaderboardSortBy === col) this.leaderboardSortDir = this.leaderboardSortDir === 'asc' ? 'desc' : 'asc';
    else { this.leaderboardSortBy = col; this.leaderboardSortDir = this.lbDefaultDir(col); }
    this.applyLeaderboardSort();
  },

  applyLeaderboardSort() {
    const col = this.leaderboardSortBy, dir = this.leaderboardSortDir === 'asc' ? 1 : -1;
    const sorted = [...this.leaderboardRows].sort((a, b) => {
      let av = a[col], bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;            // null bbt_pct ("—") always last, both directions
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir;
    });
    this.leaderboardRows = sorted.map((r, i) => ({ ...r, rank: i + 1 }));  // new array → Sprae re-renders
  },

  // ── Auth ───────────────────────────────────────────────
  // Mirrors Mandir's login flow: email first; the server answers with
  // `password_required` or `otp_required` (or a token directly for trusted
  // devices), and Google is a one-tap alternative.

  _showLogin() {
    this.authStep      = 'email';
    this.authPassword  = '';
    this.authOtp       = '';
    this.emailFormOpen = false;
    this.goto('login');
  },

  openEmailForm()  { this.emailFormOpen = true;  this.authError = ''; },
  closeEmailForm() { this.emailFormOpen = false; this.authError = ''; },

  // "Different email" / "Start over" from the password and OTP steps return to
  // the email field, not to the Google-first screen the devotee already left.
  restartEmail() {
    this.authStep      = 'email';
    this.authPassword  = '';
    this.authOtp       = '';
    this.emailFormOpen = true;
    this.authError     = '';
  },

  async authSubmitEmail() {
    if (this.authLoading || !this.authEmail.trim()) return;
    this.authError   = '';
    this.authLoading = true;
    try {
      const res = await DB.login(this.authEmail.trim(), '');
      if (res.step === 'password_required')  this.authStep = 'password';
      else if (res.step === 'otp_required')  this.authStep = 'otp';
      else if (res.token) {
        auth.save(res.token, res.user, res.refresh_token);
        await this._postLogin();
      }
    } catch (err) {
      this.authError = err.message || 'Sign in failed';
    }
    this.authLoading = false;
  },

  async authSubmitPassword() {
    if (this.authLoading) return;
    this.authError   = '';
    this.authLoading = true;
    try {
      const res = await DB.login(this.authEmail.trim(), this.authPassword);
      if (res.step === 'otp_required') this.authStep = 'otp';
      else if (res.token) {
        auth.save(res.token, res.user, res.refresh_token);
        await this._postLogin();
      }
    } catch (err) {
      this.authError = err.message || 'Sign in failed';
    }
    this.authLoading = false;
  },

  async authVerifyOtp() {
    if (this.authLoading) return;
    this.authError   = '';
    this.authLoading = true;
    try {
      const res = await DB.verifyOtp(this.authEmail.trim(), this.authOtp.trim());
      auth.save(res.token, res.user, res.refresh_token);
      await this._postLogin();
    } catch (err) {
      this.authError = err.message || 'Verification failed';
    }
    this.authLoading = false;
  },

  async authGoogle() {
    this.authError = '';
    try {
      const { url } = await DB.googleUrl();
      window.location.href = url;
    } catch (err) {
      this.authError = 'Could not connect to server';
    }
  },

  async logout() {
    await DB.logout();          // best-effort refresh-token revocation
    auth.clear();               // auth keys only — queue/archive/draft survive
    this.userName = '';
    this._showLogin();
  },

  // ── Re-push (disaster recovery) ────────────────────────
  // Re-send EVERY session this device knows about (queued + archived) with its
  // original idempotency key. Goloka computes the delta: sessions it already has
  // are replayed (no duplicate row, no double stock decrement); sessions it lost
  // (e.g. DB restored from an older backup) are recreated. Safe to run anytime.

  async repushAll() {
    if (this.repushing) return;
    this.repushing    = true;
    this.repushStatus = 'Re-sending all sessions to Goloka…';

    let already = 0, recovered = 0, failed = 0, skipped = 0;

    // 1) Pending first — these were never acked at all. Another user's queued
    //    sessions are left for their owner (server attributes to the JWT user).
    for (const item of Sessions.getPending()) {
      if (item.user_id && auth.userId && item.user_id !== auth.userId) { skipped++; continue; }
      const key = item.idempotency_key || crypto.randomUUID();
      try {
        const { result, replayed } = await DB.repostSession(item.payload, key);
        this._reportArchive(Sessions.saveRecent(result, item.payload, key));
        Sessions.removePending(item.id);
        replayed ? already++ : recovered++;
      } catch (err) {
        console.warn('[Repush] pending failed:', err.message);
        failed++;
      }
    }

    // 2) Archived sessions, oldest first. Entries predating the archive update
    //    have no stored payload and can't be re-sent — reported, not hidden.
    for (const entry of Sessions.getRecent().slice().reverse()) {
      if (!entry.payload || !entry.idempotency_key) { skipped++; continue; }
      try {
        const { result, replayed } = await DB.repostSession(entry.payload, entry.idempotency_key);
        // Header can be CORS-hidden — fall back to comparing session ids
        // (a replay returns the original id; a recreation gets a new one).
        const isReplay = replayed || (entry.id != null && result && result.id === entry.id);
        isReplay ? already++ : recovered++;
      } catch (err) {
        console.warn('[Repush] archived failed:', err.message);
        failed++;
      }
    }

    this.pendingCount = Sessions.getPending().length;
    if (this.pendingCount === 0 && failed === 0) { this.isOffline = false; this.pendingError = ''; }
    this.archiveCount = Sessions.getRecent().length;

    const total = already + recovered + failed;
    let msg;
    if (total === 0 && skipped === 0) {
      msg = 'Nothing to re-send — no sessions stored on this device yet.';
    } else if (failed === 0 && recovered === 0) {
      msg = `✓ All ${already} session(s) already in Goloka — nothing was lost.`;
    } else {
      msg = `✓ ${already} already registered · ${recovered} recovered · ${failed} failed.`;
    }
    if (skipped > 0) msg += ` (${skipped} session(s) skipped: no stored copy, or queued by another account.)`;
    this.repushStatus = msg;
    this._showToast(msg);
    this.repushing = false;
  },

  // ── Toast ──────────────────────────────────────────────

  _showToast(msg) {
    this.toastText    = msg;
    this.toastVisible = true;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { this.toastVisible = false; }, 4500);
  },

  // ── Init ───────────────────────────────────────────────

  async init() {
    // Returning from the Google OAuth redirect lands here with #token=… in the
    // URL fragment; capture() stores it and scrubs the fragment from history.
    auth.capture();
    const authMsg = auth.takeMessage();
    if (!auth.active) {
      this._showLogin();
      this.authError = authMsg;
      return;
    }
    await this._postLogin();
  },

  // Everything that needs a logged-in user: permission gate, catalog load,
  // draft recovery, and the pending-queue flush.
  async _postLogin() {
    if (!auth.can('sankirtan:view')) {
      auth.clear();
      this._showLogin();
      this.authError = 'This account has no book-distribution access — ask your sankirtan leader for the Book Distributor role.';
      return;
    }
    this.userName = auth.displayName();
    this.goto('landing');

    this.catalogLoading = true;
    const bookResult = await Catalog.loadBooks(true);
    this._refreshLanguages();
    this.catalogLoading = false;

    // Recover any in-progress count that survived a reload / tab eviction
    // (iOS Safari discards backgrounded tabs on screen-lock).
    this._restoreDraft();

    if (bookResult.source === 'empty') {
      this.catalogNotice = 'Could not load book catalog — check your connection.';
    }

    // Count pending submissions and the on-device submitted archive, then
    // flush anything queued (e.g. sessions saved while signed out).
    this.pendingCount = Sessions.getPending().length;
    this.archiveCount = Sessions.getRecent().length;
    if (this.pendingCount > 0) {
      this.isOffline = true;
      this.retryPending();
    }

    this.loadHomeStats();   // not awaited — the home screen fills in as it lands
  },

  // Initials for the header avatar: first letters of the display name. "+" splits
  // too — logins before goloka's %20 fix cached names like "Luv+Prabhu".
  userInitials() {
    return (this.userName || '')
      .split(/[\s&+]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(w => w[0].toUpperCase())
      .join('');
  },
});

// Boot
document.addEventListener('DOMContentLoaded', () => state.init());

// ── Auto-sync ──────────────────────────────────────────────
// Flush the pending queue whenever the device regains connectivity, so a queued
// session doesn't sit until someone taps "Retry". Each pending item carries an
// idempotency key, so a re-send can never create a duplicate row in Goloka.
let _autoSyncing = false;
async function _autoSync() {
  if (_autoSyncing || !navigator.onLine || state.pendingCount === 0) return;
  _autoSyncing = true;
  try { await state.retryPending(); }
  finally { _autoSyncing = false; }
}
window.addEventListener('online', () => { _autoSync(); state.refreshCatalog(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { _autoSync(); state.refreshCatalog(); }
  // 'hidden' fires right before iOS Safari backgrounds/evicts the tab on
  // screen-lock — flush the in-progress count to disk before it can be lost.
  else state._saveDraft();
});
// pagehide is the last reliable beat before the page is frozen/discarded.
window.addEventListener('pagehide', () => state._saveDraft());