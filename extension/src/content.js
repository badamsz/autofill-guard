// Autofill Guard — content script. Injected only on blocked sites (see background.js).
//
// Chromium ignores autocomplete="off" for Autofill profile data and passwords, but it DOES honour
// it for single-field autocomplete: values are neither suggested nor saved for fields whose
// autocomplete attribute (or form's) is "off". This script makes sure every form control on the
// page carries autocomplete="off" — including controls added later, controls inside open shadow
// roots, and controls whose attribute the page rewrites — and re-asserts it at focus and submit
// time, before Chromium reads it.

(() => {
  if (globalThis.__autofillGuardInstalled) return;
  globalThis.__autofillGuardInstalled = true;

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
  // Tokens that steer the password manager; leave them alone unless passwords are being blocked.
  const CREDENTIAL_TOKENS = /\b(username|current-password|new-password|one-time-code|webauthn)\b/i;
  const ORIG_ATTR = 'data-afg-orig-autocomplete';

  let cfg = { blockAutocomplete: true, blockPasswords: false };
  const observed = new WeakSet();
  const rewrites = new WeakMap();
  let inEvent = false;

  function desiredValue(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SKIP_TYPES.has(type)) return null;
      if (type === 'password') return cfg.blockPasswords ? 'new-password' : null;
      const cur = el.getAttribute(ORIG_ATTR) ?? el.getAttribute('autocomplete') ?? '';
      if (!cfg.blockPasswords && CREDENTIAL_TOKENS.test(cur)) return null;
      return cfg.blockAutocomplete || cfg.blockPasswords ? 'off' : null;
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return cfg.blockAutocomplete ? 'off' : null;
    if (tag === 'FORM') return cfg.blockAutocomplete ? 'off' : null;
    return null;
  }

  function processEl(el) {
    const want = desiredValue(el);
    if (!want) return;
    const cur = el.getAttribute('autocomplete');
    if (cur === want) return;
    // Guard against an endless tug-of-war with a page script that keeps resetting the attribute;
    // focus/submit handlers still re-assert it at the moments that matter.
    const n = (rewrites.get(el) || 0) + 1;
    rewrites.set(el, n);
    if (n > 25 && !inEvent) return;
    if (!el.hasAttribute(ORIG_ATTR)) el.setAttribute(ORIG_ATTR, cur ?? '');
    el.setAttribute('autocomplete', want);
    if (cfg.blockPasswords && el.tagName === 'INPUT') {
      // Hints honoured by common third-party password managers.
      el.setAttribute('data-lpignore', 'true');
      el.setAttribute('data-1p-ignore', '');
      el.setAttribute('data-bwignore', 'true');
      el.setAttribute('data-form-type', 'other');
    }
  }

  const SELECTOR = 'form, input, textarea, select';
  // Extensions can reach closed shadow roots via chrome.dom. That API only accepts HTMLElements:
  // SVG and MathML elements (icons are everywhere) make it throw, so skip them and never let a
  // failure here abort the scan.
  const closedRootOf = chrome.dom?.openOrClosedShadowRoot;
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (!closedRootOf || !(el instanceof HTMLElement)) return null;
    try {
      return closedRootOf(el);
    } catch {
      return null;
    }
  }

  function processTree(root) {
    if (!root) return;
    if (root.nodeType === 1) {
      if (root.matches(SELECTOR)) processEl(root);
      const sr = shadowOf(root);
      if (sr) watch(sr);
    }
    if (!root.querySelectorAll) return;
    for (const el of root.querySelectorAll(SELECTOR)) processEl(el);
    // Descend into open and closed shadow roots.
    for (const el of root.querySelectorAll('*')) {
      const sr = shadowOf(el);
      if (sr) watch(sr);
    }
  }

  // Run one unit of work without letting an unexpected error stop the remaining ones.
  function safely(fn, arg) {
    try {
      fn(arg);
    } catch (e) {
      console.debug('[AutofillGuard]', e);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') {
        if (rec.attributeName === 'type' || rec.attributeName === 'autocomplete') safely(processEl, rec.target);
        continue;
      }
      for (const n of rec.addedNodes) if (n.nodeType === 1) safely(processTree, n);
    }
  });

  function watch(root) {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['autocomplete', 'type'],
    });
    processTree(root);
  }

  // Elements targeted by an event, including inside open/closed shadow roots exposed via composedPath.
  function handleEventTarget(e) {
    inEvent = true;
    try {
      handleEventTargetInner(e);
    } catch (err) {
      console.debug('[AutofillGuard]', err);
    } finally {
      inEvent = false;
    }
  }

  function handleEventTargetInner(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) {
      if (n && n.nodeType === 1 && n.matches?.(SELECTOR)) processEl(n);
      if (n instanceof ShadowRoot) watch(n);
    }
    const form = e.target?.form || (e.target?.tagName === 'FORM' ? e.target : null);
    if (form) {
      processEl(form);
      for (const el of form.elements) processEl(el);
    }
  }

  function start() {
    // Re-assert right before the browser looks at the field (suggestions) or the form (saving).
    for (const type of ['pointerdown', 'mousedown', 'focusin', 'keydown', 'submit', 'formdata']) {
      document.addEventListener(type, handleEventTarget, { capture: true, passive: true });
    }
    // Catch shadow roots attached after their host was inserted.
    const rescan = () => safely(processTree, document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rescan, { once: true });
    addEventListener('load', rescan, { once: true });
    safely(watch, document);
  }

  chrome.storage.local.get('effective').then(
    ({ effective }) => {
      if (effective) cfg = { ...cfg, ...effective };
      start();
    },
    () => start(),
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.effective?.newValue) {
      cfg = { ...cfg, ...changes.effective.newValue };
      processTree(document);
    }
  });
})();
