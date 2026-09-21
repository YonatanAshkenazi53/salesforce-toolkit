# Chrome Web Store packager — builds a LABS-FREE release zip.
# Usage:  python scripts/pack_store.py
# Output: dist/salesforce-toolkit-v<version>-store.zip  (+ dist/store-staging/)
#
# What "Labs-free" means (user call 2026-07-18: ship without the not-baked
# previews): Deploy Readiness, Schema View and Field Audit are excluded —
# their JS files are not packed, their <script> tags and the whole
# "Labs · early previews" nav section are stripped from studio.html.
# Runtime safety net: studio-core's _viewAvailable() already hides their
# palette/hash entries and falls back to home if anything still points there.
#
# The script FAILS LOUDLY if any check doesn't hold — never ship a zip that
# wasn't verified.

import io, json, os, re, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
STAGE = os.path.join(DIST, 'store-staging')

# studio-readiness.js graduated out of Labs 2026-07-20 (ring-aware rebuild) —
# it SHIPS now; only Schema View + Field Audit stay excluded.
LABS_JS = {'studio-schema.js', 'studio-fields.js'}
# studio-tools.js is kept in the repo as the tool-mounting recipe but is not
# loaded by any page — no reason to ship it. content.js is likewise a
# comment-only placeholder (no content_scripts key, nothing injects it) —
# shipping an unregistered "content script" just invites reviewer questions.
# Org Seeder: held back from the STORE build while it is hardened (user
# 2026-08-31: "we need to test it more") — it wipes and reseeds whole orgs,
# so it graduates only after the dev-org test plan passes. The dev build
# keeps it; the packer strips the file, its script tag and its nav button.
HELD_BACK_JS = {'studio-seed.js'}
EXCLUDE_JS = LABS_JS | HELD_BACK_JS | {'studio-tools.js', 'content.js'}

def fail(msg):
    print(f'❌ PACK FAILED: {msg}')
    sys.exit(1)

def main():
    manifest = json.load(io.open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
    version = manifest.get('version') or fail('manifest has no version')

    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(STAGE, exist_ok=True)

    # ── Collect runtime files ────────────────────────────────────────────
    copied = []
    for name in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, name)
        if os.path.isfile(p):
            ext = os.path.splitext(name)[1].lower()
            # LICENSE/EULA/PRIVACY ship so the in-app licence gate can link
            # to them: a gate pointing at a 404 is not an agreement.
            if name in ('manifest.json', 'CHANGELOG.md', 'LICENSE', 'EULA.md', 'PRIVACY.md') \
                    or ext in ('.html', '.css', '.png'):
                pass
            elif ext == '.js':
                if name in EXCLUDE_JS or name.startswith('_') or name.startswith('eslint'):
                    continue
            else:
                continue
            shutil.copy2(p, os.path.join(STAGE, name))
            copied.append(name)
    if os.path.isdir(os.path.join(ROOT, 'icons')):
        shutil.copytree(os.path.join(ROOT, 'icons'), os.path.join(STAGE, 'icons'))
        copied += [f'icons/{f}' for f in os.listdir(os.path.join(ROOT, 'icons'))]

    # ── Strip Labs from studio.html ──────────────────────────────────────
    sh_path = os.path.join(STAGE, 'studio.html')
    html = io.open(sh_path, encoding='utf-8').read()
    for js in (LABS_JS | HELD_BACK_JS):
        html = re.sub(rf'[ \t]*<script src="{re.escape(js)}"></script>\r?\n?', '', html)
    # The Seeder's nav button — a button for a stripped view would open a
    # blank page (the router falls back, but the button must not exist).
    m = re.search(r'[ \t]*<button class="ds-nav-btn" data-view="seed">.*?</button>\r?\n?', html, re.S)
    if not m:
        fail('Org Seeder nav button not found in studio.html — nav layout changed?')
    html = html[:m.start()] + html[m.end():]
    i_labs = html.find('<!-- Labs:')
    i_footer = html.find('<!-- Nav footer -->')
    if i_labs == -1 or i_footer == -1 or i_footer < i_labs:
        fail('Labs nav markers not found in studio.html — nav layout changed?')
    html = html[:i_labs] + html[i_footer:]
    io.open(sh_path, 'w', encoding='utf-8').write(html)

    # ── Strip HTML comments from every staged page ───────────────────────
    # Dev comments carry internal history (Labs notes, dated decisions, file
    # names that don't ship). Runs AFTER the Labs slice above, which needs
    # its marker comments intact. Store-audit 2026-07-27.
    for name in os.listdir(STAGE):
        if name.endswith('.html'):
            p = os.path.join(STAGE, name)
            doc = io.open(p, encoding='utf-8').read()
            doc = re.sub(r'[ \t]*<!--.*?-->\r?\n?', '', doc, flags=re.S)
            io.open(p, 'w', encoding='utf-8').write(doc)
    html = io.open(sh_path, encoding='utf-8').read()   # re-read for post-checks

    # ── Ship CHANGELOG.md without its contributor preamble ───────────────
    # The header names repo-only files and the release process; the What's
    # New parser ignores it, but the raw file is world-readable in the CRX.
    ch_path = os.path.join(STAGE, 'CHANGELOG.md')
    ch = io.open(ch_path, encoding='utf-8').read()
    first_entry = ch.find('\n## ')
    if first_entry == -1:
        fail('CHANGELOG.md has no "## " release entry')
    title = ch.split('\n', 1)[0]
    ch = title + '\n' + ch[first_entry:]

    # Drop release-note bullets about features this build excludes. The in-app
    # What's New renders CHANGELOG.md verbatim, so a Labs bullet advertises a
    # view the store user has no way to open (QA 2026-07-29). Bullets continue
    # across wrapped lines until the next bullet or heading.
    out_lines, skipping = [], False
    for line in ch.split('\n'):
        stripped = line.lstrip()
        if stripped.startswith('- '):
            skipping = '(Labs)' in line
        elif stripped.startswith('#') or not stripped:
            skipping = False
        if not skipping:
            out_lines.append(line)
    ch = '\n'.join(out_lines)
    if '(Labs)' in ch:
        fail('CHANGELOG Labs-bullet strip left a "(Labs)" mention behind')
    io.open(ch_path, 'w', encoding='utf-8').write(ch)

    # ── Post-checks ──────────────────────────────────────────────────────
    for js in EXCLUDE_JS:
        if os.path.exists(os.path.join(STAGE, js)):
            fail(f'{js} leaked into staging')
    for needle in ['studio-seed.js', 'data-view="seed"',
                   'studio-schema.js', 'studio-fields.js',
                   'data-view="schema"', 'data-view="fields"']:
        if needle in html:
            fail(f'packed studio.html still contains {needle}')
    # every local script/css/icon reference in every packed html must resolve
    for name in os.listdir(STAGE):
        if not name.endswith('.html'):
            continue
        doc = io.open(os.path.join(STAGE, name), encoding='utf-8').read()
        for ref in re.findall(r'(?:src|href)="([^"]+)"', doc):
            if ref.startswith(('http', 'chrome', '#', 'data:')):
                continue
            # a query string / fragment addresses the same file (legal.html?doc=eula)
            path = re.split(r'[?#]', ref, 1)[0]
            if not path or not os.path.exists(os.path.join(STAGE, path)):
                fail(f'{name} references missing file: {ref}')
    sw = manifest.get('background', {}).get('service_worker')
    if sw and not os.path.exists(os.path.join(STAGE, sw)):
        fail(f'service worker missing: {sw}')
    popup = manifest.get('action', {}).get('default_popup')
    if popup and not os.path.exists(os.path.join(STAGE, popup)):
        fail(f'default_popup missing: {popup}')
    for icon in (manifest.get('icons') or {}).values():
        if not os.path.exists(os.path.join(STAGE, icon)):
            fail(f'icon missing: {icon}')

    # ── Zip ──────────────────────────────────────────────────────────────
    os.makedirs(DIST, exist_ok=True)
    zip_path = os.path.join(DIST, f'salesforce-toolkit-v{version}-store.zip')
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(STAGE):
            for f in files:
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, STAGE))
    size = os.path.getsize(zip_path)
    print(f'✅ {os.path.relpath(zip_path, ROOT)} — {len(copied)} files, {size/1024:.0f} KB')
    print('   Labs excluded:', ', '.join(sorted(LABS_JS)), '(+ studio-tools.js, content.js, harness/_ files, eslint config; html comments + changelog preamble stripped)')

if __name__ == '__main__':
    main()
