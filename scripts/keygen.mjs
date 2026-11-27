#!/usr/bin/env node
// Generate a new CRX signing key, write its public half into extension/manifest.json ("key"),
// and regenerate the policy templates for the resulting extension ID.
//
// Rotating the key CHANGES THE EXTENSION ID: existing force-install and 3rdparty policies must be
// updated to the new ID. Store the private key as the CRX_PRIVATE_KEY repository secret.

import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromSpki } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(ROOT, process.argv[2] || 'signing/key.pem');
if (fs.existsSync(out)) {
  console.error(`${path.relative(ROOT, out)} already exists; refusing to overwrite. Pass another path or move it away.`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const spki = publicKey.export({ type: 'spki', format: 'der' });
const manifestPath = path.join(ROOT, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.key = spki.toString('base64');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const id = extensionIdFromSpki(spki);
execFileSync('python3', [path.join(ROOT, 'tools', 'gen_policy_templates.py')], { stdio: 'inherit' });
console.log(`\nNew extension ID: ${id}`);
console.log(`Private key: ${path.relative(ROOT, out)} (never commit it)`);
console.log('Next: gh secret set CRX_PRIVATE_KEY < ' + path.relative(ROOT, out));
