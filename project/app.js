/* ───────────────────────────────────────────────────────────────────────────
   Dittomato — Ditto string editor for vialytics PMs.
   Logic ported from the original; render layer rebuilt for the vialytics system.
   All Ditto / Anthropic API behaviour is preserved verbatim.
   ─────────────────────────────────────────────────────────────────────────── */

const API_DITTO     = 'https://api.dittowords.com/v2';
const API_ANTHROPIC = 'https://api.anthropic.com/v1/messages';

const LANG_NAMES = { de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch' };

let GLOSSARY = [
  { en: "Assignee",             de: "Zugewiesene Person",                fr: "Personne assignée" },
  { en: "Assets",               de: "Inventar",                          fr: "Inventaire" },
  { en: "Asset type",           de: "Asset-Typ",                         fr: "" },
  { en: "Backlog",              de: "In Überlegung",                     fr: "" },
  { en: "Condition Assessment", de: "Zustandserfassung",                 fr: "Diagnostic Routier" },
  { en: "Cost Centers",         de: "Kostenstellen",                     fr: "Services" },
  { en: "Costs",                de: "Buchhaltung",                       fr: "Comptabilité" },
  { en: "Custom Properties",    de: "Benutzerdefinierte Eigenschaften",  fr: "" },
  { en: "Damage Classes",       de: "Schadensklassen",                   fr: "Classes de dégâts" },
  { en: "Insights",             de: "Berichte",                          fr: "Analyses" },
  { en: "Layers",               de: "Ebenen",                            fr: "Couches" },
  { en: "Material",             de: "Material",                          fr: "Matériel" },
  { en: "Road Database",        de: "Straßendatenbank",                  fr: "Base de donnée des routes" },
  { en: "Road Safety",          de: "Verkehrssicherheit",                fr: "Sécurité routière" },
  { en: "Segments",             de: "Abschnitte",                        fr: "Tronçons" },
  { en: "Settings",             de: "Einstellungen",                     fr: "Paramètres" },
  { en: "Templates",            de: "Vorlagen",                          fr: "Modèles" },
  { en: "Time Tracking",        de: "Zeiterfassung",                     fr: "Saisi des temps" },
  { en: "Treatment",            de: "Straßenbaumaßnahmen",               fr: "Réparations" },
  { en: "Treatment Planning",   de: "Maßnahmenplanung",                  fr: "Planification des réparations" },
  { en: "Treatment Type",       de: "Maßnahmentyp",                      fr: "" },
  { en: "Work Order",           de: "Auftrag",                           fr: "Tâche" },
  { en: "Work Order Type",      de: "Kategorie",                         fr: "Catégorie" },
].sort((a, b) => a.en.localeCompare(b.en));

let allVariants    = [];
let selectedComp   = null;
let variantData    = {};
let pendingChanges = {};

/* tweakable view state — content-area appearance. Layout/text style are fixed. */
window.TWEAKS = {
  /* fixed appearance — card frame on grey, baked in */
  editorLayout: 'table', monoText: true, filter: 'all', labelStyle: 'language', showSource: false,
  canvas: 'grey', frame: 'card', spacing: 'airy',
  /* tweakable */
  formality: 'neutral',   // neutral | formal | casual  → AI register
  model: 'fast',          // fast (Haiku) | quality (Sonnet)
  autofill: false,        // auto-translate missing variants on open
  placeholders: true,     // show {{variable}} chips + flag dropped ones
  showChars: true         // character counts
};

/* ── icons (24px monoline, currentColor, stroke 2 — vialytics house style) ── */
const ICONS = {
  search:  '<path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  key:     '<path d="M15 7a4 4 0 1 1-3.9 5H7v3H4v-3l3.1-.0A4 4 0 0 1 15 7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="16" cy="9" r="1.2" fill="currentColor"/>',
  check:   '<path d="M5 12.5 10 17 19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  close:   '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevron: '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  reset:   '<path d="M5 12a7 7 0 1 0 2-4.9M7 4v3.5h3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  doc:     '<path d="M7 3h7l4 4v14H7zM14 3v4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  alert:   '<path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M12 4 3 19h18Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
};
function icon(name, size = 20) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
// vialytics "magic input" sparkle (purple) — used for AI translate.
function sparkle(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 25" fill="none" aria-hidden="true">
    <path d="M8.68 16.24 5.05 14.9a.55.55 0 0 1 0-1.04l3.63-1.34a.55.55 0 0 0 .33-.33l1.34-3.63a.55.55 0 0 1 1.04 0l1.34 3.63c.06.16.17.28.33.33l3.63 1.34a.55.55 0 0 1 0 1.04l-3.63 1.34a.55.55 0 0 0-.33.33l-1.34 3.63a.55.55 0 0 1-1.04 0l-1.34-3.63a.55.55 0 0 0-.33-.33Z" fill="#ce99ef" stroke="#500081" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M17.63 7.25v4.13M14.25 4.81v2.25M15.56 9.31h4.13M13.13 5.94h2.25" stroke="#500081" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/* ── key handling + persistence ── */
const LS = { ditto: 'dittomato.dittoKey', anthropic: 'dittomato.anthropicKey' };
function getDittoKey()     { return document.getElementById('dittoKey').value.trim(); }
function getAnthropicKey() { return document.getElementById('anthropicKey').value.trim(); }

function loadKeys() {
  try {
    const d = localStorage.getItem(LS.ditto), a = localStorage.getItem(LS.anthropic);
    if (d) document.getElementById('dittoKey').value = d;
    if (a) document.getElementById('anthropicKey').value = a;
  } catch (e) {}
}
function persistKey(which) {
  try {
    const id  = which === 'ditto' ? 'dittoKey' : 'anthropicKey';
    const val = document.getElementById(id).value.trim();
    if (val) localStorage.setItem(LS[which], val); else localStorage.removeItem(LS[which]);
  } catch (e) {}
  updateConnStatus();
}
function updateConnStatus() {
  const d = !!getDittoKey(), a = !!getAnthropicKey();
  const dEl = document.getElementById('connDitto'), aEl = document.getElementById('connAnthropic');
  if (dEl) dEl.classList.toggle('on', d);
  if (aEl) aEl.classList.toggle('on', a);
  const kb = document.getElementById('keysBtnLabel');
  if (kb) kb.textContent = (d && a) ? 'Keys connected' : (d || a) ? 'Finish setup' : 'Add API keys';
  const kbBtn = document.getElementById('keysBtn');
  if (kbBtn) kbBtn.classList.toggle('attn', !(d && a));
}

function toggleKeyVis(id, btn) {
  const inp = document.getElementById(id);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
}

let keysPopOpen = false;
function toggleKeysPop(force) {
  keysPopOpen = force === undefined ? !keysPopOpen : force;
  document.getElementById('keysPop').classList.toggle('open', keysPopOpen);
  document.getElementById('keysBtn').classList.toggle('active', keysPopOpen);
}
document.addEventListener('click', (e) => {
  if (!keysPopOpen) return;
  const pop = document.getElementById('keysPop'), btn = document.getElementById('keysBtn');
  if (pop && !pop.contains(e.target) && btn && !btn.contains(e.target)) toggleKeysPop(false);
});

/* ── toast ── */
function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  const mark = type === 'success' ? icon('check', 16) : type === 'info' ? sparkle(16) : icon('alert', 16);
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-ico">${mark}</span><span>${msg}</span>`;
  t.classList.add('show');
  clearTimeout(window._toastT);
  window._toastT = setTimeout(() => t.classList.remove('show'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function langName(v) {
  if (!v) return '';
  const key = String(v.name || v.id || '').toLowerCase().slice(0, 2);
  return LANG_NAMES[key] || v.name || v.id;
}

/* ── glossary prompt + UI ── */
function buildGlossaryPrompt() {
  const lines = GLOSSARY.filter(g => g.de || g.fr)
    .map(g => `- EN: "${g.en}" → DE: "${g.de||'?'}" | FR: "${g.fr||'?'}"`).join('\n');
  return `\n\nYou MUST use these canonical vialytics product terminology translations (do not deviate):\n${lines}`;
}

/* ── vialytics vocabulary — global modal ── */
function buildVocab() {
  const tbody = document.getElementById('vocabTbody');
  if (!tbody) return;
  tbody.innerHTML = GLOSSARY.map((g, i) => `
    <tr id="grow-${i}">
      <td>${esc(g.en)}</td>
      <td>${g.de ? esc(g.de) : '<span class="gl-empty">—</span>'}</td>
      <td>${g.fr ? esc(g.fr) : '<span class="gl-empty">—</span>'}</td>
    </tr>`).join('');
  const count = document.getElementById('vocabCount');
  if (count) count.textContent = `${GLOSSARY.length} terms`;
}
function openVocab() {
  document.getElementById('vocabModal').classList.add('open');
  const inp = document.getElementById('vocabSearch');
  if (inp) { inp.value = ''; filterGlossary(''); setTimeout(() => inp.focus(), 50); }
}
function closeVocab() {
  document.getElementById('vocabModal').classList.remove('open');
}
function filterGlossary(q) {
  const lower = q.toLowerCase();
  GLOSSARY.forEach((g, i) => {
    const match = !q || g.en.toLowerCase().includes(lower) || g.de.toLowerCase().includes(lower) || g.fr.toLowerCase().includes(lower);
    const row = document.getElementById(`grow-${i}`);
    if (row) row.classList.toggle('hidden-row', !match);
  });
}

/* ── Ditto fetch ── */
async function ensureVariants() {
  if (allVariants.length) return;
  const res = await fetch(`${API_DITTO}/variants`, { headers: { Authorization: getDittoKey() } });
  if (!res.ok) throw new Error('Could not fetch variants');
  allVariants = await res.json();
}

async function doSearch() {
  const q = document.getElementById('searchQuery').value.trim().toLowerCase();
  if (!q) return;
  const k = getDittoKey();
  if (!k) { toast('Add your Ditto API key first', 'error'); toggleKeysPop(true); return; }

  const btn = document.getElementById('searchBtn');
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  document.getElementById('results').innerHTML = '<div class="result-loading"><span class="spinner spinner-dark"></span> Searching all languages…</div>';

  try {
    await ensureVariants();
    // fetch every component WITH all its variants so we can match translated text too
    const filter = encodeURIComponent(JSON.stringify({ variants: [{ id: 'all' }] }));
    const res = await fetch(`${API_DITTO}/components?filter=${filter}`, { headers: { Authorization: k } });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message||`HTTP ${res.status}`); }
    const rows = await res.json();

    // group rows (base + variants) by component developer id
    const groups = {};
    rows.forEach(c => {
      const id = c.id;
      if (!groups[id]) groups[id] = { base: null, variants: [] };
      if (c.variantId) groups[id].variants.push(c);
      else groups[id].base = c;
    });

    const vName = id => (allVariants.find(v => v.id === id)?.name) || id;
    const matches = [];
    for (const id in groups) {
      const g = groups[id];
      const base = g.base || g.variants[0];
      if (!base) continue;
      // metadata match (id / name / base text)
      const metaHit = (base.id && base.id.toLowerCase().includes(q)) ||
                      (base.name && base.name.toLowerCase().includes(q)) ||
                      (base.text && base.text.toLowerCase().includes(q));
      // variant text match (German, French, …)
      const vHit = g.variants.find(v => v.text && v.text.toLowerCase().includes(q));
      if (!metaHit && !vHit) continue;
      const item = { ...base };
      if (!metaHit && vHit) {
        item._matchLang = langName({ id: vHit.variantId, name: vName(vHit.variantId) }) || vName(vHit.variantId);
        item._matchText = vHit.text;
      }
      matches.push(item);
    }
    matches.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    renderResults(matches.slice(0, 30));
  } catch(e) {
    document.getElementById('results').innerHTML = '';
    toast('Search failed: ' + e.message, 'error');
  } finally {
    btn.innerHTML = icon('search', 18) + 'Search';
    btn.disabled = false;
  }
}

function renderResults(items) {
  const el = document.getElementById('results');
  const count = document.getElementById('resultCount');
  if (!items.length) {
    el.innerHTML = `<div class="empty-sm">${icon('search', 22)}<p>No components match that query.</p></div>`;
    if (count) count.textContent = '';
    return;
  }
  window._results = items;
  if (count) count.textContent = `${items.length} result${items.length>1?'s':''}`;
  el.innerHTML = items.map((c, i) => `
    <button class="result-item" onclick="selectItem(${i})" id="result-${i}">
      <div class="result-top">
        <span class="result-id">${esc(c.id)}</span>
        ${c.status ? `<span class="result-status">${esc(c.status)}</span>` : ''}
      </div>
      <div class="result-text">${esc(c.text) || '<span class="muted">— no text —</span>'}</div>
      ${c._matchLang ? `<div class="result-match"><span class="rm-tag">${esc(c._matchLang)}</span>${esc(c._matchText)}</div>` : ''}
      <div class="result-meta">${c.name ? esc(c.name) : ''}${c.name && c.folderId ? ' · ' : ''}${c.folderId ? esc(c.folderId) : (c.name ? '' : 'root')}</div>
    </button>`).join('');
}

async function selectItem(i) {
  selectedComp   = window._results[i];
  pendingChanges = {};
  document.querySelectorAll('.result-item').forEach((el, j) => el.classList.toggle('selected', j === i));

  document.getElementById('editorEmpty').style.display = 'none';
  const ed = document.getElementById('editor');
  ed.style.display = 'flex';
  document.getElementById('editorLabel').textContent = selectedComp.name || selectedComp.id;
  document.getElementById('editorId').textContent = selectedComp.id;
  document.getElementById('variantEditor').innerHTML =
    '<div class="loading-variants"><span class="spinner spinner-dark"></span> Loading variants…</div>';
  document.getElementById('editorFoot').style.display = 'none';

  try {
    const filter = encodeURIComponent(JSON.stringify({ variants: [{ id: 'all' }] }));
    const res = await fetch(`${API_DITTO}/components?filter=${filter}`, { headers: { Authorization: getDittoKey() } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    variantData = {};
    all.filter(c => c.id === selectedComp.id).forEach(c => {
      const vid = c.variantId ?? 'base';
      variantData[vid] = { text: c.text ?? '', originalText: c.text ?? '', status: c.status };
    });
    renderVariantEditor();
    document.getElementById('editorFoot').style.display = 'flex';
    if (window.TWEAKS.autofill && getAnthropicKey()) {
      const anyMissing = allVariants.some(v => !variantData[v.id]?.text);
      if (anyMissing) setTimeout(() => translateAll(), 150);
    }
  } catch(e) {
    document.getElementById('variantEditor').innerHTML =
      `<div class="empty-sm">${icon('alert', 22)}<p>Failed to load variants: ${esc(e.message)}</p></div>`;
  }
}

/* ── variant rows model ── */
function variantRows() {
  const byId = window.TWEAKS.labelStyle === 'id';
  return [
    { id: 'base', name: 'Base', label: 'Base (source)', isBase: true },
    ...allVariants.map(v => ({ id: v.id, name: v.name, label: byId ? (v.name || v.id) : (langName(v) || v.name), isBase: false }))
  ];
}
function displayRows() {
  const rows = variantRows();
  if (window.TWEAKS.filter === 'missing') {
    return rows.filter(v => v.isBase || !variantData[v.id]?.text);
  }
  return rows;
}
function baseText() {
  const live = document.getElementById('vtext-base');
  return (live ? live.value : (variantData['base']?.text ?? '')) || '';
}

function renderVariantEditor() {
  const rows = displayRows();

  const layout = window.TWEAKS.editorLayout;
  let editorBody;
  if (rows.length <= 1 && window.TWEAKS.filter === 'missing') {
    editorBody = `<div class="empty-sm">${icon('check', 22)}<p>All variants are translated.</p></div>`;
  } else if (layout === 'table')   editorBody = renderTable(rows);
  else if (layout === 'stacked')   editorBody = renderStacked(rows);
  else                             editorBody = renderColumns(rows);

  document.getElementById('variantEditor').innerHTML = editorBody;
  document.querySelectorAll('.variant-textarea').forEach(autoResize);
  Object.keys(pendingChanges).forEach(vid => setIndicator(vid, 'unsaved', 'Unsaved'));
  updateTranslateAllBtn();
  updateChangesSummary();
}

function isFilled(vid) {
  const ta = document.getElementById(`vtext-${vid}`);
  const val = ta ? ta.value : (variantData[vid]?.text || '');
  return String(val).trim() !== '';
}
function updateMagicVis(vid) {
  const b = document.getElementById(`vmagic-${vid}`);
  if (b) b.style.display = isFilled(vid) ? 'none' : 'inline-flex';
}
function updateTranslateAllBtn() {
  const btn = document.getElementById('magicAllBtn');
  if (!btn) return;
  const missing = variantRows().some(v => !v.isBase && !isFilled(v.id));
  const hasKey = !!getAnthropicKey();
  btn.style.display = missing ? 'inline-flex' : 'none';
  btn.innerHTML = (hasKey ? sparkle(15) : icon('key', 15)) + (hasKey ? 'Translate all' : 'Add key to translate');
}

/* per-cell head bits shared across layouts */
function subId(v) {
  // show the raw variant name only when it adds info beyond the language label
  return (!v.isBase && v.name && v.name !== v.label) ? `<span class="vcol-id">${esc(v.name)}</span>` : '';
}
function statusPill(v) {
  if (v.isBase) return `<span class="vpill base">Source</span>`;
  const has = variantData[v.id]?.text;
  return has
    ? `<span class="vpill ok" id="vtag-${esc(v.id)}">${icon('check', 13)}Translated</span>`
    : `<span class="vpill miss" id="vtag-${esc(v.id)}">Missing</span>`;
}
function cellActions(v) {
  return `<div class="vcell-actions">
    <span id="vsave-${esc(v.id)}" class="save-ind"></span>
    ${!v.isBase ? `<button class="icon-btn magic" id="vmagic-${esc(v.id)}" onclick="translateOne('${esc(v.id)}','${esc(v.name)}')" title="Translate with AI">${sparkle(16)}</button>` : ''}
    <button class="btn btn-ghost btn-xs" id="vsavebtn-${esc(v.id)}" style="display:none" onclick="saveVariant('${esc(v.id)}')">Save</button>
  </div>`;
}
function textarea(v) {
  const d = variantData[v.id];
  const textVal = d?.text ?? '';
  const empty = !textVal && !v.isBase;
  return `<textarea class="variant-textarea${empty ? ' is-empty' : ''}${window.TWEAKS.monoText ? ' mono-text' : ''}" id="vtext-${esc(v.id)}" rows="2"
    placeholder="${esc(v.isBase ? 'Source text…' : (v.label) + ' translation…')}"
    oninput="onInput('${esc(v.id)}',this)">${esc(textVal)}</textarea>`;
}
// optional faint English source line shown above each translation
function sourceRef(v) {
  if (!window.TWEAKS.showSource || v.isBase) return '';
  const bt = baseText();
  if (!bt) return '';
  return `<div class="vsource"><span class="vsource-lbl">Source</span>${esc(bt)}</div>`;
}
function bodyContent(v) { return sourceRef(v) + textarea(v) + placeholderRow(v); }

/* placeholder QA: detect {{variables}}, flag any the translation dropped */
function tokensOf(s) { return String(s ?? '').match(/\{\{[^}]+\}\}/g) || []; }
function phChips(vid, text, isBase) {
  const fTokens = tokensOf(text);
  let chips = fTokens.map(t => `<span class="ph-chip">${esc(t)}</span>`);
  if (!isBase) {
    const missing = tokensOf(baseText()).filter(bt => !fTokens.includes(bt));
    chips = chips.concat(missing.map(t => `<span class="ph-chip miss">${icon('alert', 12)}${esc(t)}</span>`));
  }
  return chips.join('');
}
function placeholderRow(v) {
  if (!window.TWEAKS.placeholders) return '';
  return `<div class="ph-row" id="phrow-${esc(v.id)}">${phChips(v.id, variantData[v.id]?.text ?? '', v.isBase)}</div>`;
}
function refreshPh(vid) {
  if (!window.TWEAKS.placeholders) return;
  const row = document.getElementById(`phrow-${vid}`);
  if (row) row.innerHTML = phChips(vid, document.getElementById(`vtext-${vid}`)?.value || '', vid === 'base');
}
function charCount(v) {
  if (!window.TWEAKS.showChars) return '<span></span>';
  const len = (variantData[v.id]?.text ?? '').length;
  return `<span class="char-count" id="vchars-${esc(v.id)}">${len} chars</span>`;
}

/* layout: columns (diff-style, base pinned left) */
function renderColumns(rows) {
  const cols = rows.map(v => `
    <div class="vcol${v.isBase ? ' base-col' : ''} ${!v.isBase && !variantData[v.id]?.text ? 'is-missing' : ''}" id="vblock-${esc(v.id)}">
      <div class="vcol-head">
        <div class="vcol-name">
          <span class="vcol-lang">${esc(v.label)}</span>
          ${subId(v)}
        </div>
      </div>
      <div class="vcol-body">${bodyContent(v)}</div>
      <div class="vcol-foot">${charCount(v)}${cellActions(v)}</div>
    </div>`).join('');
  return `<div class="vcols-wrap"><div class="vcols">${cols}</div></div>`;
}

/* layout: stacked */
function renderStacked(rows) {
  const blocks = rows.map(v => `
    <div class="vstack${v.isBase ? ' base-col' : ''} ${!v.isBase && !variantData[v.id]?.text ? 'is-missing' : ''}" id="vblock-${esc(v.id)}">
      <div class="vstack-head">
        <div class="vcol-name">
          <span class="vcol-lang">${esc(v.label)}</span>
          ${subId(v)}
        </div>
        ${cellActions(v)}
      </div>
      <div class="vstack-body">${bodyContent(v)}</div>
      <div class="vstack-foot">${charCount(v)}</div>
    </div>`).join('');
  return `<div class="vstack-list">${blocks}</div>`;
}

/* layout: table */
function renderTable(rows) {
  const trs = rows.map(v => `
    <tr class="${v.isBase ? 'base-row' : ''} ${!v.isBase && !variantData[v.id]?.text ? 'is-missing' : ''}" id="vblock-${esc(v.id)}">
      <td class="vt-lang">
        <div class="vcol-name">
          <span class="vcol-lang">${esc(v.label)}</span>
          ${subId(v)}
        </div>
      </td>
      <td class="vt-text">${bodyContent(v)}
        <div class="vt-foot">
          ${charCount(v)}
          <div class="vt-foot-r">
            <span id="vsave-${esc(v.id)}" class="save-ind"></span>
            <button class="btn btn-ghost btn-xs" id="vrevertbtn-${esc(v.id)}" style="display:none" onclick="revertVariant('${esc(v.id)}')">Revert</button>
            <button class="btn btn-ghost btn-xs" id="vsavebtn-${esc(v.id)}" style="display:none" onclick="saveVariant('${esc(v.id)}')">Save</button>
          </div>
        </div>
      </td>
      <td class="vt-act">${!v.isBase ? `<button class="icon-btn magic" id="vmagic-${esc(v.id)}" style="${variantData[v.id]?.text ? 'display:none' : ''}" onclick="translateOne('${esc(v.id)}','${esc(v.name)}')" title="Translate with AI">${sparkle(16)}</button>` : ''}</td>
    </tr>`).join('');
  return `<div class="vtable-wrap"><table class="vtable">
    <thead><tr><th>Variant</th><th>Text</th><th></th></tr></thead>
    <tbody>${trs}</tbody></table></div>`;
}

function autoResize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

function onInput(vid, ta) {
  autoResize(ta);
  const newText  = ta.value;
  const original = variantData[vid]?.originalText ?? '';
  const chars = document.getElementById(`vchars-${vid}`);
  if (chars) chars.textContent = `${newText.length} chars`;
  refreshPh(vid);
  if (vid !== 'base') updateMagicVis(vid);
  updateTranslateAllBtn();
  if (vid === 'base') variantRows().forEach(v => { if (!v.isBase) refreshPh(v.id); });
  if (newText !== original) {
    pendingChanges[vid] = newText;
    setIndicator(vid, 'unsaved', 'Unsaved');
  } else {
    delete pendingChanges[vid];
    setIndicator(vid, '', '');
  }
  updateChangesSummary();
}

function setIndicator(vid, cls, text) {
  const pending = (cls === 'unsaved' || cls === 'error');
  const sbtn = document.getElementById(`vsavebtn-${vid}`);
  if (sbtn) sbtn.style.display = pending ? 'inline-flex' : 'none';
  const rbtn = document.getElementById(`vrevertbtn-${vid}`);
  if (rbtn) rbtn.style.display = pending ? 'inline-flex' : 'none';
  const el = document.getElementById(`vsave-${vid}`);
  if (!el) return;
  el.className = `save-ind${cls ? ' '+cls : ''}`;
  el.innerHTML = text ? `<span class="dot"></span>${text}` : '';
}

function updateChangesSummary() {
  const n = Object.keys(pendingChanges).length;
  const el = document.getElementById('changesSummary');
  if (el) el.innerHTML = n > 0 ? `<span class="cs-num">${n}</span> unsaved change${n>1?'s':''}` : 'No unsaved changes';
  const btn = document.getElementById('saveAllBtn');
  if (btn) btn.disabled = n === 0;
  const reset = document.getElementById('resetBtn');
  if (reset) reset.disabled = n === 0;
}

/* ── translate ── */
async function translateOne(vid, variantName) {
  const apiKey = getAnthropicKey();
  if (!apiKey) { toast('Add your Anthropic API key first', 'error'); toggleKeysPop(true); return; }
  const baseText = variantData['base']?.text || document.getElementById('vtext-base')?.value?.trim() || '';
  if (!baseText) { toast('Base text is empty', 'error'); return; }

  const ta  = document.getElementById(`vtext-${vid}`);
  const btn = document.getElementById(`vmagic-${vid}`);
  ta.classList.add('translating-shimmer');
  if (btn) btn.disabled = true;
  setIndicator(vid, 'saving', 'Translating');

  const targetLabel = LANG_NAMES[String(variantName).toLowerCase().slice(0,2)] || variantName;
  try {
    const result = await callClaude(apiKey, baseText, targetLabel);
    ta.classList.remove('translating-shimmer');
    ta.value = result;
    autoResize(ta);
    const original = variantData[vid]?.originalText ?? '';
    if (result !== original) { pendingChanges[vid] = result; setIndicator(vid, 'unsaved', 'Unsaved'); }
    else setIndicator(vid, '', '');
    const tag = document.getElementById(`vtag-${vid}`);
    if (tag) { tag.className = 'vpill ok'; tag.innerHTML = icon('check', 13) + 'Translated'; }
    const block = document.getElementById(`vblock-${vid}`);
    if (block) block.classList.remove('is-missing');
    const chars = document.getElementById(`vchars-${vid}`);
    if (chars) chars.textContent = `${result.length} chars`;
    refreshPh(vid);
    updateMagicVis(vid);
    updateTranslateAllBtn();
    updateChangesSummary();
  } catch(e) {
    ta.classList.remove('translating-shimmer');
    setIndicator(vid, '', '');
    toast('Translation failed: ' + e.message, 'error');
    throw e;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function translateAll() {
  const apiKey = getAnthropicKey();
  if (!apiKey) { toast('Add your Anthropic API key first', 'error'); toggleKeysPop(true); return; }
  const btn = document.getElementById('magicAllBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner spinner-purple"></span> Translating…'; }
  let done = 0;
  for (const v of allVariants) {
    if (variantData[v.id]?.text) continue; // only fill missing
    try { await translateOne(v.id, v.name); done++; } catch(e) {}
  }
  if (btn) { btn.disabled = false; btn.innerHTML = sparkle(15) + 'Translate all'; }
  if (done > 0) toast(`Translated ${done} variant${done!==1?'s':''}`, 'info');
  else toast('Nothing to translate — all variants filled', 'info');
}

async function callClaude(apiKey, sourceText, targetLanguage) {
  const tone = window.TWEAKS.formality === 'formal'
      ? '\n- Use a FORMAL register (e.g. German "Sie", French "vous", Spanish "usted")'
    : window.TWEAKS.formality === 'casual'
      ? '\n- Use an INFORMAL register (e.g. German "du", French "tu", Spanish "tú")'
      : '';
  const system = `You are a professional UI copy translator for vialytics — a municipal road infrastructure SaaS used by city planners and field workers in Germany and Europe.

Translate the given UI string to ${targetLanguage}.

Rules:
- Return ONLY the translated string — no explanation, no quotes, no markdown
- Preserve any emoji exactly as-is
- Preserve any {{VariableName}} placeholders exactly as-is
- Match the tone: concise, professional, unambiguous UI copy for municipal software
- Use sentence case unless the source uses Title Case${tone}${buildGlossaryPrompt()}`;

  const model = window.TWEAKS.model === 'quality' ? 'claude-sonnet-4-5-20250929' : 'claude-haiku-4-5-20251001';

  const res = await fetch(API_ANTHROPIC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: sourceText }]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(()=>({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text ?? '';
  if (!text) throw new Error('Empty response');
  return text.trim();
}

/* ── save ── */
function revertVariant(vid) {
  const ta = document.getElementById(`vtext-${vid}`);
  if (!ta) return;
  const original = variantData[vid]?.originalText ?? '';
  ta.value = original;
  autoResize(ta);
  delete pendingChanges[vid];
  setIndicator(vid, '', '');
  const chars = document.getElementById(`vchars-${vid}`);
  if (chars) chars.textContent = `${original.length} chars`;
  refreshPh(vid);
  if (vid !== 'base') updateMagicVis(vid);
  if (vid === 'base') variantRows().forEach(v => { if (!v.isBase) refreshPh(v.id); });
  updateTranslateAllBtn();
  updateChangesSummary();
}

async function saveVariant(vid) {
  const ta = document.getElementById(`vtext-${vid}`);
  const newText = ta?.value ?? '';
  setIndicator(vid, 'saving', 'Saving');
  try {
    await patchDitto(vid, newText);
    if (!variantData[vid]) variantData[vid] = {};
    variantData[vid].text = newText;
    variantData[vid].originalText = newText;
    delete pendingChanges[vid];
    setIndicator(vid, 'saved', 'Saved');
    setTimeout(() => setIndicator(vid, '', ''), 2500);
    updateChangesSummary();
  } catch(e) {
    setIndicator(vid, 'error', 'Error');
    toast('Save failed: ' + e.message, 'error');
  }
}

async function saveAll() {
  const vids = Object.keys(pendingChanges);
  if (!vids.length) return;
  const btn = document.getElementById('saveAllBtn');
  btn.innerHTML = '<span class="spinner"></span> Saving…';
  btn.disabled = true;
  let saved = 0;
  for (const vid of vids) {
    try {
      const ta = document.getElementById(`vtext-${vid}`);
      const text = ta?.value ?? '';
      await patchDitto(vid, text);
      if (!variantData[vid]) variantData[vid] = {};
      variantData[vid].text = text;
      variantData[vid].originalText = text;
      delete pendingChanges[vid];
      setIndicator(vid, 'saved', 'Saved');
      setTimeout(() => setIndicator(vid, '', ''), 2500);
      saved++;
    } catch(e) { setIndicator(vid, 'error', 'Error'); }
  }
  btn.innerHTML = icon('check', 18) + 'Save all changes';
  updateChangesSummary();
  if (saved > 0) toast(`Saved ${saved} change${saved>1?'s':''}`, 'success');
}

async function patchDitto(vid, text) {
  const isBase = vid === 'base';
  const body = {
    updates: [{ developerId: selectedComp.id, text }],
    ...(!isBase ? { variantId: vid } : {})
  };
  const res = await fetch(`${API_DITTO}/components`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: getDittoKey() },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data.success) throw new Error(data.message || `HTTP ${res.status}`);
}

function resetAll() {
  if (!Object.keys(pendingChanges).length) return;
  pendingChanges = {};
  renderVariantEditor();
  toast('Reverted unsaved changes', 'info');
}

/* ── tweaks integration (called by the React tweaks island) ── */
function applyTweaks(t) {
  if (!t) return;
  let rerender = false;
  if (t.formality) window.TWEAKS.formality = t.formality;
  if (t.model)     window.TWEAKS.model = t.model;
  if (t.autofill     !== undefined) window.TWEAKS.autofill = t.autofill;
  if (t.placeholders !== undefined) { window.TWEAKS.placeholders = t.placeholders; rerender = true; }
  if (t.showChars    !== undefined) { window.TWEAKS.showChars = t.showChars; rerender = true; }
  syncBodyAttrs();
  if (rerender && selectedComp && Object.keys(variantData).length) renderVariantEditor();
}
function syncBodyAttrs() {
  document.body.dataset.canvas  = window.TWEAKS.canvas;
  document.body.dataset.frame   = window.TWEAKS.frame;
  document.body.dataset.spacing = window.TWEAKS.spacing;
}
window.applyTweaks = applyTweaks;

/* ── init ── */
function init() {
  loadKeys();
  updateConnStatus();
  buildVocab();
  syncBodyAttrs();
  if (!getDittoKey() || !getAnthropicKey()) setTimeout(() => toggleKeysPop(true), 350);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVocab(); });
  document.getElementById('searchQuery').focus();
}
document.addEventListener('DOMContentLoaded', init);
