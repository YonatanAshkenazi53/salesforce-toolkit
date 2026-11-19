export const meta = {
  name: 'qa-1-1',
  description: 'Release QA of Salesforce Toolkit 1.1: eleven read-only reviewers over the code changed since master, every finding checked by a skeptic, then a completeness critic',
  whenToUse: 'Before master is fast-forwarded to the 1.1 branch. Read-only: nothing is edited, no org is touched.',
  phases: [
    { title: 'Review', detail: 'one reviewer per area of the 1.1 diff' },
    { title: 'Verify', detail: 'one skeptic per finding, told to refute it' },
    { title: 'Critic', detail: 'what the reviewers did not cover' },
  ],
}

// args (all optional): { base: 'master', finderModel: 'sonnet', votes: 1 | 3, only: ['plan', 'deploy-run'] }
const A = (args && typeof args === 'object') ? args : {}
const BASE = A.base || 'master'
const VOTES = A.votes === 3 ? 3 : 1
const MAX = 12

const RULES = `
You are reviewing the Salesforce Toolkit, a Chrome MV3 extension (plain JavaScript, no bundler), on the branch that
becomes release 1.1. The repository is the working directory.

HARD RULES — READ-ONLY:
- Do not edit, create or delete any file in the repository. Do not commit, stash, checkout or push.
- Do not run the headless harness (scripts/dev/headless-studio.mjs), anything under scripts/dev/live, or the sf CLI.
  No Salesforce org may be touched. Do not open a browser.
- You may read files, grep, run "git diff ${BASE}..HEAD -- <file>" and "git log", and run a single existing test file
  with "npx vitest run test/<file>". Scratch files go in the session scratchpad, never in the repository.

WHAT COUNTS AS A FINDING: a defect a user can hit — a wrong result, a crash, lost or corrupted metadata or records, an
undo that does not restore, a write to the wrong org, a missing escape of org-supplied text put into innerHTML, a
state that survives when it must not, a promise in CHANGELOG.md the code does not keep. Give the exact inputs or state
that trigger it. NOT a finding: style, naming, long functions, missing comments, "could be refactored", a test you
would like to exist, anything you cannot tie to a concrete failure.

Start from the diff against ${BASE} for your files, then read the surrounding code of every changed function before
you judge it: most of these files are large and a function's guard is often a few screens away.`

const AREAS = [
  { key: 'plan', title: 'Field Cleaner — All at once plan, Undo all, row undo',
    files: 'field-cleaner.js (fcPlanDefault, fcPlanCounts, fcPlanOwnsDialog, _planRows, _planHtml, planEverything, _planExecute, _planReport, undoAllForField, fcUndoRowParts, renderUndoAll, the fix* functions the plan calls), sftk-confirm.js (sftkConfirmPlanned)',
    focus: 'A plan row whose way is not possible for its kind; a row that fails mid-run and what the report then says; Stop pressed mid-run; the planned-confirm hook left set after a run ends or throws, so a LATER unrelated confirmation is answered without the user; restore points; Undo all with only some entries ticked; the order entries are undone in; the count on the Undo all button.' },
  { key: 'scan', title: 'Field Cleaner — scan legs and blocker kinds',
    files: 'field-cleaner.js (fcScopeLegs, fcEstimateScanCalls, the scan* functions, fcApexStringNames, fcRelatedListIsOf, fcRelatedListEdit, fcListViewNamesQualified, fcChildHasListViews, fcPromptNamesField, scanFlexiPages, _flexiNamesBeyondText, _mdReadOne, _lvNamesForIds)',
    focus: 'False positives (a field of the same name on another object, a name that is a prefix of another name, a namespaced twin) and false negatives (a reference form the matcher misses); a leg that throws and takes the whole scan down instead of reporting itself as not read; paging over 2,000 rows; a blocker listed as a mere mention or the reverse; estimate versus the calls really made.' },
  { key: 'mdapi', title: 'Metadata XML engine and field replace',
    files: 'sftk-mdapi.js, sftk-fieldreplace.js, sftk-emailtpl.js',
    focus: 'Every case of the edit table: remove and replace must change only the named field and leave valid XML; alias kinds (mdType) in package.xml and in undo; the ListView case for a column of another object (Object.Field and the 01I id form); GenAiPromptTemplate; bundle and code files (LWC, Aura, Apex) written back with every other file intact; XML entities and CDATA; a replace whose new name contains regex or $ characters.' },
  { key: 'sweep', title: 'Full text scan, reports and dependency map',
    files: 'sftk-sweep.js, sftk-report.js, dependency-map.js, sftk-depsel.js',
    focus: 'Types skipped silently; a type whose read fails; kinds mapped to the wrong fix; huge orgs (memory, a zip over the retrieve limit); a match inside a longer identifier; results cached across a field or org change.' },
  { key: 'history', title: 'Activity, history and undo',
    files: 'sftk-history.js, sftk-toolhistory.js, sftk-undo.js, studio-undo.js, studio-history.js',
    focus: 'The hot list cap of 100 and the IndexedDB archive: an entry undone, removed or listed twice, or lost on overflow; sftkHistoryUndoMany with archived entries; sftkHistoryRemove while a list is open; Back up / Restore / Clear all; an undo run against a different org than the one the change was made in; entry text put into innerHTML unescaped.' },
  { key: 'deploy-run', title: 'Data Deployment — the run, pause step, compare',
    files: 'studio-deploy.js, studio-reconcile.js, sftk-vrpause.js, sftk-pausepanel.js, sftk-run-progress.js, studio-transfer.js',
    focus: 'THE MOST IMPORTANT AREA: a rule or flow switched off for a run must come back on in EVERY ending — success, failure, Stop, a thrown error, the window closed, the leftover pass on the next open. Packaged validation rules go through a Metadata API deploy instead of a Tooling PATCH (_sftkVpWriteMsg, sftkVrPausePkgFiles, sftkVrPausePkgInner): check that only <active> changes, that the restore uses the same path, and that pkg / fullName survive the saved leftovers. Also: dry run versus real run sharing state, the owner line in the compare window, anything written to the SOURCE org.' },
  { key: 'deploy-build', title: 'Data Deployment — builder, owners, record editor, PII',
    files: 'studio-builder.js, studio-builder-modals.js, studio-valueedit.js, sftk-pii.js, sftk-relmap.js',
    focus: 'Owner mapping: mode match / skip, the fallback user, the new-deployment default versus a saved deployment opened for edit, and whether the text sftkVeOwnerWill shows is what the engine really does in each case (user, queue, many records, no fallback); a per-record owner override surviving a re-scan; composite keys with an empty field; PII masking applied to a field the user did not tick, or skipped on one they did; the running user cached per org.' },
  { key: 'background', title: 'Service worker and security',
    files: 'background.js, manifest.json, sftk-apiver.js, sftk-friendly-error.js',
    focus: 'Message handlers that take orgUrl / sid / path from the sender without checking the sender is an extension page; a path or URL built from caller text that can reach a host other than the org; session ids logged, stored or put in a URL; handlers added in 1.1 (SF_MD_READ, SF_METADATA_DEPLOY and neighbours): polling that never ends, a zip built wrongly, errors swallowed into a success; content-security or Trusted Types breaks.' },
  { key: 'tools', title: 'The other tools touched in 1.1',
    files: 'flow-permissions.js, sftk-flowbulk.js, apex-debugger.js, popup.js, lightning-pages.js, user-copy.js, studio-orghealth.js, studio-compare.js, sftk-merge.js, studio-core.js',
    focus: 'Regressions in tools that were not the centre of 1.1: a changed shared helper that an older caller still calls the old way; bulk flow switches that stop half way; the production-org gate; tab state leaking between orgs.' },
  { key: 'ui', title: 'Themes, loaders and the words on screen',
    files: 'styles.css, studio.css, sftk-progress.js, debug-logger.js, studio-whatsnew.js, CHANGELOG.md, and the template strings of the files above',
    focus: 'A class added in 1.1 with a hard-coded colour that is unreadable in the dark theme (body.sftk-dark in the Toolkit, html.ds-dark and html.ds-oled in Data Studio); a control with no disabled or busy state; text aligned wrong for a left-to-right UI; CHANGELOG.md or a UI string that carries a chat quote, Hebrew, or a claim the code does not keep; a button whose handler was removed with the old wizard (fixEverything, fixAll, the walk) but whose markup or caller remains.' },
  { key: 'claims', title: 'What 1.1 says it does versus what is tested',
    files: 'CHANGELOG.md (the 1.1 section), docs/QA-1.1.md, docs/BACKLOG.md (rows closed since 2026-11-08), test/*-111*.test.mjs, scripts/dev/live, scripts/dev/video/sections.mjs',
    focus: 'A CHANGELOG bullet with no code behind it; a BACKLOG row closed on a verification that no longer exists (a deleted test or script); live scripts and the video script that still click controls removed with the old wizard; a test that pins a string but would pass with the feature broken. Report these as findings with the file that is stale.' },
]

const FINDINGS = {
  type: 'object',
  properties: {
    covered: { type: 'string', description: 'what you read, in one or two sentences' },
    notCovered: { type: 'string', description: 'what you were asked to read and did not get to' },
    findings: { type: 'array', maxItems: MAX, items: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'integer' },
        severity: { type: 'string', enum: ['data-loss', 'wrong-result', 'crash', 'security', 'ui', 'stale'] },
        scenario: { type: 'string', description: 'exact inputs or state, then what goes wrong' },
        evidence: { type: 'string', description: 'the lines of code that show it' },
      },
      required: ['title', 'file', 'line', 'severity', 'scenario', 'evidence'],
    } },
  },
  required: ['covered', 'notCovered', 'findings'],
}
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    why: { type: 'string', description: 'the code that settles it, with file and line' },
    fix: { type: 'string', description: 'when not refuted: the smallest change that fixes it' },
  },
  required: ['refuted', 'why'],
}

const areas = Array.isArray(A.only) && A.only.length ? AREAS.filter(a => A.only.includes(a.key)) : AREAS
const coverage = []

const perArea = await pipeline(
  areas,
  a => agent(`${RULES}

YOUR AREA: ${a.title}
FILES: ${a.files}
LOOK HARDEST AT: ${a.focus}

Return at most ${MAX} findings, the worst first. An empty list is a good answer when the code holds. Say plainly in
notCovered what you did not read.`, { label: `review:${a.key}`, phase: 'Review', schema: FINDINGS, ...(A.finderModel ? { model: A.finderModel } : {}) }),
  (r, a) => {
    if (!r) { coverage.push({ area: a.key, covered: '', notCovered: 'the reviewer did not return' }); return [] }
    coverage.push({ area: a.key, covered: r.covered, notCovered: r.notCovered })
    return parallel((r.findings || []).map((f, i) => () =>
      parallel(Array.from({ length: VOTES }, (_, v) => () =>
        agent(`${RULES}

Another reviewer claims this defect. Your job is to REFUTE it: open the file, read the whole function and its
callers, find the guard, the caller or the Salesforce behaviour that makes the scenario impossible. If the claim
survives an honest attempt, say so and give the smallest fix. When you cannot tell, answer refuted = true.

CLAIM: ${f.title}
WHERE: ${f.file}:${f.line}
SCENARIO: ${f.scenario}
EVIDENCE GIVEN: ${f.evidence}`, { label: `verify:${a.key}#${i + 1}${VOTES > 1 ? '.' + (v + 1) : ''}`, phase: 'Verify', schema: VERDICT })))
        .then(vs => {
          const ok = vs.filter(Boolean), stands = ok.filter(x => !x.refuted)
          const real = ok.length > 0 && stands.length * 2 > ok.length
          return { ...f, area: a.key, real, votes: `${stands.length}/${ok.length}`, why: (real ? stands : ok).map(x => x.why).join(' | '), fix: stands.map(x => x.fix).filter(Boolean)[0] || '' }
        })))
  }
)

const all = perArea.flat().filter(Boolean)
const ORDER = ['data-loss', 'security', 'wrong-result', 'crash', 'ui', 'stale']
const confirmed = all.filter(f => f.real).sort((x, y) => ORDER.indexOf(x.severity) - ORDER.indexOf(y.severity))
const refuted = all.filter(f => !f.real).map(f => ({ area: f.area, title: f.title, file: f.file, line: f.line, why: f.why }))
log(`${all.length} findings raised, ${confirmed.length} stand, ${refuted.length} refuted`)

phase('Critic')
const critic = await agent(`${RULES}

Eleven reviewers went over the 1.1 diff. Below is what each says it covered and did not, and the titles of the
findings that stood. Name what is MISSING: a file changed since ${BASE} ("git diff --stat ${BASE}..HEAD") that no
area lists, a feature in the 1.1 section of CHANGELOG.md nobody looked at, a failure mode nobody asked about. Then
review the single most important gap yourself, under the same rules, and report what you find there.

COVERAGE: ${JSON.stringify(coverage)}
FINDINGS THAT STOOD: ${JSON.stringify(confirmed.map(f => f.area + ': ' + f.title))}`, { label: 'critic', phase: 'Critic', schema: {
  type: 'object',
  properties: {
    gaps: { type: 'array', items: { type: 'string' } },
    findings: FINDINGS.properties.findings,
  },
  required: ['gaps', 'findings'],
} })

return { confirmed, critic: critic || { gaps: ['the critic did not return'], findings: [] }, refuted, coverage }
