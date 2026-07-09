#!/usr/bin/env node
/**
 * sync-server.js — local companion server for the Dittomato browser app.
 *
 * Two jobs during the Ditto -> own-servers transition:
 *   1. Serve index.html (and its relative fetches: ./package.json, .claude/skills)
 *      over http so the app runs from a real origin instead of file://.
 *   2. Expose POST /sync — the app calls it after every successful Ditto write
 *      so the same change is mirrored into src/ditto/*.json via ditto-sync.js.
 *
 *   npm run dev            # http://localhost:4747
 *   PORT=1234 npm run dev  # custom port
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const sync = require('./ditto-sync');

const PORT = parseInt(process.env.PORT, 10) || 4747;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 5e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const abs = path.normalize(path.join(ROOT, urlPath));
  if (!abs.startsWith(ROOT)) { // path-traversal guard
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/sync') {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const ops = payload.ops || (payload.op ? [payload] : []);
      const results = sync.applyOps(ops);
      const ok = results.every(r => r.ok);
      const files = [...new Set(results.flatMap(r => r.file ? [r.file] : (r.touched || [])))];
      if (ok && files.length) console.log(`  ↳ synced ${files.join(', ')}`);
      sendJson(res, ok ? 200 : 207, { ok, results });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'GET') { serveStatic(req, res); return; }

  res.writeHead(405, CORS); res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`🍅 Dittomato sync server — http://localhost:${PORT}`);
  console.log(`   app:   http://localhost:${PORT}/`);
  console.log(`   sync:  POST http://localhost:${PORT}/sync  → ${sync.dittoDir()}`);
});
