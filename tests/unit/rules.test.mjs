import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, parseList, ruleMatchesUrl, toMatchPatterns, toContentSettingPattern } from '../../extension/src/rules.js';

test('domain entries cover subdomains', () => {
  for (const raw of ['example.com', '*.example.com', '.example.com', 'EXAMPLE.com.', 'example.com:8443/path?x']) {
    const r = parseRule(raw);
    assert.equal(r.error, undefined, raw);
    assert.equal(r.key, '*://example.com', raw);
  }
  const r = parseRule('example.com');
  assert.ok(ruleMatchesUrl(r, 'https://example.com/'));
  assert.ok(ruleMatchesUrl(r, 'http://a.b.example.com:8080/x'));
  assert.ok(!ruleMatchesUrl(r, 'https://notexample.com/'));
  assert.ok(!ruleMatchesUrl(r, 'https://example.com.evil.net/'));
  assert.ok(!ruleMatchesUrl(r, 'ftp://example.com/'));
  assert.deepEqual(toMatchPatterns(r), ['*://*.example.com/*']);
  assert.equal(toContentSettingPattern(r), '[*.]example.com');
});

test('exact host entries', () => {
  const r = parseRule('=login.example.com');
  assert.ok(ruleMatchesUrl(r, 'https://login.example.com/a'));
  assert.ok(!ruleMatchesUrl(r, 'https://x.login.example.com/'));
  assert.deepEqual(toMatchPatterns(r), ['*://login.example.com/*']);
  assert.equal(toContentSettingPattern(r), 'login.example.com');
});

test('scheme restriction', () => {
  const r = parseRule('https://example.com');
  assert.ok(ruleMatchesUrl(r, 'https://www.example.com/'));
  assert.ok(!ruleMatchesUrl(r, 'http://www.example.com/'));
  assert.deepEqual(toMatchPatterns(r), ['https://*.example.com/*']);
  assert.equal(toContentSettingPattern(r), 'https://[*.]example.com');
  assert.match(parseRule('ftp://example.com').error, /scheme/);
});

test('IPs, single-label hosts and IPv6 are exact', () => {
  assert.equal(parseRule('10.1.2.3').exact, true);
  assert.equal(parseRule('intranet').exact, true);
  const v6 = parseRule('[::1]');
  assert.equal(v6.exact, true);
  assert.ok(ruleMatchesUrl(v6, 'http://[::1]:8080/'));
  assert.ok(ruleMatchesUrl(parseRule('intranet'), 'http://intranet/'));
  assert.ok(!ruleMatchesUrl(parseRule('10.1.2.3'), 'http://10.1.2.30/'));
});

test('invalid entries are rejected', () => {
  for (const raw of ['', '   ', 'exa*mple.com', 'bad entry!!', '*', '-bad.com']) {
    assert.ok(parseRule(raw).error, `expected error for "${raw}"`);
  }
});

test('parseList de-duplicates and separates invalid entries', () => {
  const { valid, invalid } = parseList(['example.com', '*.example.com', '=example.com', 'nope!', 42]);
  assert.deepEqual(valid.map((r) => r.key), ['*://example.com', '*://=example.com', '*://=42']);
  assert.equal(invalid.length, 1);
  assert.deepEqual(parseList(undefined), { valid: [], invalid: [] });
});
