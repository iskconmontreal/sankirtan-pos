/* Sankirtan POS — Configuration */

export const CONFIG = {
  GOLOKA_URL:          'http://localhost:8080',
  SANKIRTAN_WRITE_KEY: '',
  STORE_NAME:          'ISKCON Montréal — Sankirtan',
  STORAGE_KEYS: {
    CATALOG_CACHE:  'sankirtan_catalog_cache',
    DEVOTEES_CACHE: 'sankirtan_devotees_cache',
    CONFIG:         'sankirtan_config',  // { goloka_url, write_key }
    PENDING:        'sankirtan_pending', // queued failed submissions
    RECENT:         'sankirtan_recent',  // last submitted sessions
  },
};

export const CATEGORY_POINTS = {
  S1: 0.25, H1: 0.25,
  S2: 0.5,  H2: 0.5,
  S3: 1.0,  H3: 1.0,
  S4: 2.0,  H4: 2.0,
};

export const CATEGORY_LABELS = {
  S4: 'Big Books (Soft)',    S3: 'Medium Books (Soft)',
  S2: 'Small Books (Soft)',  S1: 'Mini Books (Soft)',
  H4: 'Big Books (Hard)',    H3: 'Medium Books (Hard)',
  H2: 'Small Books (Hard)',  H1: 'Mini Books (Hard)',
};

// Sort order: big-to-small, soft before hard within each size
export const CATEGORY_ORDER = ['S4','S3','S2','S1','H4','H3','H2','H1'];

export const SIZE_LABELS  = { 1: 'Small', 2: 'Medium', 3: 'Big', 4: 'Mahabig' };
export const SIZE_ORDER   = [1, 2, 3, 4];
export const COVER_LABELS = { S: 'Soft', H: 'Hard' };
export const COVER_ORDER  = ['S', 'H'];

export const LANG_LABELS = {
  en: 'English', eng: 'English', english: 'English',
  fr: 'French',  fre: 'French',  fra: 'French',  french: 'French',
};

export const LANG_ORDER = ['English', 'French', 'Spanish', 'Arabic', 'Bengali', 'Hindi'];

// Payment methods offered at the POS. A session's donation can be split across
// several methods; the collector keys each one independently and the total is the
// sum of them. goloka books one finance income row per method.
export const PAYMENT_METHODS = [
  { value: 'Cash',          label: '💵 Cash' },
  { value: 'Card',          label: '💳 Card' },
  { value: 'Cheque',        label: '🧾 Cheque' },
  { value: 'Interac',       label: '📲 Interac' },
  { value: 'Bank Transfer', label: '🏦 Bank Transfer' },
];
