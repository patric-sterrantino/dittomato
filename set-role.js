#!/usr/bin/env node
/**
 * set-role.js — grant/revoke editor/viewer access by writing acl/{email} docs.
 * Uses firebase-admin (service account) since clients cannot write acl.
 *
 *   node set-role.js alice@vialytics.de admin
 *   node set-role.js bob@vialytics.de   editor
 *   node set-role.js carol@vialytics.de viewer
 *   node set-role.js dave@vialytics.de  remove
 *   node set-role.js --list
 *
 * Config from .env: FIREBASE_SERVICE_ACCOUNT_PATH (default ./serviceAccount.json).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function env() {
  const file = path.join(__dirname, '.env');
  const out = {};
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { ...out, ...process.env };
}

function db() {
  const admin = require('firebase-admin');
  const ENV = env();
  const svc = JSON.parse(fs.readFileSync(path.resolve(__dirname, ENV.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccount.json'), 'utf8'));
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(svc) });
  return admin.firestore();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    const snap = await db().collection('acl').get();
    if (snap.empty) return console.log('(no acl docs)');
    snap.forEach(d => console.log(`  ${d.id.padEnd(32)} ${d.data().role}`));
    return;
  }
  const [email, role] = args;
  if (!email || !role) { console.error('Usage: node set-role.js <email> <viewer|editor|remove>'); process.exit(1); }
  const ref = db().doc('acl/' + email.toLowerCase());
  if (role === 'remove') { await ref.delete(); console.log(`🗑  Removed ${email}`); return; }
  if (!['viewer', 'editor', 'admin'].includes(role)) { console.error('role must be viewer, editor, admin, or remove'); process.exit(1); }
  await ref.set({ role, updatedAt: new Date().toISOString() });
  console.log(`✅ ${email} → ${role}`);
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
