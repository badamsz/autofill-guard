// Site rule parsing and matching, shared by the background worker, popup and options page.
//
// Accepted entry formats (case-insensitive, whitespace trimmed):
//   example.com            -> example.com and all subdomains
//   *.example.com          -> same as above
//   .example.com           -> same as above
//   =login.example.com     -> exactly login.example.com (no subdomains)
//   https://example.com    -> scheme-restricted (http or https), host + subdomains
//   https://=example.com   -> scheme-restricted, exact host
//   10.1.2.3 / localhost   -> exact host (IPs and single-label hosts never match subdomains)
// Ports and paths are ignored (stripped) because Chrome match patterns cannot express ports
// and autofill/autocomplete behaviour is per-origin anyway.

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Parse a raw site entry.
 * @returns {{raw:string,key:string,scheme:'*'|'http'|'https',host:string,exact:boolean,label:string}|{raw:string,error:string}}
 */
export function parseRule(raw) {
  const input = String(raw ?? '').trim();
  let s = input.toLowerCase();
  if (!s) return { raw: input, error: 'Empty entry' };

  let scheme = '*';
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//);
  if (m) {
    if (m[1] !== 'http' && m[1] !== 'https') return { raw: input, error: `Unsupported scheme "${m[1]}"` };
    scheme = m[1];
    s = s.slice(m[0].length);
  }

  // Strip path, query, fragment.
  s = s.split(/[/?#]/, 1)[0];

  let exact = false;
  if (s.startsWith('=')) { exact = true; s = s.slice(1); }

  // IPv6 literal
  let host;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return { raw: input, error: 'Malformed IPv6 address' };
    host = s.slice(0, end + 1);
    exact = true;
  } else {
    host = s.replace(/:\d+$/, ''); // strip port
    if (host.startsWith('*.')) host = host.slice(2);
    else if (host.startsWith('.')) host = host.slice(1);
    host = host.replace(/\.$/, '');
    if (host.includes('*')) return { raw: input, error: 'Wildcards are only allowed as a leading "*."' };
    if (!HOST_RE.test(host)) return { raw: input, error: 'Not a valid hostname' };
    if (IPV4_RE.test(host) || !host.includes('.')) exact = true;
  }

  const key = `${scheme}://${exact ? '=' : ''}${host}`;
  const label = `${scheme === '*' ? '' : scheme + '://'}${exact ? '' : '*.'}${host}`;
  return { raw: input, key, scheme, host, exact, label };
}

export const isValidRule = (r) => r && !r.error;

/** Does a parsed rule match a URL? */
export function ruleMatchesUrl(rule, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (rule.scheme !== '*' && u.protocol !== rule.scheme + ':') return false;
  // URL.hostname keeps brackets on IPv6 literals, matching how rules store them.
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (rule.exact) return h === rule.host;
  return h === rule.host || h.endsWith('.' + rule.host);
}

/** Chrome extension match patterns for registering content scripts. */
export function toMatchPatterns(rule) {
  const schemes = rule.scheme === '*' ? ['*'] : [rule.scheme];
  return schemes.map((sc) => `${sc}://${rule.exact ? '' : '*.'}${rule.host}/*`);
}

/** Content-settings style pattern (used by the native per-site autofill setting). */
export function toContentSettingPattern(rule) {
  const prefix = rule.scheme === '*' ? '' : `${rule.scheme}://`;
  return `${prefix}${rule.exact ? '' : '[*.]'}${rule.host}`;
}

/** Normalise + de-duplicate a list of raw entries; returns {valid, invalid}. */
export function parseList(list) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const r = parseRule(raw);
    if (r.error) { invalid.push(r); continue; }
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    valid.push(r);
  }
  return { valid, invalid };
}
