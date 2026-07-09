/**
 * ditto-sync.js — transition-phase mirror of Ditto writes into src/ditto/*.json
 *
 * While we migrate off Ditto, every change that is pushed to Ditto must also be
 * written into the flat i18next JSON files under src/ditto so those files become
 * the source of truth. Both writers share this module:
 *   - harvest.js (CLI) after pushing new components
 *   - sync-server.js (POST /sync) on behalf of the browser app (index.html)
 *
 * The JSON files are flat maps of `developerId -> text`, grouped by
 * `{folder}___{variant}.json`. Plural components appear as `{id}_{form}` keys.
 *
 * The ditto directory defaults to <thisModule>/src/ditto so the CLI writes here
 * even when run from another project; override with DITTO_JSON_DIR.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VARIANTS = ['base', 'de', 'fr'];
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

// Folders intentionally excluded from index.js (kept out historically).
const BLOCKED_FOLDERS = new Set(['traffic-signs-ditto-beta-test']);

// Where new components land when they don't belong to an existing folder.
const NEW_FOLDER = 'harvested';

// Baseline order of index.js spreads, per variant — mirrors the hand-written
// index.js so regeneration reproduces the exact existing output. Any file not
// listed here (new translation files, harvested) is appended after, with the
// harvested bucket forced last.
const BASELINE = {
  base: ['signs-1', 'components-root', 'reportingportal', 'usasigns', 'frenchsigns', 'signs', 'components'],
  de: ['components-root', 'reportingportal', 'signs-1', 'components'],
  fr: ['components-root', 'reportingportal', 'signs-1', 'components'],
};

function dittoDir() {
  if (process.env.DITTO_JSON_DIR) return path.resolve(process.env.DITTO_JSON_DIR);
  return path.join(__dirname, 'src', 'ditto');
}

function folderOf(basename) {
  return basename.split('___')[0];
}

function fileName(folder, variant) {
  return `${folder}___${variant}.json`;
}

function isBlocked(basename) {
  return BLOCKED_FOLDERS.has(folderOf(basename));
}

function readJson(file) {
  const abs = path.join(dittoDir(), file);
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  const abs = path.join(dittoDir(), file);
  fs.writeFileSync(abs, JSON.stringify(obj, null, 4) + '\n');
}

// All `*___{variant}.json` files currently on disk (blocked folders excluded).
function variantFiles(variant) {
  let entries = [];
  try {
    entries = fs.readdirSync(dittoDir());
  } catch {
    return [];
  }
  return entries.filter(f => f.endsWith(`___${variant}.json`) && !isBlocked(f));
}

/**
 * Decide which file a key should be written to for a given variant:
 *  1. a file that already contains the key   -> update in place
 *  2. otherwise, the sibling of the base file that owns the key (same folder)
 *  3. otherwise (brand-new component)         -> harvested___{variant}.json
 */
function resolveFile(variant, key) {
  for (const f of variantFiles(variant)) {
    if (Object.prototype.hasOwnProperty.call(readJson(f), key)) return f;
  }
  if (variant !== 'base') {
    for (const bf of variantFiles('base')) {
      if (Object.prototype.hasOwnProperty.call(readJson(bf), key)) {
        return fileName(folderOf(bf), variant);
      }
    }
  }
  return fileName(NEW_FOLDER, variant);
}

/** Insert or update a single flat key. Regenerates index.js if a new file appears. */
function upsert(variant, key, text) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant "${variant}"`);
  if (!key) throw new Error('missing key');
  const file = resolveFile(variant, key);
  const existed = fs.existsSync(path.join(dittoDir(), file));
  const obj = readJson(file);
  obj[key] = text == null ? '' : String(text);
  writeJson(file, obj);
  if (!existed) regenerateIndex();
  return { file, created: !existed };
}

/** Remove a single key from whichever variant file holds it. */
function remove(variant, key) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant "${variant}"`);
  for (const f of variantFiles(variant)) {
    const obj = readJson(f);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      delete obj[key];
      writeJson(f, obj);
      return { file: f, removed: true };
    }
  }
  return { removed: false };
}

/**
 * Remove a component everywhere: the exact key and its plural forms
 * (`{key}_{form}`) across every variant. We deliberately do NOT touch a
 * `{key}-original` sibling — that is an independent component in Ditto.
 */
function removeEverywhere(key) {
  const pluralRe = new RegExp(`^${escapeRe(key)}_(?:${PLURAL_FORMS.join('|')})$`);
  const touched = [];
  for (const variant of VARIANTS) {
    for (const f of variantFiles(variant)) {
      const obj = readJson(f);
      let changed = false;
      for (const k of Object.keys(obj)) {
        if (k === key || pluralRe.test(k)) {
          delete obj[k];
          changed = true;
        }
      }
      if (changed) {
        writeJson(f, obj);
        touched.push(f);
      }
    }
  }
  return { touched };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const varName = basename => basename.replace(/[^a-zA-Z0-9]/g, '_');

// Order files by BASELINE first, then newcomers alphabetically, harvested last.
function orderFiles(variant, basenames) {
  const base = BASELINE[variant] || [];
  const rank = f => {
    const folder = folderOf(f);
    if (folder === NEW_FOLDER) return [2, folder];
    const i = base.indexOf(folder);
    return i >= 0 ? [0, i] : [1, folder];
  };
  return [...basenames].sort((a, b) => {
    const [ga, ra] = rank(a);
    const [gb, rb] = rank(b);
    if (ga !== gb) return ga - gb;
    if (typeof ra === 'number' && typeof rb === 'number') return ra - rb;
    return String(ra).localeCompare(String(rb));
  });
}

/**
 * Rewrite index.js from the files present on disk, using static requires so the
 * result stays bundler-friendly. Reproduces the current file order exactly for
 * the existing set; appends any new variant/harvested files.
 */
function regenerateIndex() {
  const perVariant = {};
  const requires = new Map(); // varName -> basename (deduped, stable)

  for (const variant of VARIANTS) {
    const files = orderFiles(variant, variantFiles(variant).map(f => f.replace('.json', '')));
    perVariant[variant] = files;
    for (const f of files) requires.set(varName(f), f);
  }

  const lines = [];
  for (const [v, f] of requires) lines.push(`const ${v} = require('./${f}.json');`);
  lines.push('');
  lines.push('module.exports = {');
  VARIANTS.forEach((variant, vi) => {
    const spreads = perVariant[variant].map(f => `        ...${varName(f)}`);
    lines.push(`    ${variant}: {`);
    lines.push(spreads.join(',\n'));
    lines.push(`    }${vi < VARIANTS.length - 1 ? ',' : ''}`);
  });
  lines.push('};');

  fs.writeFileSync(path.join(dittoDir(), 'index.js'), lines.join('\n') + '\n');
}

/** Apply a batch of ops from the browser. Each op: {op, variant, key, text}. */
function applyOps(ops) {
  const results = [];
  for (const op of ops || []) {
    try {
      if (op.op === 'upsert') results.push({ ok: true, ...upsert(op.variant, op.key, op.text) });
      else if (op.op === 'remove') results.push({ ok: true, ...remove(op.variant, op.key) });
      else if (op.op === 'removeAll') results.push({ ok: true, ...removeEverywhere(op.key) });
      else results.push({ ok: false, error: `unknown op "${op.op}"` });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = {
  upsert,
  remove,
  removeEverywhere,
  regenerateIndex,
  applyOps,
  dittoDir,
  VARIANTS,
};
