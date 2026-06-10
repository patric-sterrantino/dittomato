#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const os   = require('os');

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { return '?'; }
})();

// ── ANSI colors ────────────────────────────────────────────────────────────
const NO_COLOR = process.argv.includes('--no-color') || !process.stdout.isTTY;
const c = {
  reset:  s => NO_COLOR ? s : `\x1b[0m${s}\x1b[0m`,
  green:  s => NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`,
  yellow: s => NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`,
  red:    s => NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`,
  dim:    s => NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`,
  bold:   s => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`,
  purple: s => NO_COLOR ? s : `\x1b[35m${s}\x1b[0m`,
  cyan:   s => NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`,
};
const HR = '─'.repeat(62);

// ── Arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = { push: false, yes: false, noColor: NO_COLOR };
const paths  = [];
let   exts   = ['jsx', 'tsx'];
let   ignoreExtra = [];

let importFrom = '';

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--push')     { flags.push = true; }
  else if (a === '--yes') { flags.yes = true; }
  else if (a === '--no-color') { /* already read */ }
  else if (a === '--ext')  { exts = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean); }
  else if (a === '--ignore') { ignoreExtra = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean); }
  else if (a === '--import-from') { importFrom = argv[++i] || ''; }
  else if (!a.startsWith('-')) { paths.push(a); }
}
if (paths.length === 0) paths.push('.');

// ── .env loader ────────────────────────────────────────────────────────────
function parseEnv(content) {
  const map = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    map[key] = val;
  }
  return map;
}

function findEnv() {
  let dir = process.cwd();
  const home = os.homedir();
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === home || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  const homeEnv = path.join(home, '.env');
  if (fs.existsSync(homeEnv)) return homeEnv;
  return null;
}

const envFile = findEnv();
const envVars = envFile ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
const DITTO_KEY = process.env.DITTO_API_KEY || envVars.DITTO_API_KEY || '';

if (!DITTO_KEY) {
  console.error(c.red('❌  DITTO_API_KEY not found.'));
  console.error('    Add it to .env in this project or to ~/.env for global use.');
  console.error('    See .env.example for reference.');
  process.exit(1);
}

// ── File collection ────────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage',
  '__tests__', '.next', 'out', 'public', ...ignoreExtra,
]);
const SKIP_FILE_RE = /(?:^|\.)(?:test|spec|stories|dummy|mock)(?:\.|$)|\.d\.ts$/;

function collectFiles(target) {
  const collected = [];
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return collected;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    const ext = path.extname(abs).slice(1);
    if (exts.includes(ext)) collected.push(abs);
  } else if (stat.isDirectory()) {
    walk(abs, collected);
  }
  return collected;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile()) {
      if (SKIP_FILE_RE.test(entry)) continue;
      const ext = path.extname(entry).slice(1);
      if (exts.includes(ext)) out.push(full);
    }
  }
}

const allFiles = [...new Set(paths.flatMap(collectFiles))];

// ── String extraction ──────────────────────────────────────────────────────
const PROP_NAMES = [
  // core copy props
  'label', 'text', 'title', 'description', 'caption', 'message',
  // input / form
  'placeholder', 'helperText', 'hint', 'legend',
  // tooltips / overlays
  'tooltip',
  // button / action labels
  'buttonText', 'confirmText', 'confirmLabel', 'cancelText', 'cancelLabel',
  'submitText', 'saveText', 'actionText',
  // empty / loading states
  'emptyText', 'emptyMessage', 'noDataText', 'noResultsText', 'noRowsLabel', 'loadingText',
  // feedback messages
  'successMessage', 'errorMessage', 'warningMessage', 'infoMessage', 'errorText',
  // section / card structure
  'header', 'subheader', 'subtitle',
  // list / nav items
  'primaryText', 'secondaryText',
  // data grid column headers
  'headerName',
  // image alt text
  'alt',
  // accessibility
  'aria-label', 'aria-description', 'aria-placeholder',
];

// Props that only accept a string — <Ditto /> (a React element) is invalid here.
const STRING_ONLY_PROPS = new Set([
  'aria-label', 'aria-description', 'aria-placeholder',
  'placeholder', 'title', 'alt',
]);

// JSX text between tags — only lines that look like real copy, not expressions
// Require: no braces, no newline, at least 4 chars after trim
const JSX_TEXT_RE = />([^<>{}\n]{4,})</g;
// String props: propName="..." or propName='...' — single line only (no \n in value)
// Use (?<![-\w]) instead of \b so "label" doesn't match inside "aria-label"
const PROP_RE    = new RegExp(`(?<![-\\w])(${PROP_NAMES.join('|')})=["']([^"'\\n]{4,})["']`, 'g');
// Already-wrapped t() calls
const T_CALL_RE  = /\bt\(["']([^"']+)["']\)/g;

// TypeScript / JS type words that indicate code fragments
const TS_TYPE_WORDS = /\b(Array|Promise|Map|Set|Record|Partial|Required|Readonly|Extract|Exclude|ReturnType|void|null|undefined|boolean|string|number|object|never|unknown|any)\b/;

function isJunk(s, kind) {
  if (s.length < 4) return true;
  if (!/[a-zA-Z]/.test(s)) return true;
  if (/^\s*$/.test(s)) return true;

  // must have at least 2 consecutive letters (not just scattered symbols)
  if (!/[a-zA-Z]{2}/.test(s)) return true;

  // hex color
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true;

  // HTML entities (&nbsp; &amp; etc.) — whole string or starts with &, ends with ;
  if (/^(&[a-zA-Z]+;)+$/.test(s)) return true;

  // URL / path
  if (/^(https?:|\/|\.\/|\.\.\/)/.test(s)) return true;
  if (/(?:\.\/|\.\.\/|https?:)/.test(s)) return true;

  // dev ID pattern: contains . and no spaces
  if (/\./.test(s) && !/\s/.test(s)) return true;

  // variable-like single token: no spaces AND (camelCase / PascalCase / ALL_CAPS / kebab-case)
  // Skip this check for explicit prop values — text="exportxls" is intentional copy, not a variable
  if (kind !== 'prop' && !/\s/.test(s) && /^([a-z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]+|[A-Z_]{2,}|[a-z][a-z0-9-]+)$/.test(s)) return true;

  // JS expression fragments
  if (/&&|\|\||\?\?|=>/.test(s)) return true;

  // ternary operator: digit or identifier, space, ?, space
  if (/[\w\d]\s\?\s/.test(s)) return true;

  // comparison operators
  if (/>=|<=|!==|===/.test(s)) return true;

  // starts with code-fragment characters (including : for TS type annotations)
  if (/^[=(;<:{]/.test(s.trimStart())) return true;

  // contains braces or brackets → code block / destructuring
  if (/[{}[\]]/.test(s)) return true;

  // parentheses → function call or expression
  if (/\(.*\)/.test(s)) return true;

  // TypeScript type annotation: word followed by colon then type word
  if (/:\s*(Array|Promise|Map|Set|string|number|boolean|void|null|undefined|object|never|unknown|any)\b/.test(s)) return true;

  // standalone TS type words
  if (TS_TYPE_WORDS.test(s)) return true;

  // more than 3 words, no capital first letter, and contains code-like tokens
  const words = s.trim().split(/\s+/);
  if (words.length > 3 && /^[a-z]/.test(s) && /[{}[\]<>|&=]/.test(s)) return true;

  return false;
}

function isGoodJsxText(s) {
  // Must start with a capital letter OR contain at least one space (natural sentence)
  if (!/^[A-Z]/.test(s) && !/ /.test(s)) return false;
  // Must have at least 2 consecutive letters
  if (!/[a-zA-Z]{2}/.test(s)) return false;
  return true;
}

function stripComments(content) {
  // Replace block comments /* ... */ and JSX {/* ... */} with spaces, preserving newlines
  let result = content.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  // Replace line comments // ... with spaces
  result = result.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  return result;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function extractStrings(file, content) {
  content = stripComments(content);
  const results = [];

  // t() calls — already wrapped
  let m;
  T_CALL_RE.lastIndex = 0;
  while ((m = T_CALL_RE.exec(content)) !== null) {
    results.push({ string: m[1], file, line: lineOf(content, m.index), kind: 'already_wrapped' });
  }

  // JSX text nodes
  JSX_TEXT_RE.lastIndex = 0;
  while ((m = JSX_TEXT_RE.exec(content)) !== null) {
    const s = m[1].trim();
    if (isGoodJsxText(s) && !isJunk(s, 'jsx')) results.push({ string: s, file, line: lineOf(content, m.index), kind: 'jsx' });
  }

  // String props
  PROP_RE.lastIndex = 0;
  while ((m = PROP_RE.exec(content)) !== null) {
    const s = m[2].trim();
    if (!isJunk(s, 'prop')) results.push({ string: s, file, line: lineOf(content, m.index), kind: 'prop' });
  }

  return results;
}

// ── HTTPS helpers ──────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchComponents() {
  const res = await httpsRequest({
    hostname: 'api.dittowords.com',
    path: '/v2/components',
    method: 'GET',
    headers: { Authorization: DITTO_KEY },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

async function pushComponent(name, text, developerId) {
  // Only send name/text/developerId — never include variants; Ditto auto-fills them.
  const body = JSON.stringify({ components: [{ name, text, developerId }] });
  const res = await httpsRequest({
    hostname: 'api.dittowords.com',
    path: '/v2/components',
    method: 'POST',
    headers: {
      Authorization: DITTO_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return res;
}

// ── ID suggestion ──────────────────────────────────────────────────────────
function suggestId(file, string) {
  const stem = path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = string.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${stem}.${slug}`;
}

// ── Truncation + padding ───────────────────────────────────────────────────
function trunc(s, len = 45) {
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}
function pad(s, n) { return s + ' '.repeat(Math.max(0, n - s.length)); }
function relPath(f) { return path.relative(process.cwd(), f); }

// ── Prompt ─────────────────────────────────────────────────────────────────
function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans); });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(c.bold(c.purple('🍅 Dittomato — String Harvest')) + c.dim(`  v${VERSION}`));
  console.log(HR);

  // Collect and extract
  const rawStrings = [];
  for (const file of allFiles) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    rawStrings.push(...extractStrings(file, content));
  }

  // Separate already-wrapped
  const alreadyWrapped = rawStrings.filter(s => s.kind === 'already_wrapped');
  const candidates     = rawStrings.filter(s => s.kind !== 'already_wrapped');

  // Deduplicate by string value (keep first occurrence, note count)
  const seen    = new Map(); // string → entry
  const counts  = new Map();
  for (const entry of candidates) {
    const key = entry.string;
    if (!seen.has(key)) { seen.set(key, entry); counts.set(key, 0); }
    counts.set(key, counts.get(key) + 1);
  }
  const unique = [...seen.values()];

  console.log(c.dim(`Scanned ${allFiles.length} files · ${unique.length} strings found · ${alreadyWrapped.length} already wrapped`));
  console.log();

  // Fetch Ditto components
  let dittoComponents = [];
  try {
    process.stdout.write(c.dim('Fetching Ditto components… '));
    dittoComponents = await fetchComponents();
    process.stdout.write(c.green(`${dittoComponents.length} components loaded\n`));
  } catch (e) {
    console.error(c.red(`\n❌  Failed to fetch Ditto components: ${e.message}`));
    process.exit(1);
  }
  console.log();

  // Normalize for fuzzy matching: lowercase + strip all non-alphanumeric
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Build lookup: exact lowercase text → components
  const dittoByText = new Map();
  // Build secondary lookup: normalized text → components (catches "Export XLS" ↔ "export xls")
  const dittoByNorm = new Map();
  // Build tertiary lookup: normalized developerId → components (catches string "exportxls" ↔ id "exportxls")
  const dittoById   = new Map();
  for (const comp of dittoComponents) {
    const devId = comp.developerId || comp.id || '';
    if (comp.text) {
      const exact = comp.text.toLowerCase();
      if (!dittoByText.has(exact)) dittoByText.set(exact, []);
      dittoByText.get(exact).push(comp);
      const n = norm(comp.text);
      if (!dittoByNorm.has(n)) dittoByNorm.set(n, []);
      dittoByNorm.get(n).push(comp);
    }
    if (devId) {
      const nid = norm(devId);
      if (!dittoById.has(nid)) dittoById.set(nid, []);
      dittoById.get(nid).push(comp);
    }
  }

  // Match
  const matched   = [];
  const ambiguous = [];
  const nearMatch = []; // exact text miss but normalized hit
  const unmatched = [];
  for (const entry of unique) {
    const key  = entry.string.toLowerCase();
    const hits = dittoByText.get(key);
    if (hits && hits.length === 1) {
      matched.push({ ...entry, developerId: hits[0].developerId || hits[0].id });
    } else if (hits && hits.length > 1) {
      ambiguous.push({ ...entry, candidates: hits });
    } else {
      // No exact text match — try normalized text, then normalized developer ID
      const normHits = dittoByNorm.get(norm(entry.string)) || dittoById.get(norm(entry.string));
      if (normHits && normHits.length) {
        nearMatch.push({ ...entry, candidates: normHits, suggestedId: suggestId(entry.file, entry.string) });
      } else {
        unmatched.push({ ...entry, suggestedId: suggestId(entry.file, entry.string) });
      }
    }
  }

  // Resolve near-matches interactively
  if (nearMatch.length > 0) {
    console.log(c.cyan(`🔍  NEAR MATCH — similar text already in Ditto (${nearMatch.length})`));
    console.log(HR);
    for (const entry of nearMatch) {
      const loc = c.dim(`${relPath(entry.file)}:${entry.line}`);
      console.log(`\n  ${c.bold('"' + trunc(entry.string, 55) + '"')}  ${loc}`);
      console.log(c.dim('  Similar in Ditto:'));
      entry.candidates.forEach((comp, i) => {
        const id = comp.developerId || comp.id;
        console.log(`    ${c.dim('[' + (i + 1) + ']')} ${id}  ${c.dim('"' + trunc(comp.text, 45) + '"')}`);
      });
      console.log(`    ${c.dim('[n]')} treat as new`);

      let pick;
      if (flags.yes) {
        pick = entry.candidates[0];
        console.log(c.dim(`    → auto-picked [1] ${pick.developerId || pick.id}`));
      } else {
        const ans = await prompt('    Choice: ');
        const n   = parseInt(ans.trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= entry.candidates.length) pick = entry.candidates[n - 1];
      }

      if (pick) matched.push({ ...entry, developerId: pick.developerId || pick.id });
      else      unmatched.push({ ...entry, suggestedId: entry.suggestedId });
    }
    console.log();
  }

  // Resolve ambiguous entries interactively (or auto-pick first with --yes)
  if (ambiguous.length > 0) {
    console.log(c.yellow(`⚠️  AMBIGUOUS — multiple Ditto components match (${ambiguous.length})`));
    console.log(HR);
    for (const entry of ambiguous) {
      const loc = c.dim(`${relPath(entry.file)}:${entry.line}`);
      console.log(`\n  ${c.bold('"' + trunc(entry.string, 55) + '"')}  ${loc}`);
      entry.candidates.forEach((comp, i) => {
        const id = comp.developerId || comp.id;
        console.log(`    ${c.dim('[' + (i + 1) + ']')} ${id}`);
      });
      console.log(`    ${c.dim('[s]')} skip (treat as new)`);

      let pick;
      if (flags.yes) {
        pick = entry.candidates[0];
        console.log(c.dim(`    → auto-picked [1] ${pick.developerId || pick.id}`));
      } else {
        const ans = await prompt('    Choice: ');
        const n   = parseInt(ans.trim(), 10);
        if (!isNaN(n) && n >= 1 && n <= entry.candidates.length) {
          pick = entry.candidates[n - 1];
        }
      }

      if (pick) matched.push({ ...entry, developerId: pick.developerId || pick.id });
      else      unmatched.push({ ...entry, suggestedId: suggestId(entry.file, entry.string) });
    }
    console.log();
  }

  // Print matched
  const COL1 = 47, COL2 = 38;
  console.log(c.green(`✅ MATCHED (${matched.length})`));
  console.log(HR);
  for (const m of matched) {
    const str = `"${trunc(m.string)}"`;
    const id  = c.dim(m.developerId);
    const loc = c.dim(`${relPath(m.file)}:${m.line}`);
    console.log(`  ${pad(str, COL1)} →  ${pad(id, COL2)} ${loc}`);
  }
  console.log();

  // Print unmatched
  console.log(c.yellow(`➕ NEW — not in Ditto yet (${unmatched.length})`));
  console.log(HR);
  for (const u of unmatched) {
    const str = `"${trunc(u.string)}"`;
    const id  = c.dim(`(suggested) ${u.suggestedId}`);
    const loc = c.dim(`${relPath(u.file)}:${u.line}`);
    console.log(`  ${pad(str, COL1)} →  ${pad(id, COL2)} ${loc}`);
  }
  console.log();

  // Summary line
  console.log(HR);
  console.log(
    `${c.green(matched.length + ' matched')} · ` +
    `${c.yellow(unmatched.length + ' new')} · ` +
    `${c.dim(alreadyWrapped.length + ' already wrapped')} · ` +
    `${c.dim(allFiles.length + ' files scanned')}`
  );
  console.log();

  // Report (initial, no push data)
  console.log();

  // Push flow (only when --push flag is set)
  let pushed = [], pushFailed = [];

  if (flags.push) {
    if (unmatched.length === 0) {
      console.log(c.green('Nothing to push — all strings are already in Ditto.'));
      console.log();
    } else {
      const maskedKey = '****' + DITTO_KEY.slice(-4);
      console.log(c.yellow(`➕ Ready to push ${unmatched.length} new components to Ditto.`));
      console.log(c.dim(`   API key: ${maskedKey}`));
      console.log(c.dim(`   Endpoint: api.dittowords.com`));
      console.log();

      let doPush = flags.yes;
      if (!doPush) {
        const ans = await prompt('? Proceed? (y/N) ');
        doPush = /^y$/i.test(ans.trim());
        if (!doPush) {
          console.log(c.dim('Aborted. Nothing was pushed.'));
          console.log();
        }
      }

      if (doPush) {
        // Per-item review: let user skip, accept, or rename the suggested ID
        let toPush = unmatched;
        if (!flags.yes) {
          toPush = [];
          console.log(c.bold(`Reviewing ${unmatched.length} new string${unmatched.length !== 1 ? 's' : ''} before push`));
          console.log(HR);
          console.log(c.dim('  Each string will be created as a new Ditto component.'));
          console.log(c.dim('  Review the suggested ID and copy text before confirming.\n'));
          console.log(c.dim('  [y] push this string        [s] skip (don\'t push)'));
          console.log(c.dim('  [e] edit the string text    [i] edit the component ID'));
          console.log(c.dim('  [a] push all remaining      [q] stop here'));
          console.log();
          let pushAll = false;
          let reviewIndex = 0;
          for (let ui = 0; ui < unmatched.length; ui++) {
            let u = { ...unmatched[ui] };
            if (pushAll) { toPush.push(u); continue; }
            reviewIndex++;

            // Loop so user can edit then re-review the same entry
            while (true) {
              const loc     = c.dim(`${relPath(u.file)}:${u.line}`);
              const counter = c.dim(`(${reviewIndex}/${unmatched.length})`);
              console.log(`${counter}  ${loc}`);
              console.log(`  ${c.bold('String')}  "${trunc(u.string, 60)}"`);
              console.log(`  ${c.bold('ID')}      ${u.suggestedId}`);
              process.stdout.write(`  Action [y/s/e/i/a/q]: `);
              const ans2 = await prompt('');
              const k    = ans2.trim();
              const kl   = k.toLowerCase();

              if (kl === 'a') {
                console.log(c.dim('  → pushing all remaining'));
                console.log();
                pushAll = true; toPush.push(u); break;
              } else if (kl === 'q') {
                console.log(c.dim('  → stopped. Only previously accepted strings will be pushed.'));
                console.log();
                ui = unmatched.length; break;
              } else if (kl === 's') {
                console.log(c.dim('  → skipped'));
                console.log();
                break;
              } else if (kl === 'y' || k === '') {
                console.log(c.dim(`  → will push as "${u.suggestedId}"`));
                console.log();
                toPush.push(u); break;
              } else if (kl === 'e') {
                process.stdout.write(c.dim('  New string text: '));
                const newText = (await prompt('')).trim();
                if (newText) {
                  u = { ...u, string: newText };
                  console.log(c.dim(`  ✎ text updated to "${trunc(newText, 55)}"`));
                  // Re-check if edited text now matches an existing Ditto component
                  const reHits = dittoByText.get(newText.toLowerCase())
                    || dittoByNorm.get(norm(newText))
                    || dittoById.get(norm(newText));
                  if (reHits && reHits.length) {
                    console.log(c.cyan(`  ✦ edited text matches existing Ditto component${reHits.length > 1 ? 's' : ''}:`));
                    reHits.forEach((comp, i) => {
                      const id = comp.developerId || comp.id;
                      console.log(`    ${c.dim('[' + (i + 1) + ']')} ${id}  ${c.dim('"' + trunc(comp.text || '', 45) + '"')}`);
                    });
                    console.log(`    ${c.dim('[n]')} keep as new and continue editing`);
                    process.stdout.write('  Use existing? ');
                    const pick = await prompt('');
                    const pn = parseInt(pick.trim(), 10);
                    if (!isNaN(pn) && pn >= 1 && pn <= reHits.length) {
                      const comp = reHits[pn - 1];
                      matched.push({ ...u, developerId: comp.developerId || comp.id });
                      console.log(c.green(`  → matched to existing "${comp.developerId || comp.id}" (won't be pushed)`));
                      console.log();
                      break;
                    }
                  }
                } else {
                  console.log(c.dim('  (no change)'));
                }
                console.log();
                // loop again to re-show the updated entry
              } else if (kl === 'i') {
                process.stdout.write(c.dim('  New component ID: '));
                const newId = (await prompt('')).trim();
                if (newId) {
                  u = { ...u, suggestedId: newId };
                  console.log(c.dim(`  ✎ ID updated to "${newId}"`));
                } else {
                  console.log(c.dim('  (no change)'));
                }
                console.log();
                // loop again to re-show the updated entry
              } else {
                console.log(c.dim(`  ✎ ID updated to "${k}"`));
                console.log();
                toPush.push({ ...u, suggestedId: k }); break;
              }
            }
          }
          console.log(HR);
          if (toPush.length === 0) {
            console.log(c.dim('Nothing selected to push.'));
            console.log();
            doPush = false;
          } else {
            console.log(c.dim(`Pushing ${toPush.length} of ${unmatched.length} strings…\n`));
          }
        }

        for (const u of toPush) {
          const str = `"${trunc(u.string, 40)}"`;
          process.stdout.write(`  Pushing ${str}… `);
          let res;
          let usedId = u.suggestedId;
          try {
            res = await pushComponent(u.string, u.string, usedId);
          } catch (e) {
            process.stdout.write(c.red(`❌ failed`) + c.dim(` (network error: ${e.message})\n`));
            pushFailed.push({ string: u.string, suggestedId: usedId, error: e.message, file: u.file, line: u.line });
            continue;
          }

          if (res.status === 409) {
            process.stdout.write(c.dim(`(HTTP 409 — ID conflict, retrying…)\n  Pushing ${str}… `));
            usedId = usedId + '-2';
            try {
              res = await pushComponent(u.string, u.string, usedId);
            } catch (e) {
              process.stdout.write(c.red(`❌ failed`) + c.dim(` (network error: ${e.message})\n`));
              pushFailed.push({ string: u.string, suggestedId: usedId, error: e.message, file: u.file, line: u.line });
              continue;
            }
          }

          if (res.status === 201 || res.status === 200) {
            process.stdout.write(c.green(`✅ created`) + c.dim(`   (${usedId})\n`));
            pushed.push({ string: u.string, developerId: usedId, file: u.file, line: u.line });
          } else {
            let errMsg;
            try {
              const parsed = JSON.parse(res.body);
              errMsg = parsed.message || parsed.error || parsed.detail || JSON.stringify(parsed);
            } catch { errMsg = res.body ? res.body.slice(0, 200) : `HTTP ${res.status}`; }
            if (res.status === 409) errMsg = 'conflict after retry';
            process.stdout.write(c.red(`❌ failed`) + c.dim(`   (${errMsg})\n`));
            pushFailed.push({ string: u.string, suggestedId: usedId, error: errMsg, file: u.file, line: u.line });
          }
        }

        console.log();
        console.log(HR);
        console.log(`${c.green(`✅ ${pushed.length} created`)} · ${c.red(`❌ ${pushFailed.length} failed`)}`);
        console.log();

        if (pushFailed.length > 0) {
          console.log('Failed:');
          for (const f of pushFailed) {
            console.log(`  ${c.dim('"' + trunc(f.string) + '"')}  →  ${f.suggestedId}  ${c.red('(' + f.error + ')')}`);
          }
          console.log();
        }

        // Update report with push data
        console.log();
      }
    }
  }

  // Interactive "what's next" menu (skip when --yes or non-TTY)
  if (!flags.yes && process.stdin.isTTY) {
    await whatNextMenu({ matched, unmatched, pushed, paths });
  }
}

async function whatNextMenu({ matched, unmatched, pushed, paths }) {
  const remaining   = unmatched.length - pushed.length;
  const pathArg     = paths.join(' ');
  // All strings that now have a confirmed developerId (matched + successfully pushed)
  const resolved    = [
    ...matched,
    ...pushed,
  ];

  const options = [];

  if (remaining > 0) {
    options.push({
      key: 'p',
      label: `Push ${remaining} new string${remaining !== 1 ? 's' : ''} to Ditto`,
      hint: `dittomato ${pathArg} --push`,
    });
  }

  if (resolved.length > 0) {
    options.push({
      key: 'w',
      label: `Replace strings in source files with t() calls`,
      hint: resolved.length + ' strings across ' + new Set(resolved.map(r => r.file)).size + ' files',
    });
  }

  options.push({
    key: 'q',
    label: 'Quit',
  });

  console.log(c.bold('What\'s next?'));
  console.log(HR);
  for (const o of options) {
    const hint = o.hint ? c.dim(`  (${o.hint})`) : '';
    console.log(`  ${c.bold('[' + o.key + ']')}  ${o.label}${hint}`);
  }
  console.log();

  const ans = await prompt('Choice: ');
  const key = ans.trim().toLowerCase();
  console.log();

  const chosen = options.find(o => o.key === key);
  if (!chosen || chosen.key === 'q') {
    console.log(c.dim('Done. 🍅'));
    console.log();
    return;
  }

  if (chosen.key === 'p') {
    const { spawn } = require('child_process');
    const args = [...paths, '--push'];
    if (flags.noColor) args.push('--no-color');
    spawn(process.execPath, [__filename, ...args], { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0));
    return;
  }

  if (chosen.key === 'w') {
    await replaceInFiles(resolved);
    return;
  }

}

// ── Replace strings in source files ───────────────────────────────────────
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convert a developerId like "search.assets-placeholder" → "searchAssetsPlaceholderText"
function idToVarName(developerId) {
  return developerId
    .split(/[.\-_]/)
    .map((w, i) => i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join('') + 'Text';
}

// Find `import { Ditto } from '...'` in a file, return the relative path
function detectDittoImport(content) {
  const m = content.match(/import\s+\{[^}]*\bDitto\b[^}]*\}\s+from\s+['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// Find `import { useDittoWrapper } from '...'` in a file, return the relative path
function detectWrapperImport(content) {
  const m = content.match(/import\s+\{[^}]*\buseDittoWrapper\b[^}]*\}\s+from\s+['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// Given lines[], find the index of the nearest `return (` searching backwards from fromLine
function findReturnLine(lines, fromLine) {
  for (let i = fromLine; i >= 0; i--) {
    if (/^\s*return[\s(]/.test(lines[i])) return i;
  }
  return -1;
}

// Insert lines before a given line index, preserving indentation of that line
function insertBeforeLine(lines, atIndex, newLines) {
  const indent = (lines[atIndex] || '').match(/^(\s*)/)[1];
  lines.splice(atIndex, 0, ...newLines.map(l => indent + l));
}

// Given a relative import path found in sourceFile, resolve it to an absolute path
function resolveModulePath(sourceFile, relImport) {
  if (!relImport.startsWith('.')) return null; // alias, can't resolve
  return path.resolve(path.dirname(sourceFile), relImport);
}

// Compute a relative import from targetFile to the absolute module path
function relativeImport(targetFile, absoluteModule) {
  let rel = path.relative(path.dirname(targetFile), absoluteModule);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// Insert an import line after the last existing import statement in the file
function insertImport(content, importLine) {
  // Find the last line starting with 'import '
  const lines  = content.split('\n');
  let lastIdx  = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i])) lastIdx = i;
  }
  const insertAfter = lastIdx >= 0 ? lastIdx : -1;
  lines.splice(insertAfter + 1, 0, importLine);
  return lines.join('\n');
}

async function replaceInFiles(resolved) {
  if (resolved.length === 0) {
    console.log(c.dim('Nothing to replace.'));
    console.log();
    return;
  }

  // Group by file
  const byFile = new Map();
  for (const entry of resolved) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry);
  }

  // Find the absolute path of Ditto and useDittoWrapper modules
  let dittoModuleAbs   = null;
  let wrapperModuleAbs = null;
  if (importFrom) {
    // --import-from given: treat as absolute or relative to cwd
    dittoModuleAbs = path.resolve(process.cwd(), importFrom);
  } else {
    for (const file of allFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const rel = detectDittoImport(content);
        if (rel) {
          dittoModuleAbs = resolveModulePath(file, rel);
          // resolveModulePath returns null for aliases (@/...) — keep searching for a relative import
          if (dittoModuleAbs) break;
        }
      } catch {}
    }
  }
  if (!dittoModuleAbs) {
    process.stdout.write(c.dim('Ditto module path not resolved.\nEnter path to lib/ditto relative to cwd (e.g. src/lib/ditto), or leave blank to skip adding imports: '));
    const ans = (await prompt('')).trim();
    console.log();
    if (ans && (ans.includes('/') || ans.startsWith('.'))) {
      dittoModuleAbs = path.resolve(process.cwd(), ans);
    } else if (ans) {
      console.log(c.dim('  Skipping Ditto import insertion (input did not look like a path).'));
    }
  }

  // Resolve useDittoWrapper module path (for string-only props)
  if (!importFrom) {
    for (const file of allFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const rel = detectWrapperImport(content);
        if (rel) {
          wrapperModuleAbs = resolveModulePath(file, rel);
          if (wrapperModuleAbs) break;
        }
      } catch {}
    }
  }
  if (!wrapperModuleAbs) {
    process.stdout.write(c.dim('useDittoWrapper import not detected.\nEnter path to useDittoWrapper hook relative to cwd (e.g. src/hooks/common/useDittoWrapper), or leave blank to skip: '));
    const ans = (await prompt('')).trim();
    console.log();
    if (ans && (ans.includes('/') || ans.startsWith('.'))) {
      wrapperModuleAbs = path.resolve(process.cwd(), ans);
    }
  }

  // Preview + build plan
  console.log(c.bold(`📝 Replacing strings in ${byFile.size} file${byFile.size !== 1 ? 's' : ''}…`));
  console.log(HR);

  const plan = [];
  for (const [file, entries] of byFile) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { console.log(c.red(`  ❌ cannot read ${relPath(file)}`)); continue; }

    const hasDittoImport   = detectDittoImport(content) !== null;
    const hasWrapperImport = detectWrapperImport(content) !== null;
    const changes    = []; // { string, developerId, mode }
    const constDecls = []; // { varName, developerId, lineIndex } — for string-only props

    const REACT_NODE_PROP_RE_SRC = PROP_NAMES.filter(p => !STRING_ONLY_PROPS.has(p)).join('|');

    for (const { string, developerId, kind } of entries) {
      const esc  = escapeRegex(string);
      const comp = `<Ditto componentId="${developerId}" />`;

      const stringOnlyRe = new RegExp(`(?<![-\\w])(${[...STRING_ONLY_PROPS].join('|')})=["']${esc}["']`);
      const reactNodeRe  = new RegExp(`(?<![-\\w])(${REACT_NODE_PROP_RE_SRC})=["']${esc}["']`);
      const jsxTestRe    = new RegExp(`(>\\s*)${esc}(\\s*<)`);

      const inStringOnlyProp = stringOnlyRe.test(content);
      const inReactNodeProp  = reactNodeRe.test(content);
      const inJsxText        = jsxTestRe.test(content);

      // ReactNode prop replacement: propname="STRING" → propname={<Ditto componentId="id" />}
      let propReplaced = false;
      if (inReactNodeProp) {
        const propRe = new RegExp(`((?<![-\\w])(?:${REACT_NODE_PROP_RE_SRC})=)["']${esc}["']`, 'g');
        content = content.replace(propRe, `$1{${comp}}`);
        changes.push({ string, developerId, mode: 'prop' });
        propReplaced = true;
      }

      // JSX text replacement: >STRING< → ><Ditto componentId="id" /><
      if (!propReplaced || kind === 'jsx') {
        if (inJsxText) {
          content = content.replace(new RegExp(`(>\\s*)${esc}(\\s*<)`, 'g'), `$1${comp}$2`);
          if (!propReplaced) changes.push({ string, developerId, mode: 'jsx' });
        }
      }

      // String-only prop: replace value with a variable, insert const before return
      if (inStringOnlyProp) {
        const varName = idToVarName(developerId);
        // Find the line index of the first occurrence
        const lines = content.split('\n');
        const soRe  = new RegExp(`\\b(?:${[...STRING_ONLY_PROPS].join('|')})=["']${esc}["']`);
        const lineIndex = lines.findIndex(l => soRe.test(l));
        if (lineIndex >= 0) {
          // Replace the string value with the variable
          content = content.replace(
            new RegExp(`((?<![-\\w])(?:${[...STRING_ONLY_PROPS].join('|')})=)["']${esc}["']`, 'g'),
            `$1{${varName}}`
          );
          constDecls.push({ varName, developerId, lineIndex });
          changes.push({ string, developerId, mode: 'string-prop', varName });
        }
      }
    }

    // Insert const declarations before the nearest return statement
    if (constDecls.length > 0) {
      const lines = content.split('\n');
      // Group by the return line they each belong to
      const byReturn = new Map();
      for (const decl of constDecls) {
        const returnLine = findReturnLine(lines, decl.lineIndex);
        const key = returnLine >= 0 ? returnLine : 0;
        if (!byReturn.has(key)) byReturn.set(key, []);
        byReturn.get(key).push(decl);
      }
      // Insert in reverse order so earlier insertions don't shift later indices
      const sortedReturns = [...byReturn.entries()].sort((a, b) => b[0] - a[0]);
      for (const [returnLine, decls] of sortedReturns) {
        const constLines = decls.map(d => `const ${d.varName} = useDittoWrapper({ componentId: '${d.developerId}' });`);
        insertBeforeLine(lines, returnLine, constLines);
      }
      content = lines.join('\n');
    }

    if (changes.length === 0) continue;

    // Compute import lines for this specific file
    const dittoImportLine   = dittoModuleAbs && !hasDittoImport && changes.some(ch => ch.mode !== 'string-prop')
      ? `import { Ditto } from '${relativeImport(file, dittoModuleAbs)}';`
      : null;
    const wrapperImportLine = wrapperModuleAbs && !hasWrapperImport && constDecls.length > 0
      ? `import { useDittoWrapper } from '${relativeImport(file, wrapperModuleAbs)}';`
      : null;

    const totalCount = changes.length;
    console.log(`  ${c.bold(relPath(file))}  ${c.dim(totalCount + ' replacement' + (totalCount !== 1 ? 's' : ''))}`);
    for (const ch of changes) {
      if (ch.mode === 'prop')        console.log(`    ${c.dim('"' + trunc(ch.string, 36) + '"')}  →  ${c.dim('{<Ditto componentId="' + ch.developerId + '" />')}`);
      else if (ch.mode === 'jsx')    console.log(`    ${c.dim('"' + trunc(ch.string, 36) + '"')}  →  ${c.dim('<Ditto componentId="' + ch.developerId + '" />')}`);
      else if (ch.mode === 'string-prop') console.log(`    ${c.dim('"' + trunc(ch.string, 36) + '"')}  →  ${c.dim('{' + ch.varName + '}')}  ${c.dim('+ const ' + ch.varName + ' = useDittoWrapper(...)')}`);
    }
    if (dittoImportLine)   console.log(`    ${c.green('+')} ${dittoImportLine}`);
    if (wrapperImportLine) console.log(`    ${c.green('+')} ${wrapperImportLine}`);

    plan.push({ file, content, dittoImportLine, wrapperImportLine });
  }

  if (plan.length === 0) {
    console.log(c.dim('No replaceable occurrences found in source files.'));
    console.log();
    return;
  }

  console.log();
  const confirm = await prompt('Write these changes? (y/N) ');
  console.log();
  if (!/^y$/i.test(confirm.trim())) {
    console.log(c.dim('Aborted. No files were changed.'));
    console.log();
    return;
  }

  let written = 0;
  for (const { file, content, dittoImportLine, wrapperImportLine } of plan) {
    let final = content;
    if (dittoImportLine)   final = insertImport(final, dittoImportLine);
    if (wrapperImportLine) final = insertImport(final, wrapperImportLine);
    try {
      fs.writeFileSync(file, final, 'utf8');
      console.log(c.green(`  ✅ ${relPath(file)}`));
      written++;
    } catch (e) {
      console.log(c.red(`  ❌ ${relPath(file)}  (${e.message})`));
    }
  }

  console.log();
  console.log(`${c.green(written + ' file' + (written !== 1 ? 's' : '') + ' updated')} · ${c.dim('Done. 🍅')}`);
  console.log();
}

main().catch(e => { console.error(c.red('Fatal: ' + e.message)); process.exit(1); });
