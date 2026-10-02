// 2026-09-22 — the rollback honoured the write lock only at the background
// chokepoint (first delete, half-way through the dialog) and never said why it
// wanted the org name instead of ROLLBACK.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const U = readFileSync(new URL('../studio-undo.js', import.meta.url), 'utf8');
const SU = readFileSync(new URL('../sftk-undo.js', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../studio-rollback.js', import.meta.url), 'utf8');

// 2026-09-22 — live rollback: 6 Accounts the run created were KEPT because
// ActionableListMember cannot be queried without an ActionableListId (a
// Salesforce implementation restriction) — no way through for the user.
describe('rollback: child objects Salesforce refuses to query do not keep the parents; unreadable ones offer a choice', () => {
  it('classifies the probe error and records why', () => {
    // 2026-10-02: + "can not be filtered" (Salesforce's spelling) and an HTTP 400 echoing our own CreatedDate filter (CaseHistory2)
    expect(U).toContain("if (/Implementation restriction|not supported|INVALID_TYPE|is not supported|cannot be filtered|can not be filtered|entity type .* does not support query|HTTP 400: \\w+ WHERE \\w+ != null AND CreatedDate >/i.test(msg)) item.cascadeUnchecked.push(")
    expect(SU).toContain('(Feed|History|History2|Share|Tag|ChangeEvent)$');;
    expect(U).toContain('else item.cascadeUnknown.push(`${rel.childSObject}: ${msg.slice(0, 90)}`);');
    expect(U).toContain('item.keptIds = [...kept];');
  });
  it('the plan offers "delete these anyway" only for unreadable children, keeps the typed word, and the Go applies it', () => {
    expect(U).toContain("const forceable = plan.some(it => !it.refused && it.keptIds && it.keptIds.length && it.cascadeUnknown && it.cascadeUnknown.length);");
    expect(U).toContain("if (ctx.anyWork || ctx.forceable) return '';");   // the verdict helper
    expect(RB).toContain('data-rb-pick="force|${esc(r.id)}"');   // per RECORD on the rollback page now
    expect(RB).toContain('Delete anyway — I checked what hangs under it');
    expect(RB).toContain('they did not stop the deletion');
    expect(U).toContain('if (forcedIds.length) created = created.concat(forcedIds);');
    expect(U).toContain('forced: forcedIds.length');
    expect(U).toContain("showToast('Nothing selected to roll back.'");
  });
});

describe('rollback: person-account contacts go with their Account', () => {
  it('excludes them from the Contact deletions and says so in the log and the plan', () => {
    expect(U).toContain("const pa = new Set(nowRows.filter(r => r && r.IsPersonAccount === true).map(r => r.Id));");
    expect(U).toContain('person-account contact(s) go with their Account — not deleted on their own');
    expect(U).toContain('keptIds: [], personSkipped };');
  });
});

describe('rollback and the org guards', () => {
  it('refuses a locked org before the re-read, and says so', () => {
    const i = U.indexOf('const lockedLeg = legs.find(l => typeof window.sftkOrgLocked === ');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(U.indexOf('const t = await ensureOrgType(leg.orgUrl);'));
    expect(U).toContain('a rollback writes there, so nothing was read or written.');
  });
  it('the typed word is the org name for production AND guarded orgs, and the dialog says why', () => {
    expect(U).toContain("else if (t !== 'sandbox' && t !== 'dev') { prod = true; prodUnknown.push(leg.orgUrl); }");
    expect(U).toContain("const typedWord = prod ? orgLabel(prodLeg.orgUrl) : 'ROLLBACK';");
    expect(RB).toContain('is production, or guarded as production, so the word to type is its name.');
  });
});
