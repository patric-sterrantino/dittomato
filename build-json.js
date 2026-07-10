#!/usr/bin/env node
/**
 * build-json.js — export the Firestore string index to flat i18next JSON that
 * other web apps can consume. Reverse of migrate.js.
 *
 * Reads strings/meta + all chunks, then writes one flat file per locale
 * (plurals unfolded back to `id_<form>` keys), a combined file, and variables:
 *
 *   dist/base.json      { "key": "text", "key_one": "…", "key_other": "…" }
 *   dist/de.json
 *   dist/fr.json
 *   dist/strings.json   { base:{…}, de:{…}, fr:{…} }
 *   dist/variables.json
 *
 * Read-only — uses the web apiKey via REST (firebase.config.json or FIREBASE_*),
 * no service account needed.
 *
 *   node build-json.js                # → ./dist
 *   node build-json.js --out path/    # custom output dir
 */

'use strict';

const fs = require('fs');
const path = require('path');
const FR = require('./firestore-rest');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(__dirname, outIdx >= 0 ? args[outIdx + 1] : 'dist');

function loadConfig() {
  let cfg = {};
  const file = path.join(__dirname, 'firebase.config.json');
  if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  const projectId = process.env.FIREBASE_PROJECT_ID || cfg.projectId;
  const apiKey = process.env.FIREBASE_API_KEY || cfg.apiKey;
  if (!projectId || !apiKey) throw new Error('Missing Firebase projectId/apiKey (firebase.config.json or FIREBASE_* env).');
  return { projectId, apiKey };
}

// entries { key: {base, de, …: string|{form}} } -> { locale: { flatKey: text } }
function flatten(entries) {
  const out = {};
  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    for (const loc of Object.keys(entry)) {
      if (loc === '_master' || loc === 'name') continue;
      const v = entry[loc];
      (out[loc] = out[loc] || {});
      if (v && typeof v === 'object') for (const f of Object.keys(v)) out[loc][`${key}_${f}`] = v[f];
      else out[loc][key] = v;
    }
  }
  return out;
}

async function main() {
  const client = FR.createClient(loadConfig());
  process.stdout.write('Loading index…  ');
  const meta = await client.getDoc('strings', 'meta');
  if (!meta) throw new Error('No strings/meta — run the migration first.');
  const entries = {};
  for (const id of meta.chunks || []) Object.assign(entries, await client.getDoc('strings', id));
  const variables = (await client.getDoc('strings', 'variables')) || {};
  console.log(`${Object.keys(entries).length} entries · ${(meta.chunks || []).length} chunks`);

  const byLocale = flatten(entries);
  fs.mkdirSync(OUT, { recursive: true });
  const locales = Object.keys(byLocale).sort();
  for (const loc of locales) {
    const sorted = Object.fromEntries(Object.keys(byLocale[loc]).sort().map(k => [k, byLocale[loc][k]]));
    byLocale[loc] = sorted;
    fs.writeFileSync(path.join(OUT, `${loc}.json`), JSON.stringify(sorted, null, 2) + '\n');
    console.log(`  ${loc}.json`.padEnd(18) + `${Object.keys(sorted).length} keys`);
  }
  fs.writeFileSync(path.join(OUT, 'strings.json'), JSON.stringify(byLocale, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'variables.json'), JSON.stringify(variables, null, 2) + '\n');
  console.log(`  strings.json     combined (${locales.join(', ')})`);
  console.log(`  variables.json   ${Object.keys(variables).length} keys`);
  console.log(`✅ Wrote to ${OUT}`);
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
