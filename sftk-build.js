// ── What this build leaves out ─────────────────────────────────────────────
// The repository / developer build ships every tool: the list is empty.
// scripts/pack_store.py rewrites the ONE line below for the public build with
// the tools that build does not carry (user 2026-10-05: Data Studio ships
// Connected Orgs, Data Deployment, All open orgs, History, Org Compare and Org
// health; the Toolkit ships "all besides licenses").
//
// A page asks sftkShips('<id>') before it LINKS to a tool that lives on the
// other page (Data Studio's command palette and Org health open Toolkit tabs;
// a link to a tab that is not there would open a blank page). Inside one page
// a missing tool is already detected by its missing function.
// Ids: Toolkit tab ids ('licenses'), Data Studio view ids ('readiness'), and
// 'debug' — the Debug Log of both pages (user 2026-10-05: "i dont think the
// store release should have debug feature for both tookit and data studio").
// Without it the recorder (debug-logger.js) can never be switched on.
// 'pro' (Data Studio's Pro mode) and 'guidance' (the tours and help bubbles
// of onboarding.js) — cut 2026-10-06 ("cut pro mode … in app guidance as well").
window.SFTK_CUT = [];

function sftkShips(id) {
  return !(Array.isArray(window.SFTK_CUT) && window.SFTK_CUT.includes(String(id)));
}
if (typeof window !== 'undefined') window.sftkShips = sftkShips;
