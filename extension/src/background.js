// Autofill Guard — background service worker.
//
// Responsibilities:
//  * Merge policy (chrome.storage.managed) with user settings (chrome.storage.sync) into an
//    effective site list + option set.
//  * Register a content script on matching sites that forces autocomplete="off" (single-field
//    autocomplete history is honoured by Chromium for autocomplete="off").
//  * Suppress Autofill profile data (addresses / cards) either via the browser's native per-site
//    autofill setting when the browser exposes it to extensions, or by temporarily turning the
//    global address/card autofill toggles off while a blocked site is the active tab.
//  * Optionally suppress the password manager's save prompt in the same way.

import { parseList, parseRule, ruleMatchesUrl, toMatchPatterns, toContentSettingPattern } from './rules.js';

const SCRIPT_ID = 'afg-content';
const DEFAULT_PREFS = { blockAutocomplete: true, blockAutofill: true, blockPasswords: false, showBadge: true };
const PREF_POLICY_KEYS = {
  blockAutocomplete: 'BlockAutocomplete',
  blockAutofill: 'BlockAutofill',
  blockPasswords: 'BlockPasswords',
  showBadge: 'ShowBadge',
};
const BADGE_COLOR = '#2e7d32';

// ---------------------------------------------------------------------------------------------
// State

async function readManaged() {
  try {
    return (await chrome.storage.managed.get(null)) || {};
  } catch {
    // Some Chromium derivatives throw when no managed storage backend exists.
    return {};
  }
}

async function readUser() {
  return chrome.storage.sync.get({ userSites: [], disabledRecommended: [], prefs: {} });
}

const asBool = (v) => (typeof v === 'boolean' ? v : undefined);

async function computeState() {
  const [managed, user] = await Promise.all([readManaged(), readUser()]);

  const allowUserSites = asBool(managed.AllowUserSites) ?? true;
  const allowDisablingRecommended = asBool(managed.AllowDisablingRecommended) ?? true;

  const prefs = {};
  const locks = {};
  for (const [name, policyKey] of Object.entries(PREF_POLICY_KEYS)) {
    const pol = asBool(managed[policyKey]);
    locks[name] = pol !== undefined;
    prefs[name] = pol ?? asBool(user.prefs?.[name]) ?? DEFAULT_PREFS[name];
  }

  const m = parseList(managed.MandatorySites);
  const r = parseList(managed.RecommendedSites);
  const u = parseList(user.userSites);
  const disabled = new Set(allowDisablingRecommended ? user.disabledRecommended || [] : []);

  const seen = new Set();
  const take = (rule) => (seen.has(rule.key) ? false : (seen.add(rule.key), true));

  const mandatory = m.valid.map((x) => (take(x), { ...x, source: 'mandatory', active: true }));
  const recommended = r.valid.map((x) => {
    const enabled = !disabled.has(x.key);
    const dup = seen.has(x.key);
    const active = enabled && !dup && take(x);
    return { ...x, source: 'recommended', enabled, active, shadowed: dup };
  });
  const userList = u.valid.map((x) => {
    const dup = seen.has(x.key);
    const active = allowUserSites && !dup && take(x);
    return { ...x, source: 'user', active, shadowed: dup };
  });

  const sites = [...mandatory, ...recommended, ...userList].filter((x) => x.active);
  const invalid = [
    ...m.invalid.map((x) => ({ ...x, source: 'mandatory' })),
    ...r.invalid.map((x) => ({ ...x, source: 'recommended' })),
    ...u.invalid.map((x) => ({ ...x, source: 'user' })),
  ];

  return {
    managed: Object.keys(managed).length > 0,
    allowUserSites,
    allowDisablingRecommended,
    prefs,
    locks,
    mandatory,
    recommended,
    user: userList,
    sites,
    invalid,
  };
}

let statePromise = null;
let status = { autofill: 'idle', autofillDetail: '', passwords: 'idle', passwordsDetail: '', script: 'idle' };

function getState() {
  if (!statePromise) statePromise = computeState();
  return statePromise;
}

// Serialise apply() runs so rapid storage changes can't interleave registrations.
let applyChain = Promise.resolve();
function refresh() {
  statePromise = computeState();
  applyChain = applyChain.then(() => apply()).catch((e) => console.error('[AutofillGuard] apply failed', e));
  return applyChain;
}

// ---------------------------------------------------------------------------------------------
// Content script registration

async function applyContentScript(state) {
  const { prefs, sites } = state;
  await chrome.storage.local.set({
    effective: { blockAutocomplete: prefs.blockAutocomplete, blockPasswords: prefs.blockPasswords },
  });

  const needed = sites.length > 0 && (prefs.blockAutocomplete || prefs.blockPasswords);
  const matches = needed ? [...new Set(sites.flatMap(toMatchPatterns))].sort() : [];
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });

  if (!needed) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    status.script = 'inactive';
    return;
  }
  status.script = 'active';

  // The worker restarts often; leave a persisted registration untouched when nothing changed so
  // there is never a window where navigations go unguarded.
  if (existing && JSON.stringify([...existing.matches].sort()) === JSON.stringify(matches)) return;

  const script = {
    id: SCRIPT_ID,
    js: ['src/content.js'],
    matches,
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    persistAcrossSessions: true,
  };
  if (existing) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);

  // Apply immediately to already-open tabs (content script is idempotent).
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.allSettled(
    tabs.map((t) =>
      chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['src/content.js'] }),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Autofill profile data (addresses, cards): native per-site setting, else global toggle fallback.

const nativeSetting = () => chrome.privacy?.services?.autofillSettings;
const CONTROLLABLE = new Set(['controllable_by_this_extension', 'controlled_by_this_extension']);

async function tryNativeAutofill(state) {
  const setting = nativeSetting();
  if (!setting) return { ok: false, reason: 'not exposed by this browser' };
  try {
    const cur = await setting.get({});
    if (!CONTROLLABLE.has(cur.levelOfControl)) return { ok: false, reason: cur.levelOfControl };
    if (!state.prefs.blockAutofill || state.sites.length === 0) {
      await setting.clear({});
      return { ok: true };
    }
    const value = state.sites.map((r) => ({ urlPattern: toContentSettingPattern(r), blockedTypes: ['all'] }));
    await setting.set({ value });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// Settings toggled globally while a blocked site is the active tab.
function toggleTargets(state, mode) {
  const t = [];
  if (state.prefs.blockAutofill && mode === 'toggle') {
    t.push('autofillAddressEnabled', 'autofillCreditCardEnabled');
  }
  if (state.prefs.blockPasswords) t.push('passwordSavingEnabled');
  return t;
}
const ALL_TOGGLES = ['autofillAddressEnabled', 'autofillCreditCardEnabled', 'passwordSavingEnabled'];

async function setToggles(names, off) {
  const problems = [];
  for (const name of ALL_TOGGLES) {
    const setting = chrome.privacy?.services?.[name];
    if (!setting) continue;
    try {
      const cur = await setting.get({});
      if (names.includes(name) && off) {
        if (!CONTROLLABLE.has(cur.levelOfControl)) {
          problems.push(`${name}: ${cur.levelOfControl}`);
          continue;
        }
        if (cur.value !== false || cur.levelOfControl !== 'controlled_by_this_extension') {
          await setting.set({ value: false, scope: 'regular' });
        }
      } else if (cur.levelOfControl === 'controlled_by_this_extension') {
        await setting.clear({ scope: 'regular' }); // restores the user's own value
      }
    } catch (e) {
      problems.push(`${name}: ${e?.message || e}`);
    }
  }
  return problems;
}

let autofillMode = 'none'; // 'native' | 'toggle' | 'none'

async function applyAutofill(state) {
  if (!state.prefs.blockAutofill || state.sites.length === 0) {
    await tryNativeAutofill(state); // clears our native rules if we held them
    autofillMode = 'none';
    status.autofill = state.prefs.blockAutofill ? 'idle' : 'disabled';
    status.autofillDetail = '';
    return;
  }
  const native = await tryNativeAutofill(state);
  if (native.ok) {
    autofillMode = 'native';
    status.autofill = 'native';
    status.autofillDetail = 'Using the browser’s per-site autofill blocking.';
  } else {
    autofillMode = 'toggle';
    status.autofill = 'toggle';
    status.autofillDetail = `Per-site autofill API unavailable (${native.reason}); address/card autofill is switched off while a blocked site is the active tab.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Active tab tracking (badge + toggle fallback)

function urlBlocked(state, url) {
  if (!url) return null;
  return state.sites.find((r) => ruleMatchesUrl(r, url)) || null;
}

async function updateBadge(state, tab) {
  if (!tab?.id || tab.id < 0) return;
  const hit = state.prefs.showBadge && urlBlocked(state, tab.url);
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text: hit ? '•' : '' });
    if (hit) await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: BADGE_COLOR });
  } catch {
    /* tab closed */
  }
}

async function evaluateActive() {
  const state = await getState();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const blocked = !!(tab && urlBlocked(state, tab.url));
  const targets = toggleTargets(state, autofillMode);
  const problems = await setToggles(targets, blocked);

  if (autofillMode === 'toggle') {
    status.autofillDetail =
      'Per-site autofill API unavailable; address/card autofill is switched off while a blocked site is the active tab.' +
      (problems.some((p) => !p.startsWith('password')) ? ` Problem: ${problems.join('; ')}` : '');
  }
  if (state.prefs.blockPasswords) {
    const pw = problems.filter((p) => p.startsWith('password'));
    status.passwords = pw.length ? 'limited' : 'active';
    status.passwordsDetail = pw.length
      ? `Cannot control password saving (${pw.join('; ')}). Password fields are still marked to discourage filling.`
      : 'Password save prompts are suppressed while a blocked site is the active tab; password fields are marked to discourage filling.';
  } else {
    status.passwords = 'disabled';
    status.passwordsDetail = '';
  }
  if (tab) await updateBadge(state, tab);
}

async function apply() {
  const state = await getState();
  await applyContentScript(state);
  await applyAutofill(state);
  await evaluateActive();
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((t) => updateBadge(state, t)));
}

// ---------------------------------------------------------------------------------------------
// Events

chrome.runtime.onInstalled.addListener(() => refresh());
chrome.runtime.onStartup.addListener(() => refresh());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' || (area === 'sync' && ['userSites', 'disabledRecommended', 'prefs'].some((k) => k in changes))) {
    refresh();
  }
});

chrome.tabs.onActivated.addListener(() => evaluateActive());
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) evaluateActive();
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!('url' in info) && info.status !== 'loading') return;
  const state = await getState();
  await updateBadge(state, tab);
  if (tab.active) evaluateActive();
});

// Make sure the worker re-applies after being restarted (e.g. after an update or crash).
refresh();

// ---------------------------------------------------------------------------------------------
// Messages from popup / options

async function mutateUser(fn) {
  const user = await readUser();
  fn(user);
  await chrome.storage.sync.set(user);
  await refresh();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await getState();
    switch (msg?.type) {
      case 'getState': {
        let match = null;
        if (msg.url) {
          const hit = urlBlocked(state, msg.url);
          if (hit) match = { key: hit.key, label: hit.label, source: hit.source };
        }
        return { ok: true, state, status: { ...status, autofillMode }, match };
      }
      case 'addUserSite': {
        if (!state.allowUserSites) return { ok: false, error: 'Adding sites is disabled by policy.' };
        const r = parseRule(msg.entry);
        if (r.error) return { ok: false, error: r.error };
        await mutateUser((u) => {
          const keys = new Set(u.userSites.map((s) => parseRule(s).key));
          if (!keys.has(r.key)) u.userSites.push(r.raw);
        });
        return { ok: true };
      }
      case 'removeUserSite': {
        await mutateUser((u) => {
          u.userSites = u.userSites.filter((s) => parseRule(s).key !== msg.key);
        });
        return { ok: true };
      }
      case 'setRecommendedEnabled': {
        if (!state.allowDisablingRecommended) return { ok: false, error: 'Locked by policy.' };
        await mutateUser((u) => {
          const set = new Set(u.disabledRecommended);
          msg.enabled ? set.delete(msg.key) : set.add(msg.key);
          u.disabledRecommended = [...set];
        });
        return { ok: true };
      }
      case 'setPref': {
        if (!(msg.name in DEFAULT_PREFS)) return { ok: false, error: 'Unknown setting' };
        if (state.locks[msg.name]) return { ok: false, error: 'Locked by policy.' };
        await mutateUser((u) => {
          u.prefs = { ...u.prefs, [msg.name]: !!msg.value };
        });
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
