#!/usr/bin/env python3
"""Contract 1161 app checks. Runs the app in a headless browser with a fake Firebase (no real data, nothing is saved).

  python3 tools/test/run.py                 quick check of index.html (errors, layout, clicks, voice)
  python3 tools/test/run.py --full          every page, admin and driver view, phone and desktop, light and dark, en/pt/pa
  python3 tools/test/run.py --compare A B   screenshot every page from two versions and report any pixel differences

Needs: pip install playwright pillow  (Chromium comes with Playwright)
Exit code is 1 if anything failed.
"""
import sys, os, io, json, argparse
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
STUB = open(os.path.join(HERE, 'fake-firebase.js')).read()
SEEDJS = open(os.path.join(HERE, 'seed.js')).read()
ADMIN = ['home','menu','results','survey','summary','enquiries','ncr','runs','sort','precards','lockers','guide','leave','cover','updates','briefs','reports','feedback','directory','invoices','timesheets','staff','compliance','vchecks','uniform','tasks','clock','alerts']
DRIVER = ['home','me','menu','updates','briefs','runs','guide','leave','invoices','directory','reports','feedback','myenq','clock','alerts']
VOICE = {"load new results":"mod-results","load the nps results":"mod-survey","who hasn't clocked in":"mod-timesheets","compliance for adam":"mod-compliance",
         "van checks for fabio":"mod-vchecks","open precards":"mod-precards","show me the leave calendar":"mod-leave","driver results":"mod-results","enquiries":"mod-enquiries","uniform":"mod-uniform"}
FAKE_MIC = """window.__say='';class FR{start(){setTimeout(()=>{this.onstart&&this.onstart();const r=[{transcript:window.__say,confidence:.95}];r.isFinal=true;const ev={results:[r],resultIndex:0};this.onresult&&this.onresult(ev);setTimeout(()=>{this.onend&&this.onend()},50)},50)}stop(){this.onend&&this.onend()}abort(){}addEventListener(){}};window.SpeechRecognition=FR;window.webkitSpeechRecognition=FR;"""
PAGE_CHECK = open(os.path.join(HERE, 'page-check.js')).read()
CLICKABLE = "#sh-tabs .sh-hubtabs>button, .sh-sec:not([hidden]) :is(.tabs,.seg,.pseg2,.pvseg,.modes,.pf-chips,.eq-pcs,.tiles,.nstat,.rb-tot,.cpm-t,.pcm-t,.thseg)>:is(button,[role=button]):not([disabled]), .sh-sec:not([hidden]) .fold-bar, .sh-sec:not([hidden]) details>summary"
SKIP = "[data-sh=uv],[data-sh=mv],[data-rp=file],[data-pc=open],[data-sh=signout]"

def page(b, html, theme='dark', W=390, lang='en', mic=False, freeze=False, data=False):
    pg = b.new_page(viewport={'width': W, 'height': 900}, color_scheme=theme)
    init = f"try{{localStorage.setItem('theme1161','{theme}');localStorage.setItem('lang1161','{lang}')}}catch(e){{}};"
    if freeze: init += "Date.now=(()=>{const t=Date.UTC(2026,10,2,1,0,0);return()=>t})();"
    if mic: init += FAKE_MIC
    if data: init += SEEDJS
    pg.add_init_script(init)
    pg.route('**/firebasejs/**', lambda r: r.fulfill(body=STUB if 'app-compat' in r.request.url else '', content_type='application/javascript'))
    pg.route('https://**', lambda r: r.fulfill(body='', status=200) if 'firebasejs' not in r.request.url else r.fallback())
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)[:160])); pg.__errs = errs
    pg.goto('file://' + os.path.abspath(html)); pg.wait_for_timeout(1800)
    return pg

def frame_for(pg, who):
    if who != 'drv': return pg.main_frame
    pg.evaluate("document.querySelector('[data-sh=\"settings\"]').click()"); pg.wait_for_timeout(400)
    pg.evaluate("document.querySelector('#sh-set [data-sh=\"uv\"]').click()"); pg.wait_for_timeout(2500)
    fr = [x for x in pg.frames if x != pg.main_frame][0]
    fr.evaluate("()=>{window.__E=[];addEventListener('error',e=>window.__E.push(String(e.message).slice(0,150)))}")
    return fr

def check_pages(b, html, theme, W, lang, who):
    fails = []
    pg = page(b, html, theme, W, lang); fr = frame_for(pg, who)
    for s in (DRIVER if who == 'drv' else ADMIN):
        n0 = len(pg.__errs)
        try:
            fr.evaluate("s=>APP.go(s)", s); pg.wait_for_timeout(600)
            r = fr.evaluate(PAGE_CHECK)
        except Exception as e: r = {'error': str(e)[:120]}
        js = pg.__errs[n0:] + (fr.evaluate("()=>window.__E.splice(0)") if who == 'drv' else [])
        if js: r['js'] = js
        bad = {k: v for k, v in r.items() if v and k != 'sec'}
        if bad: fails.append(f"{who} {theme} {W}px {lang} {s}: {json.dumps(bad)[:400]}")
    pg.close(); return fails

def click_all(b, html, who):
    fails = []; pg = page(b, html); fr = frame_for(pg, who); n = 0
    for s in (DRIVER if who == 'drv' else ADMIN):
        if s in ('alerts', 'ncr', 'menu'): continue
        fr.evaluate("s=>APP.go(s)", s); pg.wait_for_timeout(500); n0 = len(pg.__errs)
        for _ in range(2):
            k = fr.evaluate(f"()=>[...document.querySelectorAll({CLICKABLE!r})].filter(e=>e.offsetParent).length")
            for i in range(min(k, 30)):
                fr.evaluate(f"i=>{{const L=[...document.querySelectorAll({CLICKABLE!r})].filter(e=>e.offsetParent);const e=L[i];if(e&&!e.matches({SKIP!r}))e.click()}}", i); pg.wait_for_timeout(100); n += 1
        js = pg.__errs[n0:] + (fr.evaluate("()=>window.__E.splice(0)") if who == 'drv' else [])
        if js: fails.append(f"clicks {who} {s}: {js}")
    pg.close(); return fails, n

def voice(b, html):
    fails = []
    for said, want in VOICE.items():
        pg = page(b, html, mic=True); pg.evaluate("t=>{window.__say=t}", said)
        pg.evaluate("()=>{const m=document.querySelector('.ah-mic');m&&m.click()}"); pg.wait_for_timeout(3000)
        got = pg.evaluate("()=>{const s=[...document.querySelectorAll('#sh-main .sh-sec')].find(s=>!s.hidden&&s.offsetParent);return s?s.id:'none'}")
        if got != want: fails.append(f"voice '{said}' went to {got}, expected {want}")
        pg.close()
    return fails

def shots(b, html, theme, W):
    out = {}
    for s in ADMIN:
        if s in ('alerts', 'ncr'): continue
        pg = page(b, html, theme, W, freeze=True)
        pg.evaluate("s=>APP.go(s)", s); pg.wait_for_timeout(700)
        pg.evaluate("()=>{const f=[...document.querySelectorAll('.fold-bar')].find(x=>x.offsetParent);f&&f.click()}"); pg.wait_for_timeout(300)
        out[s] = pg.screenshot(full_page=True, animations='disabled', caret='hide'); pg.close()
    return out

def compare(b, A, B, outdir):
    from PIL import Image, ImageChops
    fails = []
    for theme, W in [('dark', 390), ('light', 390), ('dark', 1366), ('light', 1366)]:
        sa, sb = shots(b, A, theme, W), shots(b, B, theme, W)
        for s in sa:
            a = Image.open(io.BytesIO(sa[s])).convert('RGB'); c = Image.open(io.BytesIO(sb[s])).convert('RGB')
            if a.size != c.size: fails.append(f"{theme} {W}px {s}: page height changed {a.size} -> {c.size}"); continue
            d = ImageChops.difference(a, c).convert('L'); px = sum(1 for v in d.getdata() if v > 16)
            if px > 30:
                fails.append(f"{theme} {W}px {s}: {px} pixels differ")
                if outdir: os.makedirs(outdir, exist_ok=True); a.save(f"{outdir}/{theme}{W}_{s}_before.png"); c.save(f"{outdir}/{theme}{W}_{s}_after.png")
    return fails

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('html', nargs='?', default=os.path.join(ROOT, 'index.html'))
    ap.add_argument('--full', action='store_true'); ap.add_argument('--compare', nargs=2, metavar=('BEFORE', 'AFTER')); ap.add_argument('--out', default='')
    a = ap.parse_args(); fails = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        if a.compare:
            fails += compare(b, a.compare[0], a.compare[1], a.out)
        else:
            combos = [('dark', 390, 'en', 'admin'), ('dark', 390, 'en', 'drv'), ('light', 390, 'en', 'admin')]
            if a.full: combos += [('light', 390, 'en', 'drv'), ('dark', 1366, 'en', 'admin'), ('light', 1366, 'en', 'admin'), ('dark', 1366, 'en', 'drv'), ('dark', 390, 'pt', 'drv'), ('dark', 390, 'pa', 'drv'), ('light', 390, 'pt', 'admin')]
            for c in combos: fails += check_pages(b, a.html, *c); print('pages', c, 'done', flush=True)
            for who in ('admin', 'drv'):
                f, n = click_all(b, a.html, who); fails += f; print('clicks', who, n, flush=True)
            fails += voice(b, a.html); print('voice done', flush=True)
        b.close()
    print('\n'.join(fails) if fails else 'ALL CHECKS PASSED')
    sys.exit(1 if fails else 0)

if __name__ == '__main__': main()
