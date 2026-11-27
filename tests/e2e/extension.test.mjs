import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer, snapshot, fillAndSubmit, savedAutocomplete, tempProfile } from './helpers.mjs';

const GUARDED = { form: 'off', name: 'off', email: 'off', user: 'off', pw: 'new-password', chk: null, ta: 'off', sel: 'off', dyn: 'off', shadow: 'off', closed: 'off' };
// Untouched page: the fixture's own script flips #name to "on" after 500ms.
const UNGUARDED = { form: null, name: 'on', email: 'email', user: 'username', pw: null, chk: null, ta: null, sel: null, dyn: null, shadow: null, closed: null };

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());

async function visit(ctx, url) {
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForTimeout(900); // fixture adds dynamic/shadow fields and fights the attribute until 500ms
  return p;
}

test('policy, content script and site management', async (t) => {
  const { ctx, sw, msg } = await launch();
  t.after(() => ctx.close());

  const { state, status } = await msg({ type: 'getState', url: 'http://a.mand.test/' });
  assert.ok(state.managed, 'fixture policy not installed: copy tests/fixtures/policy.json into the browser policy directory');

  await t.test('policy is merged with locks and invalid entries reported', () => {
    assert.deepEqual(state.mandatory.map((s) => s.label), ['*.mand.test']);
    assert.deepEqual(state.recommended.map((s) => s.label), ['*.rec.test']);
    assert.deepEqual(state.invalid.map((s) => s.raw), ['bad entry!!']);
    assert.equal(state.locks.blockPasswords, true);
    assert.equal(state.prefs.blockPasswords, true);
    assert.equal(state.locks.blockAutocomplete, false);
  });

  await t.test('locked settings cannot be changed', async () => {
    const r = await msg({ type: 'setPref', name: 'blockPasswords', value: false });
    assert.equal(r.ok, false);
  });

  await t.test('per-site autofill uses the native setting when the browser exposes it', async () => {
    const hasNative = await sw.evaluate(() => typeof chrome.privacy.services.autofillSettings !== 'undefined');
    if (!hasNative) return t.skip('browser does not expose privacy.services.autofillSettings');
    assert.equal(status.autofillMode, 'native');
    const v = await sw.evaluate(() => chrome.privacy.services.autofillSettings.get({}));
    assert.equal(v.levelOfControl, 'controlled_by_this_extension');
    assert.deepEqual(v.value.map((x) => x.urlPattern).sort(), ['[*.]mand.test', '[*.]rec.test']);
  });

  await t.test('fields are guarded on mandatory and recommended sites only', async () => {
    assert.deepEqual(await snapshot(await visit(ctx, server.url('www.mand.test'))), GUARDED);
    assert.deepEqual(await snapshot(await visit(ctx, server.url('rec.test'))), GUARDED);
    assert.deepEqual(await snapshot(await visit(ctx, server.url('other.test'))), UNGUARDED);
  });

  await t.test('user sites can be added and removed', async () => {
    assert.equal((await msg({ type: 'addUserSite', entry: '*bad*' })).ok, false);
    assert.equal((await msg({ type: 'addUserSite', entry: 'user.test' })).ok, true);
    const open = await visit(ctx, server.url('x.user.test')); // content script also reaches open tabs
    assert.deepEqual(await snapshot(open), GUARDED);
    assert.equal((await msg({ type: 'removeUserSite', key: '*://user.test' })).ok, true);
    assert.deepEqual(await snapshot(await visit(ctx, server.url('x.user.test'))), UNGUARDED);
  });

  await t.test('recommended sites can be switched off', async () => {
    assert.equal((await msg({ type: 'setRecommendedEnabled', key: '*://rec.test', enabled: false })).ok, true);
    assert.deepEqual(await snapshot(await visit(ctx, server.url('rec.test'))), UNGUARDED);
    await msg({ type: 'setRecommendedEnabled', key: '*://rec.test', enabled: true });
  });

  await t.test('password saving is suppressed only while a blocked site is active', async () => {
    const get = () => sw.evaluate(async () => (await chrome.privacy.services.passwordSavingEnabled.get({})).levelOfControl);
    const blocked = await visit(ctx, server.url('www.mand.test'));
    await blocked.bringToFront();
    await blocked.waitForTimeout(400);
    assert.equal(await get(), 'controlled_by_this_extension');
    const other = await visit(ctx, server.url('other.test'));
    await other.bringToFront();
    await other.waitForTimeout(400);
    assert.notEqual(await get(), 'controlled_by_this_extension');
  });
});

test('Chrome does not save autocomplete entries on blocked sites', async () => {
  const profile = tempProfile('save');
  const { ctx } = await launch({ profile });
  for (const [host, value] of [['other.test', 'savedOTHER'], ['www.mand.test', 'savedMAND']]) {
    const p = await visit(ctx, server.url(host));
    await fillAndSubmit(p, 'f1', { name: value });
  }
  await ctx.close();
  const saved = savedAutocomplete(profile);
  assert.ok(saved.includes('name=savedOTHER'), `control value was not saved (saved: ${saved}); test environment cannot detect saving`);
  assert.ok(!saved.includes('name=savedMAND'), 'value typed on a blocked site was saved');
});

// Canary for browser behaviour the extension depends on: autocomplete="off" (field or form) stops
// saving, while unrecognised tokens do not. If this fails after a browser update, revisit content.js.
test('browser honours autocomplete="off" for single-field autocomplete', async () => {
  const profile = tempProfile('canary');
  const { ctx } = await launch({ profile, extension: false });
  const p = await ctx.newPage();
  await p.goto(server.url('canary.test', '/variants'));
  await fillAndSubmit(p, 'f1', { plain: 'vplain', off: 'voff', bogus: 'vbogus' });
  await p.goto(server.url('canary.test', '/variants'));
  await fillAndSubmit(p, 'f2', { formoff: 'vformoff' });
  await ctx.close();
  const saved = savedAutocomplete(profile);
  assert.ok(saved.includes('plain=vplain'), `control value not saved (saved: ${saved})`);
  assert.ok(!saved.includes('off=voff'), 'field-level autocomplete=off no longer honoured');
  assert.ok(!saved.includes('formoff=vformoff'), 'form-level autocomplete=off no longer honoured');
});
