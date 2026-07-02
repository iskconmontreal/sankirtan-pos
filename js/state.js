/* Sankirtan POS — Reactive State (Sprae)
   Multi-step wizard: landing → devotee → books → collection → confirm → leaderboard | admin
*/

import sprae from 'https://cdn.jsdelivr.net/npm/sprae/+esm';
import { CONFIG, LANG_LABELS, PAYMENT_METHODS } from './config.js';
import { Catalog } from './catalog.js';
import { Sessions } from './sessions.js';
import { DB } from './db.js';

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

function _loadStoredConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.CONFIG) || '{}'); }
  catch (_) { return {}; }
}

function _applyStoredConfig() {
  const saved = _loadStoredConfig();
  if (saved.goloka_url) CONFIG.GOLOKA_URL          = saved.goloka_url;
  if (saved.write_key)  CONFIG.SANKIRTAN_WRITE_KEY = saved.write_key;
}

// ── Sprae state ────────────────────────────────────────────
export const state = sprae(document.body, {

  // Navigation
  step:      'landing',
  prevStep:  'landing',
  stepTitle: '',

  // Date
  todayLabel: _todayLabel(),

  // Devotee
  devotees:         [],
  devoteeSearch:    '',
  filteredDevotees: [],
  selectedDevotee:  '',

  // Books / catalog
  bookGroups:       [],
  bookLanguages:    [],
  selectedLanguage: '',
  catalogLoading:   false,
  catalogNotice:    '',
  totalBooks:     0,
  totalPoints:    0,
  suggestedCents: 0,

  // Collection — each method is keyed independently; the total is their sum.
  paymentMethods: PAYMENT_METHODS,
  methodDollars:  { Cash: '', Card: '', Cheque: '', Interac: '', 'Bank Transfer': '' },
  collectedCents: 0,
  sessionLocation:  '',
  sessionNote:      '',
  submitting:       false,

  // Confirmation
  confirmResult:    null,
  confirmCountdown: 0,
  confirmCollected: '',

  // Leaderboard
  leaderboardPeriod:   'month',
  leaderboardRows:     [],
  leaderboardLoading:  false,
  leaderboardSortBy:   'points',
  leaderboardSortDir:  'desc',
  lastDevotee:         '',

  // Admin
  adminGoloka:   '',
  adminWriteKey: '',
  connStatus:    '',
  connClass:     '',

  // UI
  isOffline:    false,
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
      devotee:     'landing',
      books:       'devotee',
      collection:  'books',
      confirm:     'landing',
      leaderboard: 'landing',
      admin:       'landing',
    };
    this.goto(backMap[this.step] || 'landing');
  },

  // ── Landing ────────────────────────────────────────────

  startSession() {
    Sessions.clear();
    this.selectedDevotee  = '';
    this.devoteeSearch    = '';
    this.sessionLocation  = '';
    this.filteredDevotees = this.devotees.slice();
    this.goto('devotee');
  },

  // ── Devotee picker ─────────────────────────────────────

  onDevoteeSearch(e) {
    this.devoteeSearch    = e.target.value;
    this.filteredDevotees = Catalog.filterDevotees(this.devoteeSearch);
  },

  async selectDevotee(devotee) {
    this.selectedDevotee = devotee.spiritual_name || devotee.name;
    this.goto('books');

    // Refresh book groups (reload if bookGroups is empty)
    if (this.bookGroups.length === 0) {
      await this._loadBooks();
    } else {
      // Reset qtys for a fresh session
      this.bookGroups = this.bookGroups.map(group => ({
        ...group,
        covers: group.covers.map(cover => ({
          ...cover,
          books: cover.books.map(b => ({ ...b, qty: 0 })),
        })),
      }));
    }
    this._syncTotals();
  },

  // ── Books ──────────────────────────────────────────────

  async _loadBooks() {
    this.catalogLoading = true;
    this.catalogNotice  = '';
    try {
      const result = await Catalog.loadBooks(false);
      this._refreshLanguages();
      if (result.source === 'empty') {
        this.catalogNotice = 'Could not load book catalog — configure Goloka URL and Write Key in Admin.';
      } else if (result.source === 'cache') {
        this.catalogNotice = 'Showing cached catalog.';
      }
    } catch (err) {
      this.catalogNotice = 'Could not load catalog: ' + err.message;
    }
    this.catalogLoading = false;
  },

  incQty(book) {
    const newQty = (Sessions.getQty(book.id) || 0) + 1;
    Sessions.setQty(book.id, newQty, book);
    this._syncTotals();
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
  },

  _syncTotals() {
    this.totalBooks    = Sessions.getTotalBooks();
    this.totalPoints   = Sessions.getTotalPoints();
    this.suggestedCents = Sessions.getSuggestedCents();
    // Re-hydrate bookGroups with updated qtys so Sprae re-renders
    this.bookGroups = this.bookGroups.map(group => ({
      ...group,
      covers: group.covers.map(cover => ({
        ...cover,
        books: cover.books.map(b => ({ ...b, qty: Sessions.getQty(b.id) })),
      })),
    }));
  },

  _refreshLanguages() {
    this.bookLanguages = Catalog.languages();
    if (!this.selectedLanguage || !this.bookLanguages.includes(this.selectedLanguage)) {
      this.selectedLanguage = this.bookLanguages[0] || '';
    }
    this.bookGroups = Catalog.groupedBooks(this.selectedLanguage);
  },

  setLanguage(lang) {
    this.selectedLanguage = lang;
    this.bookGroups = Catalog.groupedBooks(lang);
    this._syncTotals();
  },

  langLabel(lang) {
    return LANG_LABELS[String(lang).toLowerCase()] || lang;
  },

  // ── Collection ─────────────────────────────────────────

  gotoCollection() {
    if (this.totalBooks === 0) return;
    this._syncCollected();
    this.goto('collection');
    setTimeout(() => {
      const input = document.querySelector('.method-input-wrap .actual-input');
      if (input) { input.focus(); input.select(); }
    }, 100);
  },

  onLocationInput(e) {
    this.sessionLocation = e.target.value;
  },

  onNoteInput(e) {
    this.sessionNote = e.target.value;
  },

  // Total collected = sum of every method input. Invoked from the method inputs'
  // :oninput as a scope method so `this` is the Sprae state (mirrors _syncTotals).
  _syncCollected() {
    let total = 0;
    for (const k in this.methodDollars) total += _toCents(this.methodDollars[k]);
    this.collectedCents = total;
  },

  // ── Submission ─────────────────────────────────────────

  async submitSession() {
    if (this.submitting) return;

    this._syncCollected();

    // One payment line per method with a positive amount; collected_cents is
    // derived server-side as the sum of these lines.
    const payments = [];
    for (const m of Object.keys(this.methodDollars)) {
      const cents = _toCents(this.methodDollars[m]);
      if (cents > 0) payments.push({ method: m, amount_cents: cents });
    }

    const payload = {
      distributor_name: this.selectedDevotee,
      occurred_at:      _todayISO(),
      location:         this.sessionLocation.trim() || undefined,
      note:             this.sessionNote.trim() || undefined,
      books:            Sessions.toApiBooks(),
      payments,
    };

    const key = Sessions.getIdempotencyKey();

    this.submitting = true;
    try {
      const result = await DB.postSession(payload, key);
      Sessions.saveRecent(result);
      Sessions.clear();
      this.confirmResult    = result;
      this.confirmCollected = '$' + (this.collectedCents / 100).toFixed(2);
      this.lastDevotee      = this.selectedDevotee;
      this.goto('confirm');
      this._startConfirmCountdown();
      // Refresh catalog so next session sees the decremented stock.
      Catalog.loadBooks(true).then(() => this._refreshLanguages());
    } catch (err) {
      console.warn('[DB] postSession failed:', err.message);
      Sessions.savePending(payload, key);
      this.pendingCount = Sessions.getPending().length;
      this.isOffline    = true;
      // Distinguish "server said no" (status set) from "network down" (no status).
      if (err.status) {
        this.pendingError = `${err.message} (HTTP ${err.status})`;
        this._showToast(`✗ Goloka rejected the session: ${err.message}`);
      } else {
        this.pendingError = '';
        this._showToast('Could not reach Goloka — session saved locally. Tap Retry when back online.');
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
    this.methodDollars    = { Cash: '', Card: '', Cheque: '', Interac: '', 'Bank Transfer': '' };
    this.collectedCents   = 0;
    this.confirmResult    = null;
    this.confirmCountdown = 0;
    this.goto('landing');
  },

  // ── Pending retry ──────────────────────────────────────

  async retryPending() {
    const pending = Sessions.getPending();
    if (pending.length === 0) { this.pendingCount = 0; this.pendingError = ''; return; }

    let succeeded = 0;
    let lastErr   = null;
    for (const item of pending) {
      // Legacy pending items queued before the idempotency rollout don't carry
      // a key. Mint one inline so the request can flow through Goloka's new
      // required-header check; otherwise the row would be stuck forever.
      const key = item.idempotency_key || crypto.randomUUID();
      try {
        const result = await DB.postSession(item.payload, key);
        Sessions.saveRecent(result);
        Sessions.removePending(item.id);
        succeeded++;
      } catch (err) {
        console.warn('[Retry] Failed for id', item.id, err.message);
        lastErr = err;
      }
    }

    this.pendingCount = Sessions.getPending().length;
    if (this.pendingCount === 0) { this.isOffline = false; this.pendingError = ''; }
    else if (lastErr) {
      this.pendingError = lastErr.status
        ? `${lastErr.message} (HTTP ${lastErr.status})`
        : lastErr.message;
    }

    if (succeeded > 0 && this.pendingCount === 0) {
      this._showToast(`✓ ${succeeded} session(s) submitted successfully!`);
    } else if (succeeded > 0) {
      this._showToast(`✓ ${succeeded} submitted, ${this.pendingCount} still failing — see banner.`);
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

  // ── Leaderboard ────────────────────────────────────────

  gotoLeaderboard() {
    this.goto('leaderboard');
    this.loadLeaderboard();
  },

  async loadLeaderboard() {
    this.leaderboardLoading = true;
    this.leaderboardRows    = [];
    try {
      const data = await DB.getLeaderboard(this.leaderboardPeriod);
      const results = data.results || data || [];
      this.leaderboardRows = results;
      this.applyLeaderboardSort();   // sorts by the active column + numbers rank
    } catch (err) {
      console.warn('[Leaderboard] Failed:', err.message);
      this._showToast('Could not load leaderboard: ' + err.message);
    }
    this.leaderboardLoading = false;
  },

  setPeriod(period) {
    this.leaderboardPeriod = period;
    this.loadLeaderboard();
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

  // ── Admin ──────────────────────────────────────────────

  gotoAdmin() {
    const saved        = _loadStoredConfig();
    this.adminGoloka   = saved.goloka_url || CONFIG.GOLOKA_URL          || '';
    this.adminWriteKey = saved.write_key  || CONFIG.SANKIRTAN_WRITE_KEY || '';
    this.connStatus    = '';
    this.connClass     = '';
    this.goto('admin');
  },

  saveAdmin() {
    const cfg = {
      goloka_url: this.adminGoloka.trim(),
      write_key:  this.adminWriteKey.trim(),
    };
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.CONFIG, JSON.stringify(cfg)); }
    catch (_) {}
    CONFIG.GOLOKA_URL          = cfg.goloka_url;
    CONFIG.SANKIRTAN_WRITE_KEY = cfg.write_key;
    this.connStatus = '✓ Settings saved.';
    this.connClass  = 'success';
  },

  async testConnection() {
    if (!this.adminGoloka || !this.adminWriteKey) {
      this.connStatus = 'Enter Goloka URL and Write Key first.';
      this.connClass  = 'error';
      return;
    }
    // Temporarily apply to CONFIG for the test
    CONFIG.GOLOKA_URL          = this.adminGoloka.trim();
    CONFIG.SANKIRTAN_WRITE_KEY = this.adminWriteKey.trim();
    this.connStatus = 'Testing…';
    this.connClass  = 'loading';
    const { ok, message } = await DB.testConnection();
    this.connStatus = message;
    this.connClass  = ok ? 'success' : 'error';
  },

  // Input handlers for admin fields (so Sprae gets named methods)
  onAdminGoloka(e) { this.adminGoloka   = e.target.value; },
  onAdminKey(e)    { this.adminWriteKey = e.target.value; },

  // ── Toast ──────────────────────────────────────────────

  _showToast(msg) {
    this.toastText    = msg;
    this.toastVisible = true;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { this.toastVisible = false; }, 4500);
  },

  // ── Init ───────────────────────────────────────────────

  async init() {
    _applyStoredConfig();

    // Load distributor list and books in parallel
    this.catalogLoading = true;
    const [distResult, bookResult] = await Promise.all([
      Catalog.loadDistributors(true),
      Catalog.loadBooks(true),
    ]);
    this.devotees         = Catalog.devotees;
    this.filteredDevotees = Catalog.devotees.slice();
    this._refreshLanguages();
    this.catalogLoading   = false;

    const distEmpty = distResult.source === 'empty';
    const bookEmpty = bookResult.source === 'empty';
    if (distEmpty && bookEmpty) {
      this.catalogNotice = 'Could not reach Goloka — configure URL and Write Key in Admin.';
    } else if (distEmpty) {
      this.catalogNotice = 'Could not load devotee list — configure Goloka URL and Write Key in Admin.';
    } else if (bookEmpty) {
      this.catalogNotice = 'Could not load book catalog — configure Goloka URL and Write Key in Admin.';
    }

    // Count pending submissions
    this.pendingCount = Sessions.getPending().length;
    if (this.pendingCount > 0) this.isOffline = true;
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
window.addEventListener('online', _autoSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _autoSync();
});