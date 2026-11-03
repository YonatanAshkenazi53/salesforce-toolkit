// PII MASKING v1 — builder UI (studio-builder.js + studio.css).
//
// The policy editor rides ON TOP of surfaces owned elsewhere (the Fields &
// mapping modal re-renders its rows constantly; the engine lives in
// sftk-pii.js), so what this suite pins is the UI's own contract:
//   • policy write/remove semantics ("<Object>.<Field>" keys, hash rules,
//     no empty piiPolicy stub left behind),
//   • the salt lifecycle (minted on the FIRST rule, 32 hex chars, never
//     rotated — rotation would change every masked value),
//   • the honest treatment state per field type (non-maskable = disabled,
//     title says a hash rule writes NULL),
//   • the export/import boundary (piiSalt strips, policy travels), and
//   • UI copy honesty: masked/pseudonymized wording with the reversibility
//     line — the a-word is banned from every surface this stream owns.
// DOM wiring is checked by SOURCE assertion (no DOM harness in npm test),
// same as ui-studio.test.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractFunctions } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = readFileSync(join(root, 'studio-builder.js'), 'utf8');
const CSS     = readFileSync(join(root, 'studio.css'), 'utf8');

const { bldPiiRuleFor, bldPiiCountForObject, bldPiiToggleHashRule,
        bldPiiApplyHashRules, bldPiiEnsureSalt, bldPiiMaskTitle } =
  extractFunctions('studio-builder.js',
    ['bldPiiRuleFor', 'bldPiiCountForObject', 'bldPiiToggleHashRule',
     'bldPiiApplyHashRules', 'bldPiiEnsureSalt', 'bldPiiMaskTitle'],
    { 'sftk-pii.js': ['sftkPiiMaskable'] });

// ── policy write / remove ─────────────────────────────────────────────────
describe('bldPiiToggleHashRule — the 🎭 click', () => {
  it('adds { strategy: "hash" } under "<Object>.<Field>" and reports "added"', () => {
    const p = {};
    expect(bldPiiToggleHashRule(p, 'Contact', 'Email')).toBe('added');
    expect(p.piiPolicy).toEqual({ 'Contact.Email': { strategy: 'hash' } });
  });

  it('second toggle removes the rule and reports "removed"', () => {
    const p = {};
    bldPiiToggleHashRule(p, 'Contact', 'Email');
    expect(bldPiiToggleHashRule(p, 'Contact', 'Email')).toBe('removed');
    expect(bldPiiRuleFor(p.piiPolicy, 'Contact', 'Email')).toBeNull();
  });

  it('removing the LAST rule deletes piiPolicy entirely — no empty stub in exports', () => {
    const p = {};
    bldPiiToggleHashRule(p, 'Contact', 'Email');
    bldPiiToggleHashRule(p, 'Contact', 'Email');
    expect('piiPolicy' in p).toBe(false);
  });

  it('never touches sibling rules', () => {
    const p = { piiPolicy: { 'Contact.Phone': { strategy: 'null' } } };
    bldPiiToggleHashRule(p, 'Contact', 'Email');
    bldPiiToggleHashRule(p, 'Contact', 'Email');
    expect(p.piiPolicy).toEqual({ 'Contact.Phone': { strategy: 'null' } });
  });

  it('removes whatever rule covers the key, not only hash rules (a fixed rule is still a mask the user can lift)', () => {
    const p = { piiPolicy: { 'Contact.Email': { strategy: 'fixed', value: 'x' } } };
    expect(bldPiiToggleHashRule(p, 'Contact', 'Email')).toBe('removed');
    expect('piiPolicy' in p).toBe(false);
  });
});

describe('bldPiiApplyHashRules — the Suggest modal Apply', () => {
  it('writes hash rules for every new key and returns the count of NEW rules only', () => {
    const p = { piiPolicy: { 'Contact.Email': { strategy: 'hash' } } };
    const added = bldPiiApplyHashRules(p, ['Contact.Email', 'Contact.Phone', 'Account.Name']);
    expect(added).toBe(2);
    expect(Object.keys(p.piiPolicy).sort()).toEqual(['Account.Name', 'Contact.Email', 'Contact.Phone']);
  });

  it('never overwrites an existing rule — a hand-tuned fixed/null rule survives a Suggest re-run', () => {
    const p = { piiPolicy: { 'Contact.Email': { strategy: 'fixed', value: 'ops@masked.invalid' } } };
    bldPiiApplyHashRules(p, ['Contact.Email']);
    expect(p.piiPolicy['Contact.Email']).toEqual({ strategy: 'fixed', value: 'ops@masked.invalid' });
  });

  it('ignores garbage keys and garbage input without creating a policy stub', () => {
    const p = {};
    expect(bldPiiApplyHashRules(p, ['nodot', '', 42, null, '.LeadingDot'])).toBe(0);
    expect('piiPolicy' in p).toBe(false);
    expect(bldPiiApplyHashRules(p, null)).toBe(0);
    expect(bldPiiApplyHashRules(null, ['Contact.Email'])).toBe(0);
  });
});

describe('bldPiiRuleFor / bldPiiCountForObject — read side', () => {
  const policy = {
    'Contact.Email': { strategy: 'hash' },
    'Contact.Birthdate': { strategy: 'hash' },
    'ContactPointEmail.EmailAddress': { strategy: 'hash' },
    'Account.Name': { strategy: 'hash' }
  };

  it('returns the exact rule, null-safe on every argument', () => {
    expect(bldPiiRuleFor(policy, 'Contact', 'Email')).toEqual({ strategy: 'hash' });
    expect(bldPiiRuleFor(policy, 'Contact', 'Phone')).toBeNull();
    expect(bldPiiRuleFor(null, 'Contact', 'Email')).toBeNull();
    expect(bldPiiRuleFor(policy, '', 'Email')).toBeNull();
    expect(bldPiiRuleFor(policy, 'Contact', '')).toBeNull();
  });

  it('counts only the object\'s own keys — "Contact." never swallows ContactPointEmail', () => {
    expect(bldPiiCountForObject(policy, 'Contact')).toBe(2);
    expect(bldPiiCountForObject(policy, 'ContactPointEmail')).toBe(1);
    expect(bldPiiCountForObject(policy, 'Account')).toBe(1);
    expect(bldPiiCountForObject(policy, 'Lead')).toBe(0);
    expect(bldPiiCountForObject(null, 'Contact')).toBe(0);
    expect(bldPiiCountForObject(policy, '')).toBe(0);
  });
});

// ── salt lifecycle ────────────────────────────────────────────────────────
describe('bldPiiEnsureSalt — machine-local, minted once, never rotated', () => {
  it('mints a 32-char lowercase-hex salt (16 random bytes) when absent', () => {
    const p = {};
    const salt = bldPiiEnsureSalt(p);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(p.piiSalt).toBe(salt);
  });

  it('NEVER rotates an existing salt — rotation would change every masked value and break re-seed idempotence', () => {
    const p = { piiSalt: 'a3f1c9d200aa11bb22cc33dd44ee55ff' };
    expect(bldPiiEnsureSalt(p)).toBe('a3f1c9d200aa11bb22cc33dd44ee55ff');
    expect(p.piiSalt).toBe('a3f1c9d200aa11bb22cc33dd44ee55ff');
  });

  it('two profiles get two different salts (crypto randomness, not a constant)', () => {
    expect(bldPiiEnsureSalt({})).not.toBe(bldPiiEnsureSalt({}));
  });

  it('is null-safe on non-objects', () => {
    expect(bldPiiEnsureSalt(null)).toBeNull();
    expect(bldPiiEnsureSalt(undefined)).toBeNull();
  });
});

// ── honest treatment state per type ───────────────────────────────────────
describe('bldPiiMaskTitle — what the 🎭 control may claim', () => {
  it('enabled for every maskable type (string, textarea, email, phone, url)', () => {
    for (const type of ['string', 'textarea', 'email', 'phone', 'url']) {
      expect(bldPiiMaskTitle(type, false).enabled, type).toBe(true);
      expect(bldPiiMaskTitle(type, true).enabled, type).toBe(true);
    }
  });

  it('disabled for non-maskable types, and the title says the honest consequence: a hash rule writes NULL', () => {
    for (const type of ['date', 'datetime', 'picklist', 'boolean', 'reference', 'id', undefined]) {
      const t = bldPiiMaskTitle(type, false);
      expect(t.enabled, String(type)).toBe(false);
      expect(t.title).toMatch(/NULL/);
    }
  });

  it('an EXISTING rule on a non-maskable type stays removable (enabled) and still discloses the NULL consequence', () => {
    const t = bldPiiMaskTitle('date', true);
    expect(t.enabled).toBe(true);
    expect(t.title).toMatch(/NULL/);
    expect(t.title).toMatch(/remove/i);
  });

  it('every title says masked/pseudonymized — never the banned stronger claim', () => {
    for (const type of ['email', 'date', 'string', undefined]) {
      for (const active of [true, false]) {
        expect(bldPiiMaskTitle(type, active).title).not.toMatch(/anonym/i);
      }
    }
  });
});

// ── source assertions: wiring + copy (no DOM harness in npm test) ─────────
describe('treatment wiring in the Fields & mapping modal (source)', () => {
  it('the modal open in wireTreeEvents chains into bldPiiDecorateMappingModal', () => {
    expect(BUILDER).toMatch(/openFieldMappingModal\(btn\.dataset\.mapBtn\)\s*\.then\(\(\) => \{ if \(sftkShips\('pii'\)\) bldPiiDecorateMappingModal\(btn\.dataset\.mapBtn\); \}\)\)/);   // gated: masking is cut from the public build (2026-10-31)
  });

  it('decoration re-applies across the modal\'s re-renders: delegated click + childList observer on the persistent modal box', () => {
    expect(BUILDER).toContain("box.addEventListener('click', bldPiiMaskBtnClick)");
    expect(BUILDER).toMatch(/new MutationObserver\(\(\) => bldPiiDecorateRows\(\)\)/);
    expect(BUILDER).toMatch(/observe\(box, \{ childList: true, subtree: true \}\)/);
  });

  it('rows get the 🎭 control, the ds-fm-mask-on active state and the 🔒 lock indicator', () => {
    expect(BUILDER).toContain("btn.className = 'ds-fm-mask-btn'");
    expect(BUILDER).toContain("classList.toggle('ds-fm-mask-on', active)");
    expect(BUILDER).toContain("classList.toggle('ds-fm-row-masked', active)");
    expect(BUILDER).toContain("lock.className = 'ds-fm-mask-lock'");
  });

  it('the disabled/title state comes from bldPiiMaskTitle (the honest per-type claim)', () => {
    expect(BUILDER).toMatch(/const t = bldPiiMaskTitle\(typeByField\[field\], active\);\s*\n\s*btn\.disabled = !t\.enabled;\s*\n\s*btn\.title = t\.title;/);
  });

  it('the added path mints the salt; both toggle toasts disclose what will be written', () => {
    expect(BUILDER).toMatch(/res === 'added'[\s\S]{0,200}bldPiiEnsureSalt\(_editingProfile\)/);
    expect(BUILDER).toContain('will be masked (pseudonymized) at write time');
    expect(BUILDER).toContain('will be written unmasked');
  });
});

describe('tree config row — the "N masked" chip (source)', () => {
  it('renders from bldPiiCountForObject over the live policy, next to the Fields & mapping button', () => {
    const i = BUILDER.indexOf("data-map-btn=\"${esc(pathKey)}\"");
    expect(i).toBeGreaterThan(-1);
    const after = BUILDER.slice(i, i + 1600);
    expect(after).toContain("bldPiiCountForObject(_editingProfile?.piiPolicy, objName)");
    expect(after).toContain('ds-badge-masked');
    expect(after).toMatch(/\$\{nMask\} masked/);
  });
});

describe('Suggest PII masks modal (source)', () => {
  it('is reachable from the builder header actions', () => {
    expect(BUILDER).toContain('id="dsBldSuggestPii"');
    expect(BUILDER).toMatch(/eid\('dsBldSuggestPii'\)\?\.addEventListener\('click', \(\) => bldOpenPiiSuggestModal\(\)\)/);
  });

  it('queries FieldDefinition compliance rows via SF_QUERY with soqlStrLit(obj), tolerating absence', () => {
    expect(BUILDER).toMatch(/type: 'SF_QUERY'[\s\S]{0,200}SELECT QualifiedApiName, ComplianceGroup, SecurityClassification FROM FieldDefinition WHERE EntityDefinitionId = \$\{soqlStrLit\(obj\)\}/);
    expect(BUILDER).toContain('This org has no compliance classification');
  });

  it('reuses the shared describe cache instead of a bespoke re-fetch', () => {
    const fn = BUILDER.slice(BUILDER.indexOf('async function bldOpenPiiSuggestModal'));
    expect(fn).toContain('await describe(obj)');
    expect(fn).not.toContain('SF_REST_GET');   // no raw describe call of its own
  });

  // PII v2 (2026-11-04): the modal fabricates — a treatment per row from the
  // VALUES, two real values and what they become, the user changes it per row.
  it('says what it is in the honest words: a hash with a key kept on this PC, .invalid domains, a shape-valid fake can coincide', () => {
    expect(BUILDER).toContain('derives from a hash of the real value with a key kept on this PC');
    expect(BUILDER).toContain('<code>.invalid</code> domains that cannot receive mail');
    expect(BUILDER).toContain('can still coincide with someone\'s real number where a country reserves no test range');
  });

  it('pre-ticks sure candidates, leaves a covered row unticked (tick to change its treatment), a select per row, a preview per row', () => {
    expect(BUILDER).toContain("${existing ? '' : (s.sure ? 'checked' : '')}");
    expect(BUILDER).toContain('Already covered — tick to change its treatment');
    expect(BUILDER).toContain('data-pii-treat="${esc(key)}"');
    expect(BUILDER).toContain('data-pii-prev="${esc(key)}"');
    // a hash is offered only where it can be rendered; "write empty" is always there
    expect(BUILDER).toContain("if (sftkPiiMaskable({ type: t })) out.push({ value: 'hash'");
    expect(BUILDER).toContain("out.push({ value: 'null', label: '∅ write empty'");
  });

  it('reads 200 real rows of every text-like field from the SOURCE and hands them to the suggester as values', () => {
    expect(BUILDER).toMatch(/FROM \$\{obj\} ORDER BY LastModifiedDate DESC LIMIT 200/);
    expect(BUILDER).toContain('sftkPiiSuggest(obj, writable, complianceByField, samplesByField)');   // only fields a payload can send
  });

  it('Apply writes every ticked row\'s own treatment, mints the salt on a new rule, and repaints the tree chips', () => {
    const apply = BUILDER.slice(BUILDER.indexOf("eid('dsPiiSugApply')"));
    expect(apply).toContain('bldPiiApplyRules(_editingProfile, entries)');
    expect(apply).toMatch(/if \(res\.added \|\| res\.changed\) bldPiiEnsureSalt\(_editingProfile\)/);
    expect(apply).toContain('refreshTree()');
  });

  it('the 🎭 control opens the chooser for one field; Apply mints the salt, Remove lifts the rule', () => {
    expect(BUILDER).toContain('bldOpenPiiFieldModal(ctx.objType, field);');
    const fm = BUILDER.slice(BUILDER.indexOf('async function bldOpenPiiFieldModal'));
    expect(fm).toMatch(/const res = bldPiiSetRule\(p, objectApi, field, rule\);\s*\n\s*if \(res === 'added'\) bldPiiEnsureSalt\(_editingProfile\);/);
    expect(fm).toContain('will be masked (pseudonymized) at write time');
    expect(fm).toContain('will be written unmasked');
  });
});

describe('PII v2 pure helpers (the chooser and the rules)', () => {
  const api = new Function(`${readFileSync(join(root, 'sftk-pii.js'), 'utf8')}\n${BUILDER.slice(BUILDER.indexOf('function bldPiiTreatmentOptions'), BUILDER.indexOf('// Two real values and what they become'))}\nreturn { bldPiiTreatmentOptions, bldPiiRuleFromTreatment, bldPiiTreatmentOfRule, bldPiiRuleWords, bldPiiSetRule, bldPiiApplyRules };`)();
  it('treatment options follow the field type; hash only where renderable; empty always; every pattern carries its caveat', () => {
    const email = api.bldPiiTreatmentOptions('email').map(o => o.value);
    expect(email).toEqual(['email-person', 'email', 'hash', 'null']);
    const date = api.bldPiiTreatmentOptions('date').map(o => o.value);
    expect(date).toEqual(['date-shift', 'null']);               // a hash is never a valid date
    const phone = api.bldPiiTreatmentOptions('phone');
    expect(phone[0]).toMatchObject({ value: 'phone-keep', label: '🎭 Phone, same shape' });
    expect(phone[0].title).toMatch(/555-01xx/);
    expect(api.bldPiiTreatmentOptions('textarea').map(o => o.value)).toEqual(['scrub', 'street', 'hash', 'null']);
  });
  it('a rule from a treatment and back; the words a rule is described with', () => {
    expect(api.bldPiiRuleFromTreatment('hash')).toEqual({ strategy: 'hash' });
    expect(api.bldPiiRuleFromTreatment('null')).toEqual({ strategy: 'null' });
    expect(api.bldPiiRuleFromTreatment('phone-keep')).toEqual({ strategy: 'pattern', pattern: 'phone-keep' });
    expect(api.bldPiiTreatmentOfRule({ strategy: 'pattern', pattern: 'scrub' })).toBe('scrub');
    expect(api.bldPiiTreatmentOfRule({ strategy: 'fixed', value: 'x' })).toBe('fixed');
    expect(api.bldPiiRuleWords({ strategy: 'pattern', pattern: 'email-person' })).toBe('fabricated — E-mail from the fabricated name');
    expect(api.bldPiiRuleWords({ strategy: 'null' })).toBe('written empty');
    expect(api.bldPiiRuleWords(null)).toBe('written as is');
  });
  it('bldPiiSetRule adds, changes or keeps — case-insensitive on the key, never two keys for one field', () => {
    const p = {};
    expect(api.bldPiiSetRule(p, 'Contact', 'Email', { strategy: 'hash' })).toBe('added');
    expect(api.bldPiiSetRule(p, 'contact', 'email', { strategy: 'hash' })).toBe('same');
    expect(api.bldPiiSetRule(p, 'contact', 'email', { strategy: 'pattern', pattern: 'email-person' })).toBe('changed');
    expect(Object.keys(p.piiPolicy)).toEqual(['contact.email']);
    expect(api.bldPiiSetRule(p, 'Contact', 'Email', null)).toBe('same');
  });
  it('bldPiiApplyRules counts added and changed, skips garbage', () => {
    const p = { piiPolicy: { 'Lead.Email': { strategy: 'hash' } } };
    const r = api.bldPiiApplyRules(p, [{ key: 'Lead.Email', rule: { strategy: 'pattern', pattern: 'email-person' } }, { key: 'Lead.Phone', rule: { strategy: 'pattern', pattern: 'phone-keep' } }, { key: 'nope', rule: { strategy: 'hash' } }, null]);
    expect(r).toEqual({ added: 1, changed: 1 });
    expect(p.piiPolicy).toEqual({ 'Lead.Email': { strategy: 'pattern', pattern: 'email-person' }, 'Lead.Phone': { strategy: 'pattern', pattern: 'phone-keep' } });
  });
});

describe('export / import boundary (source)', () => {
  it('piiSalt is on the strip list (bldProfileRuntimeFields)', () => {
    const fn = BUILDER.slice(BUILDER.indexOf('function bldProfileRuntimeFields'), BUILDER.indexOf('function bldProfileStrip'));
    expect(fn).toContain("'piiSalt'");
  });

  it('the import flow mints a fresh salt BEFORE saving and the summary says values will differ', () => {
    expect(BUILDER).toMatch(/if \(nMaskRules\) bldPiiEnsureSalt\(prof\);[\s\S]{0,200}_profiles\.push\(prof\)/);
    expect(BUILDER).toContain('a fresh one was generated here');
    expect(BUILDER).toMatch(/masked values on this machine will differ from the exporter's/);
  });

  it('the export toast discloses that rules travelled and the salt did not', () => {
    expect(BUILDER).toMatch(/PII mask rule\(s\) travelled; the pseudonymization salt did NOT/);
  });
});

describe('copy honesty — the banned word', () => {
  it('appears NOWHERE in the surfaces this stream owns (masked/pseudonymized only)', () => {
    expect(BUILDER).not.toMatch(/anonym/i);
    expect(CSS).not.toMatch(/anonym/i);
  });
});

describe('studio.css — the bounded PII section exists and themes both modes', () => {
  it('declares the treatment, lock, chip and suggest-modal classes', () => {
    for (const cls of ['.ds-fm-mask-btn', '.ds-fm-mask-lock', '.ds-fm-row-masked',
                       '.ds-badge-masked', '.ds-pii-sug-honesty', '.ds-pii-sug-row']) {
      expect(CSS).toContain(cls);
    }
  });

  it('every literal-colored PII surface has a .ds-dark restatement', () => {
    for (const sel of ['.ds-dark .ds-pii-sug-honesty', '.ds-dark .ds-pii-sug-note',
                       '.ds-dark .ds-pii-sug-null', '.ds-dark .ds-fm-mask-btn.ds-fm-mask-on']) {
      expect(CSS).toContain(sel);
    }
  });
});
