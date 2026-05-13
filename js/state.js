/* Sankirtan POS — Reactive State (Sprae)
   Multi-step wizard: landing → devotee → books → collection → confirm → leaderboard | admin
*/

import sprae from 'https://cdn.jsdelivr.net/npm/sprae/+esm';
import { CONFIG } from './config.js';
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

function _loadStoredConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.CONFIG) || '{}'); }
  catch (_) { return {}; }
}

function _applyStoredConfig() {
  const saved = _loadStoredConfig();
  if (saved.goloka_url)       CONFIG.GOLOKA_URL            = saved.goloka_url;
  if (saved.write_key)        CONFIG.SANKIRTAN_WRITE_KEY   = saved.write_key;
  if (saved.devotee_sheet_url) CONFIG.DEVOTEE_SHEET_CSV_URL = saved.devotee_sheet_url;
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
  bookGroups:     [],
  catalogLoading: false,
  catalogNotice:  '',
  totalBooks:     0,
  totalPoints:    0,
  suggestedCents: 0,

  // Collection
  collectedDollars: '',
  paymentMethod:    'Cash',
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
  lastDevotee:         '',

  // Admin
  adminGoloka:      '',
  adminWriteKey:    '',
  adminDevoteeSheet: '',
  connStatus:       '',
  connClass:        '',
  sheetStatus:      '',
  sheetClass:       '',

  // UI
  isOffline:    false,
  pendingCount: 0,
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
    this.filteredDevotees = this.devotees.slice();
    this.goto('devotee');
  },

  // ── Devotee picker ─────────────────────────────────────

  onDevoteeSearch(e) {
    this.devoteeSearch    = e.target.value;
    this.filteredDevotees = Catalog.filterDevotees(this.devoteeSearch);
  },

  async selectDevotee(name) {
    this.selectedDevotee = name;
    this.goto('books');

    // Refresh book groups (reload if bookGroups is empty)
    if (this.bookGroups.length === 0) {
      await this._loadBooks();
    } else {
      // Reset qtys for a fresh session
      this.bookGroups = this.bookGroups.map(g => ({
        ...g,
        books: g.books.map(b => ({ ...b, qty: 0 })),
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
      this.bookGroups = Catalog.groupedBooks();
      if (result.source === 'sample') {
        this.catalogNotice = 'No Goloka connection — showing sample catalog. Configure in Admin.';
      } else if (result.source === 'cache') {
        this.catalogNotice = 'Showing cached catalog.';
      }
    } catch (err) {
      this.catalogNotice = 'Could not load catalog: ' + err.message;
    }
    this.catalogLoading = false;
  },

  incQty(book) {
    Sessions.setQty(book.id, (Sessions.getQty(book.id) || 0) + 1, book);
    this._syncTotals();
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
      books: group.books.map(b => ({ ...b, qty: Sessions.getQty(b.id) })),
    }));
  },

  // ── Collection ─────────────────────────────────────────

  gotoCollection() {
    if (this.totalBooks === 0) return;
    // Pre-fill collected amount from suggested
    this.collectedDollars = this.suggestedCents > 0
      ? (this.suggestedCents / 100).toFixed(2)
      : '';
    this.goto('collection');
    setTimeout(() => {
      const input = document.getElementById('collection-input');
      if (input) { input.focus(); input.select(); }
    }, 100);
  },

  onCollectionInput(e) {
    this.collectedDollars = e.target.value;
  },

  onLocationInput(e) {
    this.sessionLocation = e.target.value;
  },

  onNoteInput(e) {
    this.sessionNote = e.target.value;
  },

  setPayment(method) {
    this.paymentMethod = method;
  },

  // ── Submission ─────────────────────────────────────────

  async submitSession() {
    if (this.submitting) return;

    const collectedCents = Math.round(parseFloat(this.collectedDollars || 0) * 100);
    if (isNaN(collectedCents) || collectedCents < 0) {
      this._showToast('Please enter a valid collection amount.');
      return;
    }

    const payload = {
      distributor_name: this.selectedDevotee,
      occurred_at:      _todayISO(),
      location:         this.sessionLocation.trim() || undefined,
      payment_method:   this.paymentMethod,
      collected_cents:  collectedCents,
      note:             this.sessionNote.trim() || undefined,
      books:            Sessions.toApiBooks(),
    };

    this.submitting = true;
    try {
      const result = await DB.postSession(payload);
      Sessions.saveRecent(result);
      Sessions.clear();
      this.confirmResult    = result;
      this.confirmCollected = '$' + (collectedCents / 100).toFixed(2);
      this.lastDevotee      = this.selectedDevotee;
      this.goto('confirm');
      this._startConfirmCountdown();
    } catch (err) {
      console.warn('[DB] postSession failed:', err.message);
      Sessions.savePending(payload);
      this.pendingCount = Sessions.getPending().length;
      this.isOffline    = true;
      this._showToast('Could not reach Goloka — session saved locally. Tap Retry when back online.');
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
    this.collectedDollars = '';
    this.paymentMethod    = 'Cash';
    this.confirmResult    = null;
    this.confirmCountdown = 0;
    this.goto('landing');
  },

  // ── Pending retry ──────────────────────────────────────

  async retryPending() {
    const pending = Sessions.getPending();
    if (pending.length === 0) { this.pendingCount = 0; return; }

    let succeeded = 0;
    for (const item of pending) {
      try {
        const result = await DB.postSession(item.payload);
        Sessions.saveRecent(result);
        Sessions.removePending(item.id);
        succeeded++;
      } catch (err) {
        console.warn('[Retry] Failed for id', item.id, err.message);
      }
    }

    this.pendingCount = Sessions.getPending().length;
    if (this.pendingCount === 0) this.isOffline = false;

    this._showToast(
      succeeded > 0
        ? `✓ ${succeeded} session(s) submitted successfully!`
        : '✗ Still offline — will retry later.'
    );
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
      this.leaderboardRows = results.map((row, i) => ({ ...row, rank: i + 1 }));
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

  // ── Admin ──────────────────────────────────────────────

  gotoAdmin() {
    const saved           = _loadStoredConfig();
    this.adminGoloka      = saved.goloka_url       || CONFIG.GOLOKA_URL            || '';
    this.adminWriteKey    = saved.write_key         || CONFIG.SANKIRTAN_WRITE_KEY   || '';
    this.adminDevoteeSheet = saved.devotee_sheet_url || CONFIG.DEVOTEE_SHEET_CSV_URL || '';
    this.connStatus       = '';
    this.connClass        = '';
    this.sheetStatus      = '';
    this.sheetClass       = '';
    this.goto('admin');
  },

  saveAdmin() {
    const cfg = {
      goloka_url:        this.adminGoloka.trim(),
      write_key:         this.adminWriteKey.trim(),
      devotee_sheet_url: this.adminDevoteeSheet.trim(),
    };
    try { localStorage.setItem(CONFIG.STORAGE_KEYS.CONFIG, JSON.stringify(cfg)); }
    catch (_) {}
    CONFIG.GOLOKA_URL            = cfg.goloka_url;
    CONFIG.SANKIRTAN_WRITE_KEY   = cfg.write_key;
    CONFIG.DEVOTEE_SHEET_CSV_URL = cfg.devotee_sheet_url;
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

  async testDevoteeSheet() {
    const url = this.adminDevoteeSheet.trim();
    if (!url) {
      this.sheetStatus = 'Enter the sheet URL first.';
      this.sheetClass  = 'error';
      return;
    }
    this.sheetStatus = 'Testing…';
    this.sheetClass  = 'loading';
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text  = await resp.text();
      const lines = text.trim().split(/\r?\n/);
      const count = Math.max(0, lines.length - 1);
      this.sheetStatus = `✓ Connected — ${count} devotee(s) found`;
      this.sheetClass  = 'success';
    } catch (err) {
      this.sheetStatus = `✗ ${err.message}`;
      this.sheetClass  = 'error';
    }
  },

  // Input handlers for admin fields (so Sprae gets named methods)
  onAdminGoloka(e)  { this.adminGoloka      = e.target.value; },
  onAdminKey(e)     { this.adminWriteKey     = e.target.value; },
  onAdminSheet(e)   { this.adminDevoteeSheet = e.target.value; },

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

    // Load devotee list and books in parallel
    this.catalogLoading = true;
    const [devoteeResult] = await Promise.all([
      Catalog.loadDevotees(false),
      Catalog.loadBooks(false),
    ]);
    this.devotees         = Catalog.devotees;
    this.filteredDevotees = Catalog.devotees.slice();
    this.bookGroups       = Catalog.groupedBooks();
    this.catalogLoading   = false;

    if (devoteeResult.source === 'empty') {
      this.catalogNotice = 'No devotee sheet configured — go to Admin to add the CSV URL.';
    }

    // Count pending submissions
    this.pendingCount = Sessions.getPending().length;
    if (this.pendingCount > 0) this.isOffline = true;
  },
});

// Boot
document.addEventListener('DOMContentLoaded', () => state.init());
