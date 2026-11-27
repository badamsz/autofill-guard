const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// Very small heuristic for "the site's main domain" without shipping the Public Suffix List.
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
  'co.nz', 'co.jp', 'co.kr', 'com.br', 'com.mx', 'com.cn', 'com.tw', 'com.sg', 'co.in', 'co.za', 'gc.ca',
]);
function baseDomain(host) {
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) return host;
  const parts = host.split('.');
  const last2 = parts.slice(-2).join('.');
  const n = TWO_LEVEL_SUFFIXES.has(last2) ? 3 : 2;
  return parts.slice(-n).join('.');
}

const SOURCE_TEXT = {
  mandatory: 'Blocked — required by your organization',
  recommended: 'Blocked — recommended by your organization',
  user: 'Blocked — added by you',
};

let tab;

async function render() {
  $('err').textContent = '';
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try { url = new URL(tab?.url || ''); } catch { url = null; }

  const res = await send({ type: 'getState', url: tab?.url });
  if (!res?.ok) { $('err').textContent = res?.error || 'Extension error'; return; }
  const { state, status, match } = res;

  $('managedChip').hidden = !state.managed;
  $('mode').textContent =
    status.autofillMode === 'native' ? 'Per-site autofill: native'
    : status.autofillMode === 'toggle' ? 'Per-site autofill: fallback mode'
    : state.prefs.blockAutofill ? '' : 'Address/card blocking off';

  const web = url && (url.protocol === 'http:' || url.protocol === 'https:');
  $('host').textContent = web ? url.hostname : 'This page';
  $('dot').classList.toggle('on', !!match);
  $('addBox').hidden = true;
  $('actionBox').hidden = true;
  $('actionBox').replaceChildren();

  if (!web) {
    $('statusText').textContent = 'Autofill Guard only works on http(s) pages.';
    return;
  }

  if (match) {
    $('statusText').textContent = `${SOURCE_TEXT[match.source]} (${match.label})`;
    const box = $('actionBox');
    if (match.source === 'user') {
      const b = button('Unblock this site', async () => act({ type: 'removeUserSite', key: match.key }));
      box.append(b);
    } else if (match.source === 'recommended' && state.allowDisablingRecommended) {
      box.append(button('Allow autofill on this site', async () => act({ type: 'setRecommendedEnabled', key: match.key, enabled: false })));
    } else {
      const p = document.createElement('p');
      p.className = 'small muted lock';
      p.textContent = 'This setting is managed by your organization.';
      box.append(p);
    }
    box.hidden = false;
    return;
  }

  $('statusText').textContent = 'Autofill and autocomplete work normally here.';
  if (!state.allowUserSites) {
    const box = $('actionBox');
    const p = document.createElement('p');
    p.className = 'small muted lock';
    p.textContent = 'Your organization does not allow adding sites.';
    box.append(p);
    box.hidden = false;
    return;
  }
  const host = url.hostname;
  const base = baseDomain(host);
  const scope = $('scope');
  scope.replaceChildren();
  const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  scope.append(opt(base, `${base} and all its subdomains`));
  if (base !== host) {
    scope.append(opt(host, `${host} and its subdomains`));
    scope.append(opt(`=${host}`, `Only ${host}`));
  }
  $('addBox').hidden = false;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.width = '100%';
  b.addEventListener('click', onClick);
  return b;
}

async function act(msg) {
  const res = await send(msg);
  if (!res?.ok) { $('err').textContent = res?.error || 'Failed'; return; }
  $('reloadBox').hidden = false;
  await render();
}

$('addBtn').addEventListener('click', () => act({ type: 'addUserSite', entry: $('scope').value }));
$('reloadBtn').addEventListener('click', async () => { await chrome.tabs.reload(tab.id); window.close(); });
$('optionsBtn').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

render();
