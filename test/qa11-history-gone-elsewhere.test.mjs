// QA 1.1 finding 61: an entry deleted or cleared in the Toolkit stayed in an open Data Studio's memory and was written back by its next save.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const fc = n => ({ id: `fc_${n}`, kind: 'tool', tool: 'Field Cleaner', profileName: 'x', startedAt: `2026-11-10T10:0${n}:00.000Z`, toolUndo: { steps: [{}] } });
const pick = n => ({ id: `pk_${n}`, kind: 'tool', tool: 'Picklist Manager', profileName: 'x', startedAt: `2026-11-10T12:0${n}:00.000Z` });
const run = n => ({ id: `run_${n}`, profileName: 'Accounts', startedAt: `2026-11-10T09:0${n}:00.000Z`, summary: {} });

// Data Studio's page: its own list in memory, a save that writes the whole of it, and the storage events it hears.
function studio(history) {
  const listeners = [];
  const store = { sftk_history: JSON.parse(JSON.stringify(history)) };
  const ctx = vm.createContext({
    console: { warn() {}, log() {} }, setTimeout,
    chrome: { storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => Object.assign(store, JSON.parse(JSON.stringify(v))) }, onChanged: { addListener: fn => listeners.push(fn) } } },
    _history: history, _currentView: 'history', drawn: 0,
  });
  ctx.storageSaveHistory = async () => { store.sftk_history = JSON.parse(JSON.stringify(ctx._history)); };
  ctx.renderHistory = () => { ctx.drawn++; };
  vm.runInContext(read('sftk-history.js'), ctx);
  // another page (the popup) writes a new list: storage changes, every listener hears old and new
  const otherPageWrites = next => {
    const oldValue = store.sftk_history; store.sftk_history = next;
    for (const fn of listeners) fn({ sftk_history: { oldValue, newValue: next } }, 'local');
  };
  return { ctx, store, listeners, otherPageWrites };
}

describe('a Toolkit entry removed on another page', () => {
  it('leaves Data Studio\'s list, is redrawn, and the next save does not write it back', async () => {
    const s = studio([run(1), fc(1), fc(2), pick(1)]);
    expect(s.listeners).toHaveLength(1);
    s.otherPageWrites([run(1), fc(2), pick(1)]);          // the bin on one card
    expect(s.ctx._history.map(e => e.id)).toEqual(['run_1', 'fc_2', 'pk_1']);
    expect(s.ctx.drawn).toBe(1);
    s.otherPageWrites([run(1), pick(1)]);                 // Clear all
    await s.ctx.storageSaveHistory();                     // Data Studio's next save (a deployment, a rollback)
    expect(s.store.sftk_history.map(e => e.id)).toEqual(['run_1', 'pk_1']);
  });
  it('only a Toolkit tool\'s entry is dropped: a run or a Data Studio change missing from another page\'s list stays', () => {
    const s = studio([run(1), fc(1), pick(1)]);
    s.otherPageWrites([fc(1)]);
    expect(s.ctx._history.map(e => e.id)).toEqual(['run_1', 'fc_1', 'pk_1']);
    expect(s.ctx.drawn).toBe(0);
  });
  it('an entry added elsewhere, another storage area, or another key changes nothing here', () => {
    const s = studio([fc(1)]);
    s.otherPageWrites([fc(1), fc(2)]);
    for (const fn of s.listeners) { fn({ sftk_history: { oldValue: [fc(1)], newValue: [] } }, 'sync'); fn({ other: { oldValue: 1, newValue: 2 } }, 'local'); }
    expect(s.ctx._history.map(e => e.id)).toEqual(['fc_1']);
  });
  it('on a page without Data Studio\'s list (the popup) the listener does nothing', () => {
    const listeners = [];
    const ctx = vm.createContext({ console, chrome: { storage: { local: {}, onChanged: { addListener: fn => listeners.push(fn) } } } });
    vm.runInContext(read('sftk-history.js'), ctx);
    expect(() => listeners[0]({ sftk_history: { oldValue: [fc(1)], newValue: [] } }, 'local')).not.toThrow();
  });
  it('the ids that went: Toolkit entries of the old list absent from the new one', () => {
    const s = studio([]);
    expect(Array.from(s.ctx.sftkHistoryGoneIds([run(1), fc(1), fc(2), pick(1), null], [fc(2)]))).toEqual(['fc_1']);
    expect(Array.from(s.ctx.sftkHistoryGoneIds(undefined, undefined))).toEqual([]);
  });
});
