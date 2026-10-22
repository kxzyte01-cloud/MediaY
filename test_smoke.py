from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent
html=(root/'index.html').read_text()
# FFmpeg is covered by a real-origin integration test; stub the vendored script in this DOM-only smoke test.
html=html.replace('<script src="./vendor/ffmpeg/ffmpeg.js"></script>', '<script>window.FFmpegWASM={};</script>')
style=(root/'style.css').read_text()
setup_style=(root/'setup.css').read_text()
app=(root/'app.js').read_text()
setup=(root/'setup.js').read_text()
FABRIC_STUB = r'''window.fabric = (function(){
  class Obj { constructor(el, props={}) { this.el=el; this.width=(el&&el.width)||100; this.height=(el&&el.height)||100; this.left=0; this.top=0; this.scaleX=1; this.scaleY=1; this.visible=true; this.opacity=1; this.props=props; }
    set(p){Object.assign(this,p); return this;} getScaledWidth(){return this.width*(this.scaleX||1)} getScaledHeight(){return this.height*(this.scaleY||1)}
    getBoundingRect(){return {left:this.left||0,top:this.top||0,width:this.getScaledWidth(),height:this.getScaledHeight()}} applyFilters(){}
  }
  class Canvas { constructor(el){this.el=el;this.wrapperEl={style:{}};this._objects=[];this.active=null;}
    on(){} setDimensions(){} clear(){this._objects=[];this.active=null;} requestRenderAll(){} add(o){this._objects.push(o)} remove(o){this._objects=this._objects.filter(x=>x!==o)} getObjects(){return this._objects}
    getActiveObject(){return this.active} setActiveObject(o){this.active=o} discardActiveObject(){this.active=null} calcOffset(){}
  }
  class Textbox extends Obj {constructor(text,p={}){super(null,p);this.text=text;this.width=p.width||100;this.height=50;}}
  class Image extends Obj {constructor(el,p={}){super(el,p);}}
  Image.filters={RemoveColor:class{constructor(o){Object.assign(this,o)}}};
  return {Canvas,Textbox,Image,Shadow:class{constructor(o){Object.assign(this,o)}}};
})();'''
ANIME_STUB = r'''window.anime = function(o){if(o&&o.targets&&Array.isArray(o.targets)){Object.assign(o.targets[0],{opacity:1}); if(o.update)o.update();} return {};};'''
DEXIE_STUB = r'''window.Dexie = class Dexie {
 constructor(){ const maps={projects:new Map(),media:new Map()}; this.projects={get:async k=>maps.projects.get(k)||null,put:async v=>{maps.projects.set(v.id,structuredClone(v));return v.id},toArray:async()=>Array.from(maps.projects.values()).map(x=>structuredClone(x)),delete:async k=>maps.projects.delete(k)}; this.media={get:async k=>maps.media.get(k)||null,put:async v=>{maps.media.set(v.id,v);return v.id}}; }
 version(){return {stores:()=>this};}
};'''
LUCIDE_STUB = r'''window.lucide={createIcons:function(){}};'''
# Build an all-inline version; no network or local file URL is needed for the smoke test.
html=html.replace('<link rel="manifest" href="./manifest.json">','')
html=html.replace('<link rel="icon" href="./favicon.svg" type="image/svg+xml">','')
html=html.replace('<link rel="apple-touch-icon" href="./icon-192.png">','')
html=html.replace('<link rel="stylesheet" href="./style.css">', '<style>'+style+'</style>')
html=html.replace('<link rel="stylesheet" href="./setup.css">', '<style>'+setup_style+'</style>')
for x in ['<link rel="preconnect" href="https://fonts.googleapis.com">','<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">']:
    html=html.replace(x,'')
html=html.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js"></script>', '<script>'+FABRIC_STUB+'</script>')
html=html.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js"></script>', '<script>'+ANIME_STUB+'</script>')
html=html.replace('<script src="https://unpkg.com/dexie@3.2.7/dist/dexie.min.js"></script>', '<script>'+DEXIE_STUB+'</script>')
html=html.replace('<script src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js"></script>', '<script>'+LUCIDE_STUB+'</script>')
html=html.replace('<script src="./app.js"></script>', '<script>'+app+'</script>')
html=html.replace('<script src="./setup.js"></script>', '<script>'+setup+'</script>')
html=html.replace('<script>'+app+'</script>', '<script>try{localStorage.setItem("pmy-consent-v1","yes")}catch(e){}</script><script>'+app+'</script>')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    context=browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    page=context.new_page(); errors=[]; page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content(html, wait_until='domcontentloaded')
    page.wait_for_selector('#homeScreen:not([hidden])',timeout=10000)
    if page.locator('#consentDialog[open]').count(): page.locator('#consentBtn').click()
    print('PASS: home screen appears on startup')
    page.locator('#hmNew').click(); page.wait_for_selector('#setup:not([hidden])')
    print('PASS: New project opens setup screen')
    page.locator('#suStart').click(); page.wait_for_function("document.querySelector('#homeScreen').hidden === true")
    print('PASS: Start editing closes home/setup and opens editor')
    assert page.locator('#tlZoom').count() == 1, 'timeline zoom slider is missing'
    assert page.locator('#copyTillBtn').count() == 1, 'Copy till here control is missing'
    assert page.locator('#adjustBtn').count() == 1, 'Adjust control is missing'
    assert page.locator('#blendBtn').count() == 1, 'Blending control is missing'
    transition_count = page.locator('#trList button').count()
    assert transition_count == 59, f'expected None plus 58 FFmpeg transitions, found {transition_count}'
    old_zoom = page.evaluate('PX')
    page.locator('#tlZoomIn').click()
    assert page.evaluate('PX') == min(90, old_zoom + 6), 'timeline zoom-in control did not change scale'
    page.locator('#tlZoomFit').click()
    print('PASS: timeline zoom controls work and all 58 built-in transitions are offered')
    page.evaluate("""() => {
      S.main.push({id:'adjust-test-a', mediaId:'missing-adjust-a', name:'adjust-a.mp4', in:0, out:5, src:5});
      S.main.push({id:'adjust-test-b', mediaId:'missing-adjust-b', name:'adjust-b.mp4', in:0, out:5, src:5});
      select('adjust-test-a','main');
    }""")
    page.locator('#adjustBtn').click()
    page.locator('[data-adjust="brightness"]').evaluate("(e)=>{e.value='24';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}")
    page.locator('#adjustApplyAll').click()
    adjust_result = page.evaluate("({a:S.main[0].adjust,b:S.main[1].adjust,filter:adjustmentFilter(S.main[0])})")
    assert adjust_result['a']['brightness'] == 24 and adjust_result['b']['brightness'] == 24, adjust_result
    assert 'eq=brightness=0.120' in adjust_result['filter'], adjust_result
    assert 'fade=type=in:duration=' not in adjust_result['filter'], adjust_result
    page.evaluate("S.main=[]; select(null); drawTimeline(); refresh(0);")
    print('PASS: Adjust sliders and Apply to all copy valid export settings to every video clip')
    page.locator('#homeBtn').click(); page.wait_for_selector('#homeScreen:not([hidden])')
    print('PASS: Home button returns to dashboard')
    page.locator('#hmNew').click(); page.locator('#suStart').click(); page.wait_for_function("document.querySelector('#homeScreen').hidden === true")
    page.evaluate("S.overlays.push({id:'test-overlay', type:'text', text:'TEST', style:0, name:'TEST', layer:1, start:0, dur:3, left:10, top:10, scaleX:1, scaleY:1}); drawTimeline();")
    hidden=page.locator('#emptyState').evaluate('(e)=>e.hidden')
    assert hidden, 'empty-state overlay is still visible when an overlay exists'
    print('PASS: empty-state panel stays hidden once an overlay exists')
    page.evaluate("""() => {
      S.overlays.push({id:'blend-test-a', type:'image', mediaId:'missing-blend-a', name:'blend-a.png', start:0, dur:3, layer:2, left:10, top:10, scaleX:1, scaleY:1});
      S.overlays.push({id:'blend-test-b', type:'image', mediaId:'missing-blend-b', name:'blend-b.png', start:0, dur:3, layer:3, left:20, top:20, scaleX:1, scaleY:1});
      select('blend-test-a','overlay');
    }""")
    page.locator('#blendBtn').click()
    page.locator('#blendModes [data-blend="multiply"]').click()
    page.locator('#blendOpacity').evaluate("(e)=>{e.value='55';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}")
    page.locator('#blendApplyAll').click()
    blend_result = page.evaluate("({a:S.overlays.find(o=>o.id==='blend-test-a'),b:S.overlays.find(o=>o.id==='blend-test-b')})")
    assert blend_result['a']['blend'] == 'multiply' and blend_result['b']['blend'] == 'multiply', blend_result
    assert abs(blend_result['a']['opacity'] - .55) < .001 and abs(blend_result['b']['opacity'] - .55) < .001, blend_result
    page.evaluate("select(null); drawTimeline();")
    print('PASS: blending mode and opacity apply to all overlay layers')
    image_result = page.evaluate("""async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f01925'; ctx.fillRect(0, 0, 2, 2);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const id = 'overlay-image-recovery-test';
      const file = new File([png], 'overlay-test.png', {type:'image/png'});
      await db.media.put({id, name:file.name, type:file.type, blob:file});
      files[id] = file;
      // Simulate a stale/broken object URL while the original bytes remain in IndexedDB.
      const recovered = await loadOverlayImage('data:image/png;base64,not-a-valid-image', {id:'overlay', mediaId:id, name:file.name});
      const stored = await db.media.get(id);
      const ok = recovered.width === 2 && recovered.height === 2 && stored.type === 'image/png';
      if (urls[id] && urls[id].startsWith('blob:')) URL.revokeObjectURL(urls[id]);
      return {ok, width:recovered.width, height:recovered.height, storedType:stored.type};
    }""")
    assert image_result['ok'], image_result
    print('PASS: template overlay image can recover from a broken preview URL')
    page.evaluate("S.main.push({id:'test-video', mediaId:'missing-media', name:'Smoke test video.mp4', in:0, out:5, src:5}); t=7; select('test-video','main');")
    copy_result = page.evaluate("""async () => {
      await copyTillPlayhead();
      return {count:S.main.length, duration:total(), selected:sel && sel.id, enabled:!$('copyTillBtn').disabled};
    }""")
    assert copy_result['count'] == 2, copy_result
    assert abs(copy_result['duration'] - 7) < 0.01, copy_result
    assert copy_result['selected'] != 'test-video' and not copy_result['enabled'], copy_result
    print('PASS: Copy till here duplicates a clip up to the playhead')
    def handle_dialog(d): d.accept('Smoke test project')
    page.on('dialog',handle_dialog)
    page.locator('#saveBtn').click(); page.wait_for_timeout(100)
    page.locator('#homeBtn').click(); page.wait_for_selector('#homeScreen:not([hidden])'); page.wait_for_timeout(100)
    saved = page.locator('#hmProjectTitle').inner_text()
    assert 'Smoke test project' in saved, saved
    print('PASS: Save creates a named project visible as the recent project')
    page.locator('#hmNew').click(); page.wait_for_selector('#setup:not([hidden])')
    page.locator('#suStart').click(); page.locator('#homeBtn').click(); page.wait_for_selector('#homeScreen:not([hidden])')
    library = page.locator('#hmProjectList').inner_text()
    assert 'Smoke test project' in library, library
    print('PASS: Starting a new project preserves the previously saved project')
    print('Page errors:', errors)
    assert not errors, errors
    browser.close()
