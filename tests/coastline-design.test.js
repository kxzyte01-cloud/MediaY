const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const style=read('style.css'),setupStyle=read('setup.css'),html=read('index.html'),setup=read('setup.js'),app=read('app.js'),icons=read('mediay-icons.js'),sw=read('sw.js'),legal=read('legal.html'),workflow=read('.github/workflows/built.yml');
function lum(hex){const n=parseInt(hex.slice(1),16);const c=[(n>>16)&255,(n>>8)&255,n&255].map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];}
function ratio(a,b){const [hi,lo]=[lum(a),lum(b)].sort((x,y)=>y-x);return(hi+.05)/(lo+.05);}
test('Neon Aperture dark palette tokens are present',()=>{for(const v of ['--bg:#080d18','--panel:#10182a','--panel2:#17243a','--accent:#00e7f2','--rose:#8b5cf6','--text:#f3f7ff'])assert.ok(style.toLowerCase().includes(v),'missing '+v);});
test('primary button text meets WCAG AA',()=>assert.ok(ratio('#f8fbff','#16758f')>=4.5,'light text on primary teal must be >=4.5:1'));
test('local SVG icons replace remote icon/font dependencies',()=>{assert.ok(!html.includes('lucide.min.js'));assert.ok(!html.includes('fonts.googleapis.com'));assert.ok(html.includes('./mediay-icons.js'));assert.ok(!app.includes('lucide.createIcons'));for(const id of ['image-plus','replace','music','mic','type','captions','layers','check','scissors','skip-back','skip-forward','gauge','volume-2','sliders-horizontal','blend','arrow-left-right','palette','move-horizontal','trash-2','play','arrow-right','plus','film','arrow-up-right'])assert.ok(icons.includes("'"+id+"'"),'missing '+id);});
test('home retains editor actions, library and legal route',()=>{for(const id of ['hmRecent','hmContinue','hmNoProject','hmNew','hmTemplates','hmExport','hmProjectList','hmProjectCount'])assert.ok(setup.includes(id));assert.ok(setup.includes('VIDEO STUDIO'));assert.ok(setup.includes('./favicon.svg'),'setup and home must use the shared SVG logo');assert.ok(setup.includes('Terms, privacy &amp; licenses'));assert.ok(legal.includes('Terms, Privacy and Licenses'));assert.ok(legal.includes('Your media is your responsibility'));});
test('inspector is a single vertical scroller, not nested adjustment panes',()=>{const sheets=[...style.matchAll(/\.sheet\s*\{[^}]*\}/g)];assert.equal(sheets.length,1,'expected one .sheet rule');const a=[...style.matchAll(/\.adjust-grid\s*\{([^}]*)\}/g)].at(-1)?.[1]||'';assert.ok(!/max-height\s*:/.test(a));assert.ok(!/overflow-y\s*:\s*auto/.test(a));assert.ok(setupStyle.includes('#homeScreen { background:var(--bg)'));});
test('service worker precaches local icons with a fresh cache key',()=>{assert.match(sw,/pmy-v26/);assert.ok(sw.includes("'./mediay-icons.js'"));assert.ok(workflow.includes('mediay-icons.js'));});


test('Neon Aperture transition and format selections use dark accent surfaces',()=>{
  const duration=setupStyle.slice(setupStyle.lastIndexOf('.tr-duration {')).split('}')[0];
  const active=setupStyle.slice(setupStyle.lastIndexOf('#trList button.on {')).split('}')[0];
  const ratio=setupStyle.slice(setupStyle.lastIndexOf('.ratios .on {')).split('}')[0];
  assert.ok(duration.includes('background:var(--panel2)'),'transition duration panel must use a light surface');
  assert.ok(duration.includes('border-color:var(--border)'),'transition duration panel must use the studio border');
  assert.ok(active.includes('background:rgba(0,231,242,.13)'),'selected transition must use the subtle cyan state');
  assert.ok(active.includes('color:var(--text)'),'selected transition text must use the studio foreground');
  assert.ok(ratio.includes('background:rgba(0,231,242,.13)'),'selected ratio must use the subtle cyan state');
});

test('Neon Aperture project-library actions keep the studio accent treatment',()=>{
  const newIcon=setupStyle.slice(setupStyle.lastIndexOf('.hm-new .hm-action-icon {')).split('}')[0];
  const openProject=setupStyle.slice(setupStyle.lastIndexOf('.hm-open-project {')).split('}')[0];
  assert.ok(newIcon.includes('background:rgba(0,231,242,.12)'));
  assert.ok(newIcon.includes('color:var(--accent)'));
  assert.ok(openProject.includes('background:linear-gradient(120deg,#00DDEB,#168BFF 55%,#946CF7)'));
  assert.ok(openProject.includes('color:#071321'));
});

test('light editor controls and diagnostics retain WCAG AA foreground contrast',()=>{
  assert.ok(ratio('#17283c','#ffffff')>=4.5,'dark text on white fields must meet WCAG AA');
  assert.ok(ratio('#17283c','#e8f0f5')>=4.5,'dark text on adjustment and diagnostics surfaces must meet WCAG AA');
  assert.ok(ratio('#65304f','#e8f0f5')>=4.5,'adjustment values must meet WCAG AA');
  const finalFix=style.slice(style.lastIndexOf('/* Accessibility hardening:'));
  assert.ok(finalFix.includes('color:#17283C'),'light fields need a dark foreground');
  assert.ok(finalFix.includes('background:#E8F0F5'),'adjustment and diagnostics panels need the tested light surface');
  assert.ok(finalFix.includes('color:#65304F'),'adjustment outputs need the tested readable accent');
});


test('core editor libraries are local, version-pinned and protected by Subresource Integrity',()=>{
  const files=[
    ['./vendor/media-libraries/fabric.min.js','sha256-uwRC1ppNRnMyD2ibxuFsBaDj8WzPv1UfOU2Qp+fPx3I='],
    ['./vendor/media-libraries/anime.min.js','sha256-tc4b48P1MPGS4PJXHRlChGCW1mEZy62jS/3JEsSHPzU='],
    ['./vendor/media-libraries/dexie.min.js','sha256-2JhqFVK0mn2MsIWpLGaYWuvzuzO2Stb3uu0kYdm2R/8=']
  ];
  for(const [src,integrity] of files){
    assert.ok(html.includes('src="'+src+'"'),'missing local library '+src);
    assert.ok(html.includes('integrity="'+integrity+'"'),'missing pinned SRI for '+src);
    assert.ok(sw.includes("'"+src+"'"),'offline shell does not precache '+src);
  }
  assert.doesNotMatch(html,/https:\/\/(?:cdnjs\.cloudflare\.com|unpkg\.com)\/(?:ajax\/libs\/(?:fabric\.js|animejs)|dexie)/);
  assert.match(sw,/pmy-v26/);
  assert.ok(workflow.includes('vendor/media-libraries/fabric.min.js'));
  assert.ok(workflow.includes('vendor/media-libraries/anime.min.js'));
  assert.ok(workflow.includes('vendor/media-libraries/dexie.min.js'));
  assert.ok(workflow.includes('vendor/media-libraries/LICENSES.md'));
});

test('dark text on every neon gradient stop meets WCAG AA',()=>{
  for(const color of ['#00DDEB','#168BFF','#946CF7']) assert.ok(ratio('#071321',color)>=4.5,'dark button text must meet AA on '+color);
  assert.ok(style.includes('linear-gradient(120deg,#00DDEB,#168BFF 58%,#946CF7)'));
  assert.ok(setupStyle.includes('linear-gradient(120deg,#00DDEB,#168BFF 55%,#946CF7)'));
});

test('busy, transition-preview and dark timeline surfaces use readable text colours',()=>{
  assert.ok(style.includes('.busy-cancel { background:var(--rose-soft); border-color:#d7a2b6; color:#ffb9bc; }'));
  assert.ok(style.includes('.tr-preview-empty { color:#17283C; background:rgba(237,246,250,.94); }'));
  assert.ok(style.includes('.clip.video-clip,.clip.audio-clip,.clip.ov-clip,.clip.overlay-clip { color:#F3F7FF; }'));
  assert.ok(ratio('#ffb9bc','#10182a')>=4.5);
  assert.ok(ratio('#17283C','#EDF6FA')>=4.5);
  for(const bg of ['#075B78','#123C75','#402B78','#6636A0','#572A76','#34305B']) assert.ok(ratio('#F3F7FF',bg)>=4.5);
});


test('native MediaStore library requests visual-media access on demand and supports Android 14 partial access',()=>{
  assert.match(html,/id="mediaLibraryDialog"/);
  assert.match(html,/data-media-kind="videos"/);
  assert.match(html,/data-media-kind="images"/);
  assert.match(app,/async function openMediaLibrary\(kind = 'all'\)/);
  assert.match(app,/plugin\.requestMediaAccess\(\{ kind \}\)/);
  assert.match(app,/plugin\.listMedia\(/);
  assert.match(app,/plugin\.stageMedia\(/);
  assert.match(app,/plugin\.deleteStagedMedia\(/);
  assert.match(workflow,/READ_MEDIA_IMAGES/);
  assert.match(workflow,/READ_MEDIA_VIDEO/);
  assert.match(workflow,/READ_MEDIA_VISUAL_USER_SELECTED/);
  assert.match(workflow,/MEDIA_TYPE_IMAGE/);
  assert.match(workflow,/resolver\.loadThumbnail/);
  assert.match(workflow,/registerPlugin\(MediaYMediaStorePlugin\.class\)/);
  assert.match(workflow,/state\.put\("partial", \(images \|\| videos \|\| selected\) && !\(images && videos\)\)/);
  assert.match(setupStyle,/\.media-library-grid/);
});

test('debug APK signing update limitations are documented before testers install updates',()=>{
  const readme=read('README.md');
  assert.match(readme,/runner's generated debug keystore/);
  assert.match(readme,/uninstall the older debug build/);
  assert.match(readme,/removes app-private local projects and imported media/);
});

test('contrast smoke test checks gradient stops and every inspector form control',()=>{
  const smoke=read('test_smoke.py');
  assert.doesNotMatch(smoke,/if \(gradient\) continue/);
  assert.match(smoke,/st\.backgroundImage\.match/);
  assert.match(smoke,/all inspector panes, text form controls and performance diagnostics/);
  assert.match(smoke,/#sheet input:not\(\[type=range\]\)/);
  assert.match(smoke,/assert_range_accent_contrast\(page, '#sheet input\[type=range\]'/);
  assert.match(smoke,/#perfReport/);
  assert.match(style,/#sheet input\[type=range\] \{ accent-color:#00E7F2; \}/);
  assert.match(style,/#sheet \.adjust-control input\[type=range\], #sheet #blendOpacity \{ accent-color:#00647A; \}/);
});
