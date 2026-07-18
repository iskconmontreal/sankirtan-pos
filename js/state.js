/* Sankirtan POS — Reactive State (Sprae)
   Multi-step wizard: login → landing → books → collection → confirm → leaderboard
   The logged-in user is the distributor; sessions are attributed server-side.
*/

import sprae from './vendor/sprae.js';
import { CONFIG, LANG_LABELS, PAYMENT_METHODS } from './config.js';
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
  userName:    '',   // display name of the logged-in devotee

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

  // ── Landing ────────────────────────────────────────────

  async startSession() {
    Sessions.clear();
    this.sessionLocation = '';
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
        this.catalogNotice = 'Could not load book catalog — check your connection.';
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
      covers: group.covers.map(cover => ({
        ...cover,
        books: cover.books.map(b => ({ ...b, qty: Sessions.getQty(b.id) })),
      })),
    }));
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

    // Rebuild the book list for the saved language and overlay the saved qtys
    this.bookGroups = Catalog.groupedBooks(this.selectedLanguage);
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
    this.bookGroups = Catalog.groupedBooks(this.selectedLanguage);
  },

  setLanguage(lang) {
    this.selectedLanguage = lang;
    this.bookGroups = Catalog.groupedBooks(lang);
    this._syncTotals();
    this._saveDraft();
  },

  langLabel(lang) {
    return LANG_LABELS[String(lang).toLowerCase()] || lang;
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

  // ── Submission ─────────────────────────────────────────

  async submitSession() {
    if (this.submitting) return;

    this._syncCollected();

    if (this.collectedCents <= 0) {
      this._showToast('Enter the amount collected before submitting.');
      return;
    }

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
      this.leaderboardRows = data.results;
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

  // ── Auth ───────────────────────────────────────────────
  // Mirrors Mandir's login flow: email first; the server answers with
  // `password_required` or `otp_required` (or a token directly for trusted
  // devices), and Google is a one-tap alternative.

  _showLogin() {
    this.authStep     = 'email';
    this.authPassword = '';
    this.authOtp      = '';
    this.goto('login');
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
    if (!auth.active) { this._showLogin(); return; }
    await this._postLogin();
  },

  // Everything that needs a logged-in user: permission gate, catalog load,
  // draft recovery, and the pending-queue flush.
  async _postLogin() {
    if (!auth.can('sankirtan:view')) {
      auth.clear();
      this._showLogin();
      this.authError = 'This account has no book-distribution access — ask the temple admin for the Book Distributor role.';
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
  // 'hidden' fires right before iOS Safari backgrounds/evicts the tab on
  // screen-lock — flush the in-progress count to disk before it can be lost.
  else state._saveDraft();
});
// pagehide is the last reliable beat before the page is frozen/discarded.
window.addEventListener('pagehide', () => state._saveDraft());