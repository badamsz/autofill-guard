const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};

const PREFS = [
  ['blockAutocomplete', 'Single-field autocomplete', 'Don’t save or suggest previously typed values (search boxes, account numbers, free-text fields).'],
  ['blockAutofill', 'Addresses, contact info and payment cards', 'Don’t offer to fill or save Autofill profile data.'],
  ['blockPasswords', 'Password manager', 'Also suppress password save prompts and discourage password filling. On Edge, the PasswordManagerBlocklist policy does this natively.'],
  ['showBadge', 'Toolbar indicator', 'Show a dot on the toolbar icon when the current site is blocked.'],
];
const SOURCE_LABEL = { mandatory: 'Required', recommended: 'Recommended', user: 'Added by you' };

async function render() {
  const res = await send({ type: 'getState' });
  if (!res?.ok) { $('status').textContent = res?.error || 'Extension error'; return; }
  const { state, status } = res;

  $('policyBanner').hidden = !state.managed;
  $('addArea').hidden = !state.allowUserSites;
  $('addDisabled').hidden = state.allowUserSites;

  // Sites table
  const rows = [];
  for (const s of state.mandatory) {
    rows.push(siteRow(s, el('span', { className: 'small muted lock', textContent: 'Locked' })));
  }
  for (const s of state.recommended) {
    let action;
    if (s.shadowed) action = el('span', { className: 'small muted', textContent: 'Also required' });
    else if (!state.allowDisablingRecommended) action = el('span', { className: 'small muted lock', textContent: 'Locked' });
    else {
      const cb = el('input', { type: 'checkbox', checked: s.enabled });
      cb.addEventListener('change', async () => {
        await send({ type: 'setRecommendedEnabled', key: s.key, enabled: cb.checked });
        render();
      });
      action = el('label', { className: 'small row', style: 'justify-content:flex-end' }, cb, 'Enabled');
    }
    rows.push(siteRow(s, action, !s.enabled));
  }
  for (const s of state.user) {
    let action;
    const rm = el('button', { className: 'danger', textContent: 'Remove' });
    rm.addEventListener('click', async () => { await send({ type: 'removeUserSite', key: s.key }); render(); });
    if (s.shadowed) action = el('span', {}, el('span', { className: 'small muted', textContent: 'Covered by policy ' }), rm);
    else if (!state.allowUserSites) action = el('span', {}, el('span', { className: 'small muted', textContent: 'Ignored (policy) ' }), rm);
    else action = rm;
    rows.push(siteRow(s, action, !s.active));
  }
  if (!rows.length) rows.push(el('tr', {}, el('td', { colSpan: 3, className: 'empty', textContent: 'No sites yet.' })));
  $('siteRows').replaceChildren(...rows);

  const inv = state.invalid;
  $('invalidBox').hidden = !inv.length;
  $('invalidBox').replaceChildren(
    ...(inv.length ? [el('p', { textContent: 'Ignored invalid entries:' })] : []),
    ...inv.map((i) => el('div', {}, el('code', { textContent: i.raw || '(empty)' }), ` (${SOURCE_LABEL[i.source]}): ${i.error}`)),
  );

  // Preferences
  $('prefs').replaceChildren(
    ...PREFS.map(([name, title, desc]) => {
      const cb = el('input', { type: 'checkbox', checked: state.prefs[name], disabled: state.locks[name], id: `pref-${name}` });
      cb.addEventListener('change', async () => {
        const r = await send({ type: 'setPref', name, value: cb.checked });
        if (!r?.ok) alertInline(r?.error);
        render();
      });
      return el('label', { className: 'switch', htmlFor: cb.id }, cb,
        el('div', {},
          el('strong', { textContent: title, className: state.locks[name] ? 'lock' : '' }),
          el('span', { className: 'small muted', textContent: desc })));
    }),
  );

  // Status
  const line = (k, v) => el('div', { className: 'status-line' }, el('b', { textContent: k }), el('span', { textContent: v }));
  const af = {
    native: 'Native per-site blocking',
    toggle: 'Fallback: global toggle while a blocked site is active',
    none: state.prefs.blockAutofill ? 'Idle (no sites)' : 'Off',
  }[status.autofillMode];
  $('status').replaceChildren(
    line('Active sites', String(state.sites.length)),
    line('Autocomplete guard', status.script === 'active' ? 'Injected on active sites' : 'Inactive'),
    line('Address/card autofill', af),
    ...(status.autofillDetail ? [el('p', { className: 'muted', textContent: status.autofillDetail })] : []),
    line('Password manager', state.prefs.blockPasswords ? (status.passwords === 'limited' ? 'Limited' : 'Suppressed') : 'Not blocked'),
    ...(status.passwordsDetail ? [el('p', { className: 'muted', textContent: status.passwordsDetail })] : []),
    line('Extension ID', chrome.runtime.id),
  );
}

function siteRow(s, action, dim = false) {
  return el('tr', { style: dim ? 'opacity:.55' : '' },
    el('td', {}, el('code', { textContent: s.label })),
    el('td', {}, el('span', { className: `chip ${s.source}`, textContent: SOURCE_LABEL[s.source] })),
    el('td', { className: 'actions' }, action));
}

function alertInline(msg) { $('addErr').textContent = msg || ''; }

async function add() {
  alertInline('');
  const entry = $('entry').value.trim();
  if (!entry) return;
  const parts = entry.split(/[\s,;]+/).filter(Boolean);
  const errors = [];
  for (const p of parts) {
    const r = await send({ type: 'addUserSite', entry: p });
    if (!r?.ok) errors.push(`${p}: ${r?.error}`);
  }
  alertInline(errors.join(' · '));
  if (!errors.length) $('entry').value = '';
  render();
}

$('addBtn').addEventListener('click', add);
$('entry').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
chrome.storage.onChanged.addListener((_, area) => { if (area === 'managed' || area === 'sync') setTimeout(render, 150); });
render();
