/**
 * firestore-rest.js — the shared Dittomato string data model + chunk helpers,
 * plus a dependency-free Firestore REST client. UMD, so it's used by:
 *   - the Node CLI (harvest.js) and migration (migrate.js) -> require('./firestore-rest')
 *   - the browser editor (index.html) -> window.FirestoreREST (constants + routing)
 *
 * v2 chunked-index model — strings live in a few aggregate docs:
 *   strings/__meta__        { chunks, splits, totalEntries, variants, schema }
 *   strings/__index_0__ …   { key: entry }   (each ~500 KB, sorted by key)
 * An entry: { base, de, fr, … : string | {form:text}, _master?, name? }.
 * Key helpers: entriesFromFlatMaps, packEntries, chunkIndexForKey.
 *
 * The legacy per-component helpers (emptyDoc/docToRows/docsFromFlatMaps/
 * splitTwinnedOriginals) build docs from flat i18next maps and are reused by the
 * migration to fold plurals and drop Ditto's `-original` duplicates.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FirestoreREST = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const PLURAL_RE = new RegExp(`^(.+)_(${PLURAL_FORMS.join('|')})$`);

  // ── typed-value encode / decode ────────────────────────────────────────────
  function encode(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
    return { mapValue: { fields: encodeFields(v) } };
  }
  function encodeFields(obj) {
    const fields = {};
    for (const k of Object.keys(obj)) fields[k] = encode(obj[k]);
    return fields;
  }
  function decode(val) {
    if (!val || typeof val !== 'object') return null;
    if ('stringValue' in val) return val.stringValue;
    if ('integerValue' in val) return Number(val.integerValue);
    if ('doubleValue' in val) return val.doubleValue;
    if ('booleanValue' in val) return val.booleanValue;
    if ('nullValue' in val) return null;
    if ('timestampValue' in val) return val.timestampValue;
    if ('mapValue' in val) return decodeFields(val.mapValue.fields || {});
    if ('arrayValue' in val) return (val.arrayValue.values || []).map(decode);
    return null;
  }
  function decodeFields(fields) {
    const out = {};
    for (const k of Object.keys(fields || {})) out[k] = decode(fields[k]);
    return out;
  }

  // ── data-model helpers ──────────────────────────────────────────────────────
  function emptyDoc(id) {
    return { id, name: '', projectId: null, folderId: null, base: { text: '', plurals: null }, variants: {} };
  }

  /** Ditto `?filter=all`-shaped rows for one component doc (base + variant + plural rows). */
  function docToRows(doc) {
    const rows = [];
    const meta = { name: doc.name || '', projectId: doc.projectId ?? null, folderId: doc.folderId ?? null };
    const base = doc.base || {};
    rows.push({ id: doc.id, text: base.text || '', ...meta });
    if (base.plurals) for (const f of Object.keys(base.plurals)) rows.push({ id: `${doc.id}_${f}`, pluralForm: f, text: base.plurals[f], ...meta });
    for (const vid of Object.keys(doc.variants || {})) {
      const vd = doc.variants[vid];
      if (!vd) continue;
      if (vd.text != null && vd.text !== '') rows.push({ id: doc.id, variantId: vid, text: vd.text });
      if (vd.plurals) for (const f of Object.keys(vd.plurals)) rows.push({ id: `${doc.id}_${f}`, pluralForm: f, variantId: vid, text: vd.plurals[f] });
    }
    return rows;
  }

  function docsToRows(docs) {
    return docs.flatMap(docToRows);
  }

  // Ditto keeps `{id}-original` provenance snapshots. Drop them when a live
  // `{id}` twin exists (duplicates + stale pre-edit copies); keep orphans so no
  // string becomes unreachable. Returns { kept, dropped }.
  const ORIGINAL_SUFFIX = '-original';
  function isTwinnedOriginal(id, idSet) {
    return id.endsWith(ORIGINAL_SUFFIX) && idSet.has(id.slice(0, -ORIGINAL_SUFFIX.length));
  }
  function splitTwinnedOriginals(docs) {
    const ids = new Set(docs.map(d => d.id));
    const kept = [], dropped = [];
    for (const d of docs) (isTwinnedOriginal(d.id, ids) ? dropped : kept).push(d);
    return { kept, dropped };
  }

  /**
   * Build component docs from flat i18next maps (one per variant).
   * maps = { base: {key:text}, de: {...}, fr: {...} }. Plural keys `id_form`
   * are folded into their component's plurals map.
   */
  function docsFromFlatMaps(maps) {
    const variants = Object.keys(maps);
    const docs = {}; // id -> doc
    const ensure = id => (docs[id] = docs[id] || emptyDoc(id));

    for (const variant of variants) {
      const map = maps[variant] || {};
      for (const key of Object.keys(map)) {
        const text = map[key];
        const m = key.match(PLURAL_RE);
        const id = m ? m[1] : key;
        const form = m ? m[2] : null;
        const doc = ensure(id);
        const slot = variant === 'base' ? doc.base : (doc.variants[variant] = doc.variants[variant] || { text: '', plurals: null });
        if (form) {
          slot.plurals = slot.plurals || {};
          slot.plurals[form] = text;
        } else {
          slot.text = text;
        }
      }
    }
    return Object.values(docs);
  }

  // ── chunked-index model (v2) ────────────────────────────────────────────────
  // Entry shape: { base, de, fr, … : string | {form:text}, _master?, name? }.
  // A variant value is a plain string (normal) or a map of plural forms.

  function docToEntry(doc) {
    const val = slot => (slot && slot.plurals) ? { ...slot.plurals } : (slot ? (slot.text ?? '') : '');
    const e = { base: val(doc.base) };
    for (const v of Object.keys(doc.variants || {})) {
      const slot = doc.variants[v];
      if (slot && (slot.plurals || (slot.text != null && slot.text !== ''))) e[v] = val(slot);
    }
    if (doc.base && doc.base.plurals) {
      e._master = ('other' in doc.base.plurals) ? 'other' : Object.keys(doc.base.plurals)[0];
    }
    if (doc.name) e.name = doc.name;
    return e;
  }

  /** Flat i18next maps -> { key: entry } (plurals folded, twinned -original dropped). */
  function entriesFromFlatMaps(maps) {
    const { kept } = splitTwinnedOriginals(docsFromFlatMaps(maps));
    const entries = {};
    for (const doc of kept) entries[doc.id] = docToEntry(doc);
    return entries;
  }

  /** Which chunk owns a key: number of split points <= key (binary search). */
  function chunkIndexForKey(key, splits) {
    let lo = 0, hi = splits.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (splits[mid] <= key) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /**
   * Pack a { key: entry } map into size-bounded chunks, sorted by key.
   * Returns { chunks: [{id, map}], splits } where splits[i] = first key of chunk i+1.
   */
  function packEntries(entries, targetBytes) {
    targetBytes = targetBytes || 500 * 1024;
    const enc = new TextEncoder(); // accurate UTF-8 byte count (Node 18+ & browsers)
    const bytes = s => enc.encode(s).length;
    const keys = Object.keys(entries).sort();
    const chunkMaps = [];
    const splits = [];
    let cur = {}, curSize = 2, curCount = 0;
    for (const k of keys) {
      const pieceLen = bytes(JSON.stringify(k)) + bytes(JSON.stringify(entries[k])) + 2;
      if (curCount > 0 && curSize + pieceLen > targetBytes) {
        chunkMaps.push(cur); splits.push(k);
        cur = {}; curSize = 2; curCount = 0;
      }
      cur[k] = entries[k]; curSize += pieceLen; curCount++;
    }
    if (curCount > 0) chunkMaps.push(cur);
    // Firestore reserves doc IDs matching __.*__, so use plain `index_N`.
    const chunks = chunkMaps.map((map, i) => ({ id: `index_${i}`, map }));
    return { chunks, splits };
  }

  // ── REST client ───────────────────────────────────────────────────────────
  function createClient(config) {
    const projectId = config.projectId;
    const apiKey = config.apiKey;
    const fetchImpl = config.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!projectId) throw new Error('Firestore: missing projectId');
    if (!fetchImpl) throw new Error('Firestore: no fetch implementation available');

    const DB = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const key = apiKey ? `key=${encodeURIComponent(apiKey)}` : '';
    const withKey = (url) => url + (key ? (url.includes('?') ? '&' : '?') + key : '');
    const docPath = (col, id) => `${DB}/${col}/${encodeURIComponent(id)}`;

    async function req(url, opts) {
      const res = await fetchImpl(withKey(url), opts);
      if (res.status === 404) return { notFound: true };
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || `Firestore HTTP ${res.status}`);
      return data;
    }

    async function listAll(col) {
      const out = [];
      let pageToken = '';
      do {
        const url = `${DB}/${col}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const data = await req(url);
        for (const d of data.documents || []) out.push({ id: decodeId(d.name), ...decodeFields(d.fields || {}) });
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return out;
    }

    function decodeId(name) {
      const seg = String(name).split('/').pop();
      try { return decodeURIComponent(seg); } catch { return seg; }
    }

    async function get(col, id) {
      const data = await req(docPath(col, id));
      if (data.notFound) return null;
      return { id, ...decodeFields(data.fields || {}) };
    }

    // Raw fields only (no injected `id`) — for chunk/meta/variables docs.
    async function getRaw(col, id) {
      const data = await req(docPath(col, id));
      if (data.notFound) return null;
      return decodeFields(data.fields || {});
    }

    async function write(col, id, obj) {
      const { id: _omit, ...rest } = obj;
      await req(docPath(col, id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: encodeFields({ id, ...rest }) }),
      });
      return true;
    }

    // Write a doc with EXACTLY the given fields (no injected `id`) — for chunk maps,
    // __meta__, __variables__, whose top-level keys are the payload itself.
    async function setDoc(col, id, fields) {
      await req(docPath(col, id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: encodeFields(fields) }),
      });
      return true;
    }

    async function del(col, id) {
      await req(docPath(col, id), { method: 'DELETE' });
      return true;
    }

    /** Batch upsert via :commit (chunks of 500 — Firestore's per-commit limit). */
    async function commitUpserts(col, docs) {
      let written = 0;
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const writes = chunk.map(d => {
          const { id, ...rest } = d;
          return { update: { name: `projects/${projectId}/databases/(default)/documents/${col}/${encodeURIComponent(id)}`, fields: encodeFields({ id, ...rest }) } };
        });
        await req(`${DB}:commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes }),
        });
        written += chunk.length;
      }
      return written;
    }

    /** Batch delete by id via :commit (chunks of 500). */
    async function commitDeletes(col, ids) {
      let removed = 0;
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const writes = chunk.map(id => ({ delete: `projects/${projectId}/databases/(default)/documents/${col}/${encodeURIComponent(id)}` }));
        await req(`${DB}:commit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes }),
        });
        removed += chunk.length;
      }
      return removed;
    }

    return {
      setDoc,
      getDoc: (col, id) => getRaw(col, id),
      listComponents: () => listAll('components'),
      getComponent: (id) => get('components', id),
      writeComponent: (id, obj) => write('components', id, obj),
      deleteComponent: (id) => del('components', id),
      commitComponents: (docs) => commitUpserts('components', docs),
      deleteComponents: (ids) => commitDeletes('components', ids),
      getConfig: (name) => get('config', name),
      writeConfig: (name, obj) => write('config', name, obj),
    };
  }

  return {
    PLURAL_FORMS, PLURAL_RE,
    encode, encodeFields, decode, decodeFields,
    emptyDoc, docToRows, docsToRows, docsFromFlatMaps,
    isTwinnedOriginal, splitTwinnedOriginals,
    docToEntry, entriesFromFlatMaps, chunkIndexForKey, packEntries,
    createClient,
  };
});
