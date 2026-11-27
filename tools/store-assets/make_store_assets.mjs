#!/usr/bin/env node
// Render Chrome Web Store / Edge Add-ons listing images into store/.
//
//   node tools/store-assets/make_store_assets.mjs
//
// Needs the demo policy installed as a managed policy (same directories as the e2e fixture):
//   sudo cp tools/store-assets/demo-policy.json /etc/opt/chrome_for_testing/policies/managed/
// The real popup and options page are captured from the extension, then composed into
// 1280x800 screenshots, a 440x280 promo tile, a 300x300 Edge logo and a padded 128x128 store icon.
// All outputs are flattened to 24-bit PNG (no alpha), as the Chrome Web Store requires.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'store');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'afg-assets-'));
const EXT_ID = 'pfojbgpchchehdkfmjeblbbilmnaljoj';
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
  headless: true,
  deviceScaleFactor: 2,
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chromium' }),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
for (let i = 0; i < 100; i++) {
  if ((await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)) > 0) break;
  await new Promise((r) => setTimeout(r, 100));
}

const base = `chrome-extension://${EXT_ID}/src`;
const page = await ctx.newPage();
await page.goto(`${base}/options.html`);
const managed = await page.evaluate(() => chrome.storage.managed.get(null));
if (!managed.MandatorySites) throw new Error('Demo policy not installed; see the header of this script.');
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'addUserSite', entry: 'vendor-portal.example' }));

// --- Raw captures of the real UI -------------------------------------------------------------
async function capturePopup(url, file) {
  const p = await ctx.newPage();
  // The popup reads the active tab; in a capture tab that would be itself, so present a website.
  await p.addInitScript((u) => {
    const fake = [{ id: 1, url: u, active: true }];
    chrome.tabs.query = async () => fake;
  }, url);
  await p.setViewportSize({ width: 340, height: 300 });
  await p.goto(`${base}/popup.html`);
  await p.waitForTimeout(400);
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.setViewportSize({ width: 340, height: h });
  await p.screenshot({ path: file });
  await p.close();
}
await capturePopup('https://apply.harborviewcu.example/loan', path.join(TMP, 'popup-managed.png'));
await capturePopup('https://shop.example.org/checkout', path.join(TMP, 'popup-add.png'));
await capturePopup('https://payroll-provider.example/login', path.join(TMP, 'popup-recommended.png'));

await page.setViewportSize({ width: 860, height: 900 });
await page.reload();
await page.waitForTimeout(500);
await page.evaluate(() => {
  document.querySelector('details')?.removeAttribute('open');
  // The Status card is diagnostic; leave it out so the listing image ends cleanly.
  document.getElementById('status')?.closest('section')?.remove();
});
await page.screenshot({ path: path.join(TMP, 'options.png'), fullPage: true });

// --- Composition ------------------------------------------------------------------------------
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(EXT, 'icons', '128.png')).toString('base64');
const img = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(TMP, f)).toString('base64');

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font: 16px/1.4 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; color: #1d2125; }
  .canvas { width: 1280px; height: 800px; position: relative; overflow: hidden;
            background: linear-gradient(135deg, #eef5ee 0%, #f7f9fb 55%, #e9eef6 100%); }
  .caption { position: absolute; left: 64px; top: 0; bottom: 0; width: 390px; display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; color: #2e7d32; font-size: 18px; margin-bottom: 28px; }
  .brand img { width: 40px; height: 40px; }
  h1 { font-size: 40px; line-height: 1.15; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 18px; }
  p.sub { font-size: 19px; color: #4b5563; }
  .browser { position: absolute; left: 500px; top: 70px; width: 720px; height: 660px; background: #fff; border-radius: 12px;
             box-shadow: 0 24px 60px rgba(20, 40, 30, .18), 0 2px 6px rgba(0,0,0,.08); overflow: hidden; }
  .chrome { height: 44px; background: #f1f3f4; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid #e0e3e7; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #d5d9dd; }
  .url { flex: 1; height: 28px; border-radius: 14px; background: #fff; display: flex; align-items: center; padding: 0 14px; font-size: 13px; color: #5f6b76; margin-left: 8px; }
  .tool { width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; position: relative; }
  .tool img { width: 18px; height: 18px; }
  .tool.on { background: #dfe9df; }
  .badge { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border-radius: 50%; background: #2e7d32; border: 2px solid #f1f3f4; }
  .site { padding: 34px 44px; }
  .site .logo { font-weight: 700; font-size: 20px; margin-bottom: 26px; }
  .site h2 { font-size: 24px; margin-bottom: 18px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 13px; color: #5f6b76; margin-bottom: 5px; }
  .field div { height: 38px; border: 1px solid #cfd5db; border-radius: 6px; padding: 9px 12px; font-size: 15px; }
  .field div.focus { border-color: #2e7d32; box-shadow: 0 0 0 3px rgba(46,125,50,.15); }
  .popup { position: absolute; right: 18px; top: 52px; width: 340px; border-radius: 10px; overflow: hidden;
           box-shadow: 0 12px 32px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.06); background: #fff; }
  .popup img { display: block; width: 340px; }
  .options { position: absolute; left: 500px; top: 60px; width: 720px; border-radius: 12px; overflow: hidden;
             box-shadow: 0 24px 60px rgba(20, 40, 30, .18), 0 2px 6px rgba(0,0,0,.08); background: #fff; }
  .options img { display: block; width: 720px; }
  .pill { display: inline-block; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 999px; background: #e8eefc; color: #1d4ed8; margin-top: 22px; }
`;

function siteMock({ url, logo, title, fields, popup, toolOn }) {
  return `
  <div class="browser">
    <div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <div class="url">${url}</div>
      <div class="tool ${toolOn ? 'on' : ''}"><img src="${icon}">${toolOn ? '<span class="badge"></span>' : ''}</div>
    </div>
    <div class="site">
      <div class="logo">${logo}</div>
      <h2>${title}</h2>
      ${fields.map(([l, v, focus]) => `<div class="field"><label>${l}</label><div class="${focus ? 'focus' : ''}">${v}</div></div>`).join('')}
    </div>
    <div class="popup"><img src="${popup}"></div>
  </div>`;
}

const caption = (h, sub, pill = '') => `
  <div class="caption">
    <div class="brand"><img src="${icon}">Autofill Guard</div>
    <h1>${h}</h1><p class="sub">${sub}</p>${pill ? `<div><span class="pill">${pill}</span></div>` : ''}
  </div>`;

const screens = [
  {
    file: 'screenshot-1-block-a-site.png',
    html: caption('Block autofill on any site in one click', 'Stop the browser remembering what you type on the sites you choose. Everywhere else, autofill works as usual.')
      + siteMock({
        url: 'shop.example.org/checkout', logo: 'Example Store', title: 'Checkout', toolOn: false,
        fields: [['Card number', ''], ['Name on card', ''], ['Billing address', '']],
        popup: img('popup-add.png'),
      }),
  },
  {
    file: 'screenshot-2-managed-site.png',
    html: caption('Sensitive forms stay out of autofill', 'No saved entries, no suggestions: previously typed values, addresses and cards are kept off protected sites.', 'Required by your organization')
      + siteMock({
        url: 'apply.harborviewcu.example/loan', logo: 'Harborview Credit Union', title: 'Loan application', toolOn: true,
        fields: [['Applicant name', 'Jordan Rivera', true], ['Account number', ''], ['Annual income', '']],
        popup: img('popup-managed.png'),
      }),
  },
  {
    file: 'screenshot-3-policy-managed.png',
    html: caption('Managed centrally by IT', 'Mandatory and recommended sites from Chrome or Edge enterprise policy. Lock what is blocked and whether users can add their own sites.', 'ADMX, registry, macOS and Linux templates')
      + `<div class="options"><img src="${img('options.png')}"></div>`,
  },
  {
    file: 'screenshot-4-recommended-site.png',
    html: caption('Flexible where it should be', 'Recommended sites are protected by default, and users can opt out when your policy allows it.')
      + siteMock({
        url: 'payroll-provider.example/login', logo: 'Payroll Provider', title: 'Sign in', toolOn: true,
        fields: [['Employee ID', ''], ['Password', '']],
        popup: img('popup-recommended.png'),
      }),
  },
];

async function render(html, width, height, file) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  await p.setContent(`<!doctype html><html><head><style>${CSS}</style></head><body>${html}</body></html>`);
  await p.waitForTimeout(150);
  const tmp = path.join(TMP, path.basename(file));
  await p.screenshot({ path: tmp, clip: { x: 0, y: 0, width, height } });
  await p.close();
  return tmp;
}

const rendered = [];
for (const s of screens) {
  // Rendered at 2x for crispness, then downscaled to exactly 1280x800 below.
  rendered.push([await render(`<div class="canvas">${s.html}</div>`, 1280, 800, s.file), s.file, 1280, 800]);
}

rendered.push([await render(`
  <div style="width:440px;height:280px;background:linear-gradient(135deg,#2e7d32,#1b5e20);display:flex;align-items:center;gap:22px;padding:0 34px;color:#fff;font-family:'Segoe UI',system-ui,sans-serif">
    <div style="width:104px;height:104px;border-radius:22px;background:#fff;display:grid;place-items:center;flex:none"><img src="${icon}" style="width:84px;height:84px"></div>
    <div><div style="font-size:30px;font-weight:700;line-height:1.1">Autofill Guard</div>
      <div style="font-size:16px;opacity:.92;margin-top:10px;line-height:1.35">Keep sensitive sites out of autocomplete and autofill</div></div>
  </div>`, 440, 280, 'promo-small-440x280.png'), 'promo-small-440x280.png', 440, 280]);

rendered.push([await render(`
  <div style="width:1400px;height:560px;background:linear-gradient(135deg,#2e7d32,#1b5e20);display:flex;align-items:center;gap:56px;padding:0 120px;color:#fff;font-family:'Segoe UI',system-ui,sans-serif">
    <div style="width:260px;height:260px;border-radius:52px;background:#fff;display:grid;place-items:center;flex:none"><img src="${icon}" style="width:210px;height:210px"></div>
    <div><div style="font-size:72px;font-weight:700;line-height:1.05">Autofill Guard</div>
      <div style="font-size:34px;opacity:.92;margin-top:22px;line-height:1.3">Keep sensitive sites out of autocomplete and autofill. Managed by enterprise policy.</div></div>
  </div>`, 1400, 560, 'promo-large-1400x560.png'), 'promo-large-1400x560.png', 1400, 560]);

await ctx.close();

// Flatten to RGB (no alpha) at exact sizes; icons come from the vector-ish icon renderer.
execFileSync('python3', ['-c', `
import sys
from PIL import Image
items = ${JSON.stringify(rendered.map(([src, name, w, h]) => [src, path.join(OUT, name), w, h]))}
for src, dst, w, h in items:
    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGB", im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[3])
    bg.resize((w, h), Image.LANCZOS).save(dst, optimize=True)
`]);
execFileSync('python3', [path.join(ROOT, 'tools', 'make_icons.py'), '--store', OUT]);
fs.rmSync(TMP, { recursive: true, force: true });
console.log('Store assets written to', path.relative(ROOT, OUT));
