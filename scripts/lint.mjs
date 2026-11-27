#!/usr/bin/env node
// Lightweight checks with no extra dependencies: JS syntax, JSON validity, manifest sanity,
// and that every file the manifest/HTML references exists.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' ? [] :
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(ROOT);
const rel = (f) => path.relative(ROOT, f);

for (const f of files.filter((f) => /\.(m?js)$/.test(f))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { errors.push(`${rel(f)}: ${e.stderr.toString().trim()}`); }
}
for (const f of files.filter((f) => f.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { errors.push(`${rel(f)}: ${e.message}`); }
}

const ext = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) errors.push('manifest: manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) errors.push(`manifest: bad version ${manifest.version}`);
const refs = [
  manifest.background?.service_worker,
  manifest.storage?.managed_schema,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  'src/content.js',
];
for (const r of refs.filter(Boolean)) if (!fs.existsSync(path.join(ext, r))) errors.push(`manifest references missing file ${r}`);

for (const f of files.filter((f) => f.startsWith(ext) && f.endsWith('.html'))) {
  const html = fs.readFileSync(f, 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), ref))) errors.push(`${rel(f)}: missing ${ref}`);
  }
}

const schema = JSON.parse(fs.readFileSync(path.join(ext, 'schema.json'), 'utf8'));
for (const [k, v] of Object.entries(schema.properties)) {
  if (!v.title || !v.description) errors.push(`schema: ${k} needs title and description (used for ADMX)`);
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`lint ok (${files.length} files)`);
