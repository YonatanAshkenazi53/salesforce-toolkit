// 2026-11-23, the owner on the Flows list, Screen tab ("Screen 2", one tree of three rows, the third auto-launched):
//   "screen flow says it found two but display only one" — answered "1": tag the flow of another kind, keep the tree whole.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
const rd = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PJ = rd('popup.js'), CSS = rd('styles.css');
const grab = name => { const a = PJ.indexOf('function ' + name + '('); return PJ.slice(a, PJ.indexOf('\n', a)); };
const { other } = new Function(grab('sftkFlowKindTab') + '\n' + grab('sftkFlowOtherKind') + '\nreturn { other: sftkFlowOtherKind };')();

describe('a flow of another kind under a kind tab', () => {
  it('is a guest only when a kind is picked and it is not that kind', () => {
    expect(other('Flow', 'AutoLaunchedFlow')).toBe(true);
    expect(other('Flow', 'Flow')).toBe(false);
    expect(other('all', 'AutoLaunchedFlow')).toBe(false);
    expect(other('', 'AutoLaunchedFlow')).toBe(false);
    expect(other('other', 'PlatformEventFlow')).toBe(false);
    expect(other('other', 'Flow')).toBe(true);
    expect(other('AutoLaunchedFlow', '')).toBe(true);
  });
  it('the tree says how many of its flows the tab counts, and the guest row is tagged and dimmed', () => {
    expect(PJ).toContain("${nOther ? ` · ${n - nOther} of this tab's kind` : ''}");
    expect(PJ).toContain("g.classList.add('flow-group-otherkind');");
    expect(PJ).toContain("tag.className = 'flow-otherkind-tag';");
    expect(CSS).toContain('.flow-group-otherkind .group-label, .flow-group-otherkind .flow-kind-ico { opacity: .55; }');
    expect(CSS).toContain('.flow-otherkind-tag {');
  });
});
