// Test setup (2026-11-14): sftk-relmap.js is the ONE relationship-hop resolver that sftk-mdapi.js, sftk-emailtpl.js
// and field-cleaner.js call as page globals — popup.html loads it before all three. Many tests evaluate one of those
// files (or functions sliced out of it) on its own with new Function, whose free names resolve on globalThis; the
// resolver is put there first, exactly as the page has it, so no test has to know which file the hops live in.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../sftk-relmap.js', import.meta.url), 'utf8');
const names = ['sftkRelHop', 'sftkRelLookupField', 'sftkRelWalk', 'sftkRelGlobal', 'sftkRelHopKnown', 'SFTK_REL', 'SFTK_REL_PARENT', 'SFTK_REL_GLOBAL'];
Object.assign(globalThis, new Function(`${src}\nreturn { ${names.join(', ')} };`)());

// sftkMdIsOwnObj (sftk-mdapi.js, 2026-11-14 review 5): "is a component of this object on objApi's own fields" — Task
// and Event are Activity's. sftkRtEdit, _sftkMdSwapToken and sftkMdEditField call it, and tests slice those out of the
// file one by one (test/extract.mjs); it is put on globalThis too, as the page has every top-level function.
import { extractFunction } from './extract.mjs';
globalThis.sftkMdIsOwnObj = extractFunction('sftk-mdapi.js', 'sftkMdIsOwnObj');
// sftkMdFamObj (2026-11-15): the Task / Event → Activity rule of a picked custom field, called by the removers
globalThis.sftkMdFamObj = extractFunction('sftk-mdapi.js', 'sftkMdFamObj');
