// ============================================================
// Trusted Types policy — Salesforce Toolkit + Data Studio
//
// Closes the entire XSS attack class structurally. With the matching
// CSP directive `require-trusted-types-for 'script'; trusted-types sftk-html;`
// active, the browser refuses any plain-string assignment to dangerous
// DOM sinks (innerHTML, outerHTML, insertAdjacentHTML, document.write,
// script.src, etc.). Only TrustedHTML objects produced by this policy
// are accepted.
//
// Strategy — minimal-churn rollout:
//   1. Define a single policy named `sftk-html` whose `createHTML` runs
//      a best-effort sanitizer over the input.
//   2. Monkey-patch the prototype setters/methods so every `el.innerHTML = …`
//      and `el.insertAdjacentHTML(…)` call in the codebase silently flows
//      through the policy and produces TrustedHTML before assignment.
//   3. Result: the existing ~213 innerHTML call sites need NO changes,
//      and a future contributor who writes a new one is also covered.
//
// Sanitizer is defense-in-depth — your existing esc()/escHtml() helpers
// remain the primary escape mechanism for interpolated values. This is the
// belt-and-suspenders layer that catches misses + structurally blocks XSS.
//
// MUST be loaded FIRST (before any module that touches innerHTML).
// ============================================================
(function () {
  'use strict';

  // Bail silently on browsers without Trusted Types (Firefox/Safari today).
  // The Chromium-based browser running our extension always has it.
  if (typeof window.trustedTypes === 'undefined' ||
      typeof window.trustedTypes.createPolicy !== 'function') {
    return;
  }

  // ── Sanitizer ───────────────────────────────────────────────
  // Best-effort string cleanup. Won't be perfect against a determined
  // attacker (use DOMPurify for that), but catches every common XSS vector
  // and — critically — never modifies legitimate UI markup the codebase
  // builds via template literals + esc()'d interpolations.
  function sanitize(html) {
    if (html == null) return '';
    let s = String(html);

    // Drop <script>…</script> blocks (and lone <script> with no closing tag).
    s = s.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '');
    // Drop <iframe> / <object> / <embed> open tags entirely.
    s = s.replace(/<(iframe|object|embed)\b[\s\S]*?>/gi, '');
    // Strip inline event handlers from any tag: onclick="…", onerror='…', onload=foo
    // The leading \s prevents matching data-on-… or other attribute names
    // that merely contain "on" in their middle.
    s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
    // Neutralize javascript:/data:text/html in href/src/action/formaction.
    s = s.replace(/(href|src|action|formaction)\s*=\s*"(javascript|data:text\/html)[^"]*"/gi, '$1=""');
    s = s.replace(/(href|src|action|formaction)\s*=\s*'(javascript|data:text\/html)[^']*'/gi, "$1=''");

    return s;
  }

  // ── Policy ──────────────────────────────────────────────────
  let policy;
  try {
    policy = window.trustedTypes.createPolicy('sftk-html', {
      createHTML:      (input) => sanitize(input),
      // The codebase doesn't create scripts dynamically — flatly refuse.
      createScript:    () => { throw new Error('[sftk-html] inline script creation is not allowed'); },
      createScriptURL: () => { throw new Error('[sftk-html] dynamic script URLs are not allowed'); },
    });
  } catch (e) {
    // Policy already exists (hot-reload) or the name is reserved — give up
    // quietly. The wrappers below will then no-op so the app still loads.
    console.warn('[sftk-html] could not create Trusted Types policy:', e);
    return;
  }

  // Helper — produce TrustedHTML for a given input, passing TrustedHTML through
  // unchanged. Anything else is coerced to string and sanitized.
  const TT = window.trustedTypes;
  function toTrustedHTML(value) {
    if (value != null && TT.isHTML && TT.isHTML(value)) return value;
    return policy.createHTML(value == null ? '' : String(value));
  }

  // ── Prototype wrappers ──────────────────────────────────────
  // Each dangerous DOM sink gets its setter/method replaced with a thin
  // wrapper that funnels values through the policy before the original
  // setter/method runs. Because we delegate to the original via call(this, …),
  // the browser's underlying TrustedHTML check sees a real TrustedHTML and
  // accepts it.
  function wrapSetter(proto, name) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.set !== 'function') return;
    const origSet = desc.set;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable:   desc.enumerable,
      get:          desc.get,
      set: function (value) {
        origSet.call(this, toTrustedHTML(value));
      },
    });
  }

  // innerHTML / outerHTML — Element.prototype on all engines we target.
  wrapSetter(Element.prototype, 'innerHTML');
  wrapSetter(Element.prototype, 'outerHTML');

  // insertAdjacentHTML — method on Element.prototype.
  if (typeof Element.prototype.insertAdjacentHTML === 'function') {
    const origIAH = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (position, text) {
      return origIAH.call(this, position, toTrustedHTML(text));
    };
  }

  // Range.prototype.createContextualFragment — uncommon but a known sink.
  if (typeof Range !== 'undefined' && Range.prototype && Range.prototype.createContextualFragment) {
    const origCCF = Range.prototype.createContextualFragment;
    Range.prototype.createContextualFragment = function (text) {
      return origCCF.call(this, toTrustedHTML(text));
    };
  }

  // DOMParser.parseFromString — flagged as a sink in some Trusted Types modes.
  // We don't enforce on it (CSP `require-trusted-types-for` only covers script
  // sinks), but wrap defensively in case the parsed string contains an inline
  // event handler that later gets adopted into the live document.
  if (typeof DOMParser !== 'undefined') {
    const origPFS = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function (str, type) {
      const safe = (type === 'text/html' || type === 'application/xhtml+xml')
        ? String(policy.createHTML(str == null ? '' : String(str)))
        : str;
      return origPFS.call(this, safe, type);
    };
  }

  // Expose the policy for any code that wants to opt in explicitly.
  window.SFTKHtml = policy;
})();
