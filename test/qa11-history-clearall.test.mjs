// QA 1.1 finding 6: Data Studio › History › Clear All also deleted every Toolkit change and its Undo, which the same
// page says are not listed there. Clear All now removes what the page lists (deployments, rollbacks, Data Studio's
// own changes — in the list and in the archive) and leaves the Toolkit tools' changes, and the dialog says so.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractFunctions } from './extract.mjs';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SH = read('studio-history.js').replace(/\r\n/g, '\n');
// sftkHistoryToolTab reads the file's own tool table, so the pure functions are taken from the whole file
const HX = vm.createContext({ console });
vm.runInContext(read('sftk-history.js'), HX);
const keepOf = l => Array.from(HX.sftkHistoryStudioClearKeep(l)), split = l => HX.sftkHistoryStudioSplit(l);
const { _histClearAllBody: body } = extractFunctions('studio-history.js', ['_histClearAllBody']);

const fc = n => ({ id: `fc_${n}`, kind: 'tool', tool: 'Field Cleaner', profileName: 'x', startedAt: `2026-11-10T10:0${n}:00.000Z`, toolUndo: { steps: [{}] } });
const lic = n => ({ id: `li_${n}`, kind: 'tool', tool: 'License Manager', profileName: 'x', startedAt: `2026-11-10T11:0${n}:00.000Z` });
const pick = n => ({ id: `pk_${n}`, kind: 'tool', tool: 'Picklist Manager', profileName: 'x', startedAt: `2026-11-10T12:0${n}:00.000Z` });
const run = n => ({ id: `run_${n}`, profileName: 'Accounts', startedAt: `2026-11-10T09:0${n}:00.000Z`, summary: {} });

describe('what Clear All leaves', () => {
  it('every change made with a Toolkit tool stays; deployments and Data Studio’s own tool changes go', () => {
    const list = [run(1), fc(1), pick(1), lic(1), run(2), null];
    expect(keepOf(list).map(e => e.id)).toEqual(['fc_1', 'li_1']);
    // exactly the entries the page counts as "not listed here"
    expect(keepOf(list)).toHaveLength(split(list).kitTotal);
    expect(keepOf(null)).toEqual([]);
  });
  it('the archive keeps the Toolkit entries too: only this page’s runs are deleted from it', async () => {
    const arch = new Map([run(1), fc(1), pick(1), lic(1)].map(e => [e.id, e]));
    const ctx = vm.createContext({
      console,
      sftkArchList: async () => [...arch.values()],
      _sftkArchTx: async (mode, fn) => { fn({ delete: id => arch.delete(id) }); },
    });
    vm.runInContext(read('sftk-history.js'), ctx);
    // the call the Clear All handler makes
    expect(await ctx.sftkHistoryArchDrop(e => !ctx.sftkHistoryToolTab(e))).toBe(2);
    expect([...arch.keys()]).toEqual(['fc_1', 'li_1']);
  });
});

describe('the Clear All handler', () => {
  const at = SH.indexOf("eid('dsConfirmClearHistory')?.addEventListener('click'");
  const h = SH.slice(at, SH.indexOf('renderHistory();', at));
  it('keeps the Toolkit entries in the list and in the archive, then saves', () => {
    expect(at).toBeGreaterThan(0);
    expect(h).toContain('const keepKit = window.sftkHistoryStudioClearKeep, archDrop = window.sftkHistoryArchDrop;');
    expect(h).toContain('_history = keepKit(_history);');
    expect(h).toContain('await archDrop(e => !sftkHistoryToolTab(e));');
    expect(h).not.toContain('_history = [];');
    expect(h).not.toContain('sftkArchClear');
    expect(h.indexOf('_history = keepKit(_history);')).toBeLessThan(h.indexOf('await storageSaveHistory();'));
    // both are published by sftk-history.js, which studio.html loads
    expect(HX.sftkHistoryStudioClearKeep).toBeTypeOf('function');
    expect(HX.sftkHistoryArchDrop).toBeTypeOf('function');
    expect(read('studio.html')).toContain('<script src="sftk-history.js"></script>');
  });
  it('refuses, with the reason, when it cannot tell its own runs from the Toolkit’s — it never falls back to wiping all', () => {
    const guard = h.slice(h.indexOf("typeof keepKit !== 'function'"), h.indexOf('_history = keepKit(_history);'));
    expect(guard).toContain('History was not cleared');
    expect(guard).toContain('return;');
  });
});

describe('what the dialog says before it runs', () => {
  it('names what is deleted, and that nothing in Salesforce changes', () => {
    const t = body(0);
    expect(t).toContain('Deletes every deployment, rollback and Data Studio change listed here, the archived ones included');
    expect(t).toContain('restore points kept for Roll back');
    expect(t).toContain('Nothing in Salesforce is changed.');
    expect(t).toContain('Changes made with Toolkit tools stay');
  });
  it('counts the Toolkit changes that stay', () => {
    expect(body(1)).toContain('The 1 change made with Toolkit tools stays, with its ↩ Undo');
    expect(body(1234)).toContain('The 1,234 changes made with Toolkit tools stay, each with its ↩ Undo');
    expect(body(3)).toContain("clear them in the tool's own Activity.");
  });
  it('is the body of the Clear History dialog, with the count of the list at hand', () => {
    expect(SH).toContain("bodyHtml: _histClearAllBody((typeof sftkHistoryStudioSplit === 'function') ? sftkHistoryStudioSplit(_history).kitTotal : 0),");
    expect(SH).not.toContain('Delete all transfer history records?');
  });
});
