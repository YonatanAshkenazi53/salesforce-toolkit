// QA 1.1 findings 58, 59: the All at once plan and the PII suggestion window use the real --brand token (--accent is never defined), and a chosen Delete is readable in dark.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const rd = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const CSS = rd('styles.css'), STUDIO = rd('studio.css');
const rules = (css, re) => css.split('\n').filter(l => re.test(l));

describe('--accent is declared nowhere', () => {
  it('no stylesheet declares it, so no rule may rely on it for text or fills in the changed blocks', () => {
    expect(CSS + STUDIO).not.toMatch(/--accent\s*:/);
  });
});

describe('Field Cleaner plan (58)', () => {
  it('chip counts, bulk links and the chosen way use --brand', () => {
    for (const l of rules(CSS, /^\.fc-plan-(chip\[data-kind="replace"\] b|link|way\.on) /)) expect(l, l).not.toContain('--accent');
    expect(rules(CSS, /^\.fc-plan-link /)[0]).toContain('color: var(--brand)');
    expect(rules(CSS, /^\.fc-plan-way\.on \{/)[0]).toContain('background: var(--brand)');
  });
  it('a chosen Delete and a chosen Replace/Remove have dark-theme text that reads', () => {
    expect(CSS).toMatch(/body\.sftk-dark \.fc-plan-way\.on\[data-kind="delete"\] \{ background: #4a1b1f; color: #ffb4b0; \}/);
    expect(CSS).toMatch(/body\.sftk-dark \.fc-plan-way\.on:not\(\[data-kind="delete"\]\):not\(\[data-kind="leave"\]\) \{ color: #0b1220; \}/);
  });
});

describe('PII suggestion window (59)', () => {
  it('the folded summary, the object pick links and the row tint use --brand', () => {
    for (const re of [/^\.ds-pii-sug-more > summary/, /^\.ds-pii-sug-objpick \.ds-linkbtn \{/, /^\.ds-pii-sug-row\.ds-pii-sug-on/]) {
      const l = rules(STUDIO, re)[0];
      expect(l, String(re)).toContain('var(--brand');
      expect(l, String(re)).not.toContain('--accent');
    }
  });
});
