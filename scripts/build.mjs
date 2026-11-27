#!/usr/bin/env node
// Build release artifacts into dist/:
//
//   autofill-guard-<version>-store.zip   for Chrome Web Store / Edge Add-ons ("key" removed)
//   autofill-guard-<version>.zip         unpacked build (keeps "key", so the ID stays fixed)
//   autofill-guard-<version>.crx         signed CRX3 for self-hosted force-install   (needs key)
//   updates.xml                          update manifest for ExtensionInstallForcelist (needs key)
//   SHA256SUMS
//
// Signing key: $CRX_PRIVATE_KEY (PEM text, e.g. a CI secret) or the file at $CRX_KEY_PATH
// (default signing/key.pem). Without a key, the CRX/updates.xml steps are skipped unless
// --require-crx is passed.
//
// CRX hosting: $CRX_BASE_URL is the public URL the .crx is served from (updates.xml points
// at "$CRX_BASE_URL/autofill-guard-<version>.crx"). Defaults to this repository's GitHub
// release download URL, which only works if the repository is public.

import crx3 from 'crx3';
import yazl from 'yazl';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const NAME = 'autofill-guard';
const requireCrx = process.argv.includes('--require-crx');

const log = (...a) => console.log('[build]', ...a);
const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

export function extensionIdFromSpki(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

function writeZip(zipPath, files, overrides = {}) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const mtime = new Date('2000-01-01T00:00:00Z'); // reproducible archives
    for (const rel of files) {
      const name = rel.split(path.sep).join('/');
      if (name in overrides) zip.addBuffer(Buffer.from(overrides[name]), name, { mtime });
      else zip.addFile(path.join(SRC, rel), name, { mtime });
    }
    zip.outputStream.pipe(createWriteStream(zipPath)).on('close', resolve).on('error', reject);
    zip.end();
  });
}

async function sha256(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function loadKey() {
  if (process.env.CRX_PRIVATE_KEY?.trim()) {
    const p = path.join(DIST, '.signing-key.pem');
    await fs.writeFile(p, process.env.CRX_PRIVATE_KEY.trim() + '\n', { mode: 0o600 });
    return { keyPath: p, temporary: true };
  }
  const p = path.resolve(ROOT, process.env.CRX_KEY_PATH || 'signing/key.pem');
  try {
    await fs.access(p);
    return { keyPath: p, temporary: false };
  } catch {
    return null;
  }
}

async function main() {
  const manifestText = await fs.readFile(path.join(SRC, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const version = manifest.version;
  if (!/^\d+(\.\d+){0,3}$/.test(version)) fail(`Invalid manifest version "${version}"`);

  // On tag builds, the tag must match the manifest version.
  const ref = process.env.GITHUB_REF || '';
  if (ref.startsWith('refs/tags/v') && ref.slice('refs/tags/v'.length) !== version) {
    fail(`Tag ${ref} does not match manifest version ${version}. Bump extension/manifest.json first.`);
  }

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });
  const files = await listFiles(SRC);
  const outputs = [];

  // Unpacked zip, manifest as-is.
  const zipPath = path.join(DIST, `${NAME}-${version}.zip`);
  await writeZip(zipPath, files);
  outputs.push(zipPath);

  // Store zip: stores reject/ignore "key" and assign their own ID.
  const storeManifest = { ...manifest };
  delete storeManifest.key;
  const storePath = path.join(DIST, `${NAME}-${version}-store.zip`);
  await writeZip(storePath, files, { 'manifest.json': JSON.stringify(storeManifest, null, 2) + '\n' });
  outputs.push(storePath);
  log('zips written');

  // Signed CRX + update manifest.
  const key = await loadKey();
  if (!key) {
    if (requireCrx) fail('No signing key: set the CRX_PRIVATE_KEY secret (see README).');
    log('no signing key found; skipping .crx and updates.xml');
  } else {
    try {
      const spki = createPublicKey(createPrivateKey(await fs.readFile(key.keyPath))).export({ type: 'spki', format: 'der' });
      const keyId = extensionIdFromSpki(spki);
      const manifestId = manifest.key ? extensionIdFromSpki(Buffer.from(manifest.key, 'base64')) : null;
      if (manifestId && keyId !== manifestId) {
        fail(`Signing key produces ID ${keyId} but manifest "key" is ${manifestId}. Use the matching key or run "npm run keygen".`);
      }
      const repo = process.env.GITHUB_REPOSITORY || 'badamsz/autofill-guard';
      const base = (process.env.CRX_BASE_URL || `https://github.com/${repo}/releases/download/v${version}`).replace(/\/+$/, '');
      const crxName = `${NAME}-${version}.crx`;
      const crxPath = path.join(DIST, crxName);
      const xmlPath = path.join(DIST, 'updates.xml');
      await crx3(files.map((f) => path.join(SRC, f)), {
        keyPath: key.keyPath,
        crxPath,
        xmlPath,
        crxURL: `${base}/${crxName}`,
        appVersion: version,
        browserVersion: manifest.minimum_chrome_version,
      });
      const xml = await fs.readFile(xmlPath, 'utf8');
      if (!xml.includes(`appid="${keyId}"`) || !xml.includes(`version="${version}"`)) {
        fail(`updates.xml looks wrong:\n${xml}`);
      }
      outputs.push(crxPath, xmlPath);
      log(`crx signed as ${keyId}; codebase ${base}/${crxName}`);
      if (!process.env.CRX_BASE_URL) {
        console.warn('::warning::CRX_BASE_URL not set; updates.xml points at GitHub release downloads, which browsers can only fetch from a public repository.');
      }
    } finally {
      if (key.temporary) await fs.rm(key.keyPath, { force: true });
    }
  }

  const sums = [];
  for (const f of outputs) sums.push(`${await sha256(f)}  ${path.basename(f)}`);
  await fs.writeFile(path.join(DIST, 'SHA256SUMS'), sums.join('\n') + '\n');
  log(`done: ${outputs.map((f) => path.basename(f)).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
