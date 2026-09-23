// Licenses — after a deactivation the user vanishes from the list (it shows
// active users by default), so ✅ Reactivate could not find them until the
// Inactive filter was clicked (live 2026-09-23). The result says where they went.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'license-manager.js'), 'utf8');

describe('Licenses — the deactivate result points at the Inactive filter', () => {
  it('only when the list is on the Active filter', () => {
    expect(SRC).toContain("${isDeactivate && currentFilter === 'active' ? ' They now show under the <strong>Inactive</strong> filter (the list shows active users by default).' : ''}");
  });
  it('the filter buttons exist for active / inactive / all', () => {
    for (const f of ['active', 'inactive', 'all']) expect(SRC).toMatch(new RegExp(`data-filter="${f}"`));
  });
});
