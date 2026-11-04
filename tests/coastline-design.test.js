const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const style=read('style.css'),setupStyle=read('setup.css'),html=read('index.html'),setup=read('setup.js'),app=read('app.js'),icons=read('mediay-icons.js'),sw=read('sw.js'),legal=read('legal.html'),workflow=read('.github/workflows/built.yml');
function lum(hex){const n=parseInt(hex.slice(1),16);const c=[(n>>16)&255,(n>>8)&255,n&255].map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];}
function ratio(a,b){const [hi,lo]=[lum(a),lum(b)].sort((x,y)=>y-x);return(hi+.05)/(lo+.05);}
test('Neon Aperture dark palette tokens are present',()=>{for(const v of ['--bg:#090d15','--panel:#101722','--panel2:#172231','--accent:#55d6e8','--rose:#a78bfa','--text:#eaf1fa'])assert.ok(style.toLowerCase().includes(v),'missing '+v);});
test('primary button text meets WCAG AA',()=>assert.ok(ratio('#f8fbff','#187f9a')>=4.5,'light text on primary teal must be >=4.5:1'));
test('local SVG icons replace remote icon/font dependencies',()=>{assert.ok(!html.includes('lucide.min.js'));assert.ok(!html.includes('fonts.googleapis.com'));assert.ok(html.includes('./mediay-icons.js'));assert.ok(!app.includes('lucide.createIcons'));for(const id of ['image-plus','replace','music','mic','type','captions','layers','check','scissors','skip-back','skip-forward','gauge','volume-2','sliders-horizontal','blend','arrow-left-right','palette','move-horizontal','trash-2','play','arrow-right','plus','film','arrow-up-right'])assert.ok(icons.includes("'"+id+"'"),'missing '+id);});
test('home retains editor actions, library and legal route',()=>{for(const id of ['hmRecent','hmContinue','hmNoProject','hmNew','hmTemplates','hmExport','hmProjectList','hmProjectCount'])assert.ok(setup.includes(id));assert.ok(setup.includes('VIDEO STUDIO'));assert.ok(setup.includes('Terms, privacy &amp; licenses'));assert.ok(legal.includes('Terms, Privacy and Licenses'));assert.ok(legal.includes('Your media is your responsibility'));});
test('inspector is a single vertical scroller, not nested adjustment panes',()=>{const sheets=[...style.matchAll(/\.sheet\s*\{[^}]*\}/g)];assert.equal(sheets.length,1,'expected one .sheet rule');const a=[...style.matchAll(/\.adjust-grid\s*\{([^}]*)\}/g)].at(-1)?.[1]||'';assert.ok(!/max-height\s*:/.test(a));assert.ok(!/overflow-y\s*:\s*auto/.test(a));assert.ok(setupStyle.includes('#homeScreen { background:var(--bg)'));});
test('service worker precaches local icons with a fresh cache key',()=>{assert.match(sw,/pmy-v25/);assert.ok(sw.includes("'./mediay-icons.js'"));assert.ok(workflow.includes('mediay-icons.js'));});


test('Neon Aperture transition and format selections use dark accent surfaces',()=>{
  const duration=setupStyle.slice(setupStyle.lastIndexOf('.tr-duration {')).split('}')[0];
  const active=setupStyle.slice(setupStyle.lastIndexOf('#trList button.on {')).split('}')[0];
  const ratio=setupStyle.slice(setupStyle.lastIndexOf('.ratios .on {')).split('}')[0];
  assert.ok(duration.includes('background:var(--panel2)'),'transition duration panel must use a light surface');
  assert.ok(duration.includes('border-color:var(--border)'),'transition duration panel must use the studio border');
  assert.ok(active.includes('background:rgba(85,214,232,.13)'),'selected transition must use the subtle cyan state');
  assert.ok(active.includes('color:var(--text)'),'selected transition text must use the studio foreground');
  assert.ok(ratio.includes('background:rgba(85,214,232,.13)'),'selected ratio must use the subtle cyan state');
});

test('Neon Aperture project-library actions keep the studio accent treatment',()=>{
  const newIcon=setupStyle.slice(setupStyle.lastIndexOf('.hm-new .hm-action-icon {')).split('}')[0];
  const openProject=setupStyle.slice(setupStyle.lastIndexOf('.hm-open-project {')).split('}')[0];
  assert.ok(newIcon.includes('background:rgba(85,214,232,.12)'));
  assert.ok(newIcon.includes('color:var(--accent)'));
  assert.ok(openProject.includes('background:linear-gradient(110deg,#187F9A,#6554B8)'));
  assert.ok(openProject.includes('color:#F8FBFF'));
});
