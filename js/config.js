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

export const SAMPLE_BOOKS = [
  { id: 1, title: 'Bhagavad-gita As It Is',        category: 'S4', points_per_unit: 2,    cost_cents: 1500, active: true },
  { id: 2, title: 'Srimad-Bhagavatam (volume)',     category: 'S3', points_per_unit: 1,    cost_cents: 1000, active: true },
  { id: 3, title: 'Krsna Book',                     category: 'S3', points_per_unit: 1,    cost_cents: 1000, active: true },
  { id: 4, title: 'Teachings of Lord Caitanya',     category: 'S2', points_per_unit: 0.5,  cost_cents:  600, active: true },
  { id: 5, title: 'Nectar of Devotion',             category: 'S2', points_per_unit: 0.5,  cost_cents:  600, active: true },
  { id: 6, title: 'Easy Journey to Other Planets',  category: 'S1', points_per_unit: 0.25, cost_cents:  300, active: true },
  { id: 7, title: 'Beyond Birth and Death',         category: 'S1', points_per_unit: 0.25, cost_cents:  300, active: true },
];
