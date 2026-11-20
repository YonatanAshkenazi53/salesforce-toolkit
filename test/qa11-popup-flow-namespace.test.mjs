// QA 1.1 finding 53: Flow Access joins a flow to its definition by full name, so a packaged and an own flow of one name keep two Ids.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFunctions } from './extract.mjs';

const SRC = readFileSync(new URL('../flow-permissions.js', import.meta.url), 'utf8');
const { sftkFlowAccessJoin: join, sftkFlowAccessFullName: full, sftkFlowAccessNote: note } =
  extractFunctions('flow-permissions.js', ['sftkFlowAccessFullName', 'sftkFlowAccessJoin', 'sftkFlowAccessNote']);

const view = (ApiName, NamespacePrefix, Label) => ({ ApiName, NamespacePrefix: NamespacePrefix || null, Label: Label || ApiName, ProcessType: 'Flow', TriggerType: null });
const def = (Id, DeveloperName, NamespacePrefix) => ({ Id, DeveloperName, NamespacePrefix: NamespacePrefix || null });

describe('the full name of a flow', () => {
  it('an own flow keeps its name; a packaged one gets its prefix once', () => {
    expect(full(null, 'Onboard')).toBe('Onboard');
    expect(full('', 'Onboard')).toBe('Onboard');
    expect(full('pkg', 'Onboard')).toBe('pkg__Onboard');
    expect(full('pkg', 'pkg__Onboard')).toBe('pkg__Onboard');
  });
});

describe('a packaged flow and an own flow of the same name', () => {
  const defs = [def('300OWN', 'Onboard'), def('300PKG', 'Onboard', 'pkg')];
  it('are two rows with two Ids, whichever definition comes last', () => {
    for (const d of [defs, [...defs].reverse()]) {
      const { flows, unresolved } = join([view('Onboard', null, 'Onboard (ours)'), view('Onboard', 'pkg', 'Onboard (package)')], d);
      expect(unresolved).toEqual([]);
      expect(flows.map(f => [f.DeveloperName, f.Id, f.MasterLabel])).toEqual([
        ['Onboard', '300OWN', 'Onboard (ours)'],
        ['pkg__Onboard', '300PKG', 'Onboard (package)'],
      ]);
      expect(new Set(flows.map(f => f.Id)).size).toBe(flows.length);
    }
  });
  it('also when the view already carries the prefix in ApiName', () => {
    const { flows } = join([view('Onboard'), view('pkg__Onboard', 'pkg')], defs);
    expect(flows.map(f => f.Id)).toEqual(['300OWN', '300PKG']);
  });
  it('the own flow is not given the packaged definition when its own is missing', () => {
    const { flows, unresolved } = join([view('Onboard'), view('Onboard', 'pkg')], [def('300PKG', 'Onboard', 'pkg')]);
    expect(flows.map(f => [f.DeveloperName, f.Id])).toEqual([['pkg__Onboard', '300PKG']]);
    expect(unresolved).toEqual(['Onboard']);
  });
});

describe('two rows never share one Id', () => {
  it('a second view row that resolves to a definition already taken is left out and named', () => {
    const { flows, unresolved } = join([view('A'), view('A')], [def('300A', 'A')]);
    expect(flows.length).toBe(1);
    expect(unresolved).toEqual(['A']);
  });
  it('a flow with no definition is left out and named; empty reads give empty lists', () => {
    expect(join([view('Ghost', 'ns')], [def('300A', 'A')])).toEqual({ flows: [], unresolved: ['ns__Ghost'] });
    expect(join(null, null)).toEqual({ flows: [], unresolved: [] });
  });
  it('the row keeps the kind of flow', () => {
    const { flows } = join([{ ApiName: 'A', Label: 'A flow', ProcessType: 'AutoLaunchedFlow', TriggerType: '' }], [def('300A', 'A')]);
    expect(flows[0]).toEqual({ Id: '300A', MasterLabel: 'A flow', DeveloperName: 'A', ProcessType: 'AutoLaunchedFlow', TriggerType: null });
  });
});

describe('what is left out is counted under the list', () => {
  it('nothing left out: no line', () => {
    expect(note(0, 0)).toBe('');
  });
  it('flows with no definition are counted, with what to do', () => {
    expect(note(0, 1)).toBe("1 flow is not listed because Salesforce returned no flow definition for it, so access cannot be granted here. Grant it in Setup, on the permission set's Flow Access page.");
    expect(note(0, 3)).toMatch(/^3 flows are not listed because Salesforce returned no flow definition for them/);
  });
  it('both kinds are said together', () => {
    const t = note(2, 1);
    expect(t).toContain('2 more active flows are not listed: record-triggered, scheduled and event flows start by themselves, so nobody is given access to them.');
    expect(t).toContain('1 flow is not listed because');
  });
});

describe('the tool reads the namespace on both sides and uses the join', () => {
  it('both queries carry NamespacePrefix; the bare-name lookup is gone', () => {
    expect(SRC).toMatch(/SELECT DurableId, Label, ApiName, NamespacePrefix, ProcessType, TriggerType\s+FROM FlowDefinitionView/);
    expect(SRC).toContain('query: `SELECT Id, DeveloperName, NamespacePrefix FROM FlowDefinition`');
    expect(SRC).not.toContain('fdIdByName');
    expect(SRC).toContain('const joined = sftkFlowAccessJoin(assignable, fdRes.records);');
    expect(SRC).toContain('_unresolved = unresolved.length;');
    expect(SRC).toContain('sftkFlowAccessNote(_selfRunning, _unresolved)');
  });
});
