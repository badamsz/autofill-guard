// Shared helpers for the browser tests.
//
// The tests expect tests/fixtures/policy.json to be installed as a managed policy for the browser
// under test (CI does this; see README). Hostnames ending in .test resolve to 127.0.0.1.

import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(HERE, '..', '..', 'extension');
export const FIXTURES = path.resolve(HERE, '..', 'fixtures');
export const EXT_ID = 'pfojbgpchchehdkfmjeblbbilmnaljoj';

/** Serve fixture pages: /<name> -> tests/fixtures/<name>.html; anything else -> index.html. */
export async function startServer() {
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '').replace(/[^a-z0-9-]/gi, '') || 'index';
    const file = path.join(FIXTURES, `${name}.html`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(fs.existsSync(file) ? file : path.join(FIXTURES, 'index.html')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { port, url: (host, p = '/') => `http://${host}:${port}${p}`, close: () => server.close() };
}

export function tempProfile(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `afg-${tag}-`));
}

export async function launch({ profile = tempProfile('e2e'), extension = true } = {}) {
  const args = ['--host-resolver-rules=MAP *.test 127.0.0.1', '--no-first-run'];
  if (process.env.CI || process.getuid?.() === 0) args.push('--no-sandbox');
  if (extension) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    // Playwright's default headless binary (chromium-headless-shell) cannot load extensions;
    // the "chromium" channel runs full Chromium in new headless mode.
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chromium' }),
    args,
  });
  if (!extension) return { ctx, profile };

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
  // Wait until the worker has finished its first apply() (content script registered).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const n = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/src/options.html`);
  const msg = (m) => page.evaluate((m) => chrome.runtime.sendMessage(m), m);
  return { ctx, sw, page, msg, profile };
}

/** Attribute snapshot of the fixture form (index.html). */
export async function snapshot(page) {
  return page.evaluate(() => {
    const q = (id) => document.getElementById(id)?.getAttribute('autocomplete') ?? null;
    return {
      form: document.getElementById('f1').getAttribute('autocomplete'),
      name: q('name'), email: q('email'), user: q('user'), pw: q('pw'), chk: q('chk'),
      ta: q('ta'), sel: q('sel'), dyn: q('dyn'),
      shadow: document.getElementById('host').shadowRoot.getElementById('shadow')?.getAttribute('autocomplete') ?? null,
      closed: window.__csr.getElementById('closedin').getAttribute('autocomplete'),
    };
  });
}

/** Single-field autocomplete entries Chrome has saved in a (closed) profile. */
export function savedAutocomplete(profile) {
  const src = path.join(profile, 'Default', 'Web Data');
  const copy = path.join(os.tmpdir(), `afg-webdata-${process.pid}-${Date.now()}.sqlite`);
  fs.copyFileSync(src, copy);
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    return db.prepare('SELECT name, value FROM autofill').all().map((r) => `${r.name}=${r.value}`);
  } finally {
    db.close();
    fs.rmSync(copy, { force: true });
  }
}

/** Type into fields and submit the form, waiting for the navigation. */
export async function fillAndSubmit(page, formId, values) {
  for (const [id, v] of Object.entries(values)) {
    await page.click(`#${id}`);
    await page.keyboard.type(v);
  }
  await Promise.all([page.waitForNavigation(), page.evaluate((f) => document.getElementById(f).requestSubmit(), formId)]);
  await page.waitForTimeout(1000); // let the browser persist the entries
}
