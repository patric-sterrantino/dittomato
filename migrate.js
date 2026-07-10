#!/usr/bin/env node
/**
 * migrate.js — one-time migration into the chunked Firestore backend (v2).
 *
 * Reads the full string catalog and writes a handful of aggregate documents:
 *   strings/meta          { chunks, splits, totalEntries, variants, migratedAt, schema }
 *   strings/index_0 …     { key: entry }   (each ~500 KB, sorted by key)
 *   strings/variables     migrated src/ditto/variables.json
 *   changelog/…               (untouched here; written by the app/CLI)
 *
 * Sources:
 *   default        — Ditto API (needs DITTO_API_KEY). Full fidelity incl. status.
 *   --from-json    — src/ditto/*.json (no Ditto needed; what we already have).
 *
 * Firestore writes use firebase-admin + a service account (FIREBASE_SERVICE_ACCOUNT_PATH).
 * Config is read from .env.
 *
 *   node migrate.js --dry-run            # build + print the chunk plan, write nothing
 *   node migrate.js --from-json          # migrate from src/ditto JSON
 *   node migrate.js                      # migrate from Ditto
 *   node migrate.js --rebalance          # re-pack existing Firestore chunks
 *   node migrate.js --purge-old          # delete the dead per-component `components` docs
 *
 * Entry shape: { base, de, fr, … : string | {form:text}, _master?, name? }.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const FR = require('./firestore-rest');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const DRY = has('--dry-run');
const FROM_JSON = has('--from-json');
const REBALANCE = has('--rebalance');
const PURGE_OLD = has('--purge-old');

const DITTO_DIR = process.env.DITTO_JSON_DIR ? path.resolve(process.env.DITTO_JSON_DIR) : path.join(__dirname, 'src', 'ditto');
const BLOCKED = new Set(['traffic-signs-ditto-beta-test']);
const LOCALE_BY_NAME = { german: 'de', french: 'fr', english: 'en' };
const VARIANT_NAMES = { de: 'German', fr: 'French', en: 'English' };
const TARGET_BYTES = 500 * 1024;

// ── .env ─────────────────────────────────────────────────────────────────────
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = { ...loadEnv(), ...process.env };

// ── Ditto ────────────────────────────────────────────────────────────────────
function httpsGetJson(pathname, key) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.dittowords.com', path: pathname, headers: { Authorization: key } }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function localeFor(variant) {
  return LOCALE_BY_NAME[(variant.name || '').toLowerCase()] || variant.id || (variant.name || '').toLowerCase();
}
function baseIdOf(row) {
  return (row.pluralForm && row.id && row.id.endsWith('_' + row.pluralForm))
    ? row.id.slice(0, -(row.pluralForm.length + 1)) : row.id;
}
function putValue(entry, locale, form, text) {
  if (form) {
    if (typeof entry[locale] !== 'object' || entry[locale] === null) entry[locale] = {};
    entry[locale][form] = text;
  } else {
    if (typeof entry[locale] === 'object' && entry[locale] !== null) return; // don't clobber a plural map with the alias base row
    entry[locale] = text;
  }
}

async function entriesFromDitto() {
  const key = ENV.DITTO_API_KEY;
  if (!key) throw new Error('DITTO_API_KEY missing (needed unless --from-json).');

  process.stdout.write('Fetching variants…          ');
  const variants = await httpsGetJson('/v2/variants', key);
  const variantLocale = {};
  for (const v of variants) variantLocale[v.id] = localeFor(v);
  console.log(`${variants.length} variants (${[...new Set(Object.values(variantLocale))].join(', ')})`);

  process.stdout.write('Fetching Ditto components…  ');
  const allFilter = encodeURIComponent(JSON.stringify({ variants: [{ id: 'all' }] }));
  // Ditto v2 returns the full set in one response (as the browser app relied on).
  // If a future dataset paginates, add cursor handling here.
  const rows = await httpsGetJson(`/v2/components?filter=${allFilter}`, key);
  console.log(`${rows.length} rows loaded`);

  process.stdout.write('Building index…             ');
  const entries = {};
  for (const row of rows) {
    const base = baseIdOf(row);
    const locale = row.variantId ? (variantLocale[row.variantId] || row.variantId) : 'base';
    const entry = (entries[base] = entries[base] || {});
    putValue(entry, locale, row.pluralForm || null, row.text != null ? row.text : '');
    if (locale === 'base' && row.name && !entry.name) entry.name = row.name;
  }
  finalizeEntries(entries);
  console.log('done');
  return entries;
}

// ── JSON fallback ──────────────────────────────────────────────────────────────
function mergedMap(variant) {
  const map = {};
  for (const f of fs.readdirSync(DITTO_DIR)) {
    if (!f.endsWith(`___${variant}.json`) || BLOCKED.has(f.split('___')[0])) continue;
    try { Object.assign(map, JSON.parse(fs.readFileSync(path.join(DITTO_DIR, f), 'utf8'))); } catch {}
  }
  return map;
}
function entriesFromJson() {
  process.stdout.write('Building index from JSON…   ');
  const entries = FR.entriesFromFlatMaps({ base: mergedMap('base'), de: mergedMap('de'), fr: mergedMap('fr') });
  console.log('done');
  return entries;
}

// Drop twinned `-original` and set `_master` on plural entries.
function finalizeEntries(entries) {
  const ids = new Set(Object.keys(entries));
  for (const k of Object.keys(entries)) {
    if (k.endsWith('-original') && ids.has(k.slice(0, -'-original'.length))) { delete entries[k]; continue; }
    const e = entries[k];
    if (e.base && typeof e.base === 'object' && !e._master) e._master = ('other' in e.base) ? 'other' : Object.keys(e.base)[0];
  }
}

function loadVariables() {
  const file = path.join(DITTO_DIR, 'variables.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function variantsFromEntries(entries) {
  const present = new Set();
  for (const e of Object.values(entries)) for (const k of Object.keys(e)) if (!['base', '_master', 'name'].includes(k)) present.add(k);
  return [...present].sort().map(id => ({ id, name: VARIANT_NAMES[id] || id }));
}

// ── Firestore (firebase-admin, lazy) ────────────────────────────────────────
function getDb() {
  const admin = require('firebase-admin');
  const svcPath = ENV.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccount.json';
  const svc = JSON.parse(fs.readFileSync(path.resolve(__dirname, svcPath), 'utf8'));
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(svc) });
  return { admin, db: admin.firestore() };
}

async function writeIndex(entries, variables) {
  const { chunks, splits } = FR.packEntries(entries, TARGET_BYTES);
  const variants = variantsFromEntries(entries);
  const totalEntries = Object.keys(entries).length;

  console.log(`Total entries:              ${totalEntries}`);
  console.log(`Chunking (~${TARGET_BYTES / 1024}KB):`);
  for (const c of chunks) console.log(`  ${c.id.padEnd(14)} ${String(Object.keys(c.map).length).padStart(5)} entries · ${(Buffer.byteLength(JSON.stringify(c.map)) / 1024).toFixed(0)}KB`);

  // Local backup FIRST — before touching Firestore.
  const backup = path.join(__dirname, 'strings-backup.json');
  fs.writeFileSync(backup, JSON.stringify({ schema: 2, splits, variants, entries, variables }, null, 0));
  console.log(`Backup written:             ${path.basename(backup)} (${(fs.statSync(backup).size / 1e6).toFixed(2)}MB)`);

  if (DRY) { console.log('--dry-run: nothing written to Firestore.'); return; }

  const meta = { chunks: chunks.map(c => c.id), splits, totalEntries, variants, schema: 2 };

  // Prefer a service account (firebase-admin); fall back to the web apiKey via REST
  // (open rules) so migration works without downloading a service account.
  const svcPath = path.resolve(__dirname, ENV.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccount.json');
  if (fs.existsSync(svcPath)) {
    const { admin, db } = getDb();
    const batch = db.batch();
    for (const c of chunks) batch.set(db.doc(`strings/${c.id}`), c.map);
    batch.set(db.doc('strings/variables'), variables || {});
    batch.set(db.doc('strings/meta'), { ...meta, migratedAt: admin.firestore.FieldValue.serverTimestamp() });
    await batch.commit();
  } else {
    const wc = loadWebConfig();
    if (!wc.apiKey) throw new Error('No serviceAccount.json and no web apiKey (set FIREBASE_API_KEY or firebase.config.json).');
    console.log('   (no service account — writing via REST with the web apiKey)');
    const client = FR.createClient({ projectId: wc.projectId, apiKey: wc.apiKey });
    for (const c of chunks) { await client.setDoc('strings', c.id, c.map); process.stdout.write(`   wrote ${c.id}\n`); }
    await client.setDoc('strings', 'variables', variables || {});
    await client.setDoc('strings', 'meta', { ...meta, migratedAt: new Date().toISOString() });
  }
  console.log(`✅ Migration complete. ${totalEntries} entries in ${chunks.length} chunks + meta + variables.`);
}

function loadWebConfig() {
  const file = path.join(__dirname, 'firebase.config.json');
  let cfg = {};
  if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || cfg.projectId,
    apiKey: process.env.FIREBASE_API_KEY || cfg.apiKey,
  };
}

// ── --rebalance: re-pack whatever is already in Firestore ────────────────────
async function rebalance() {
  const { db } = getDb();
  const metaSnap = await db.doc('strings/meta').get();
  if (!metaSnap.exists) throw new Error('No strings/meta — run a normal migration first.');
  const meta = metaSnap.data();
  const entries = {};
  for (const id of meta.chunks) {
    const snap = await db.doc(`strings/${id}`).get();
    Object.assign(entries, snap.data() || {});
  }
  const varSnap = await db.doc('strings/variables').get();
  console.log(`Rebalancing ${Object.keys(entries).length} entries from ${meta.chunks.length} chunks…`);
  await writeIndex(entries, varSnap.exists ? varSnap.data() : {});
}

// ── --purge-old: delete the dead per-component `components` docs + config ─────
async function purgeOld() {
  const { db } = getDb();
  let removed = 0;
  for (const col of ['components', 'config']) {
    while (true) {
      const snap = await db.collection(col).limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      removed += snap.size;
      process.stdout.write(`\r  deleted ${removed}…`);
      if (snap.size < 400) break;
    }
  }
  console.log(`\n✅ Purged ${removed} obsolete docs.`);
}

async function main() {
  console.log('🍅 Dittomato migrate — chunked Firestore backend\n');
  if (REBALANCE) return rebalance();
  if (PURGE_OLD) return purgeOld();

  const entries = FROM_JSON ? entriesFromJson() : await entriesFromDitto();
  const variables = loadVariables();
  console.log(`Variables:                  ${Object.keys(variables).length} entries`);
  await writeIndex(entries, variables);
}

main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
