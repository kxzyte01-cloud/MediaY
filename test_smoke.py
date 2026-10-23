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
    page.locator('#sheetClose').click()
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
    # Regression coverage for the playhead trim actions across the main, audio, and overlay lanes.
    page.evaluate("""() => {
      S.main = [
        {id:'trim-main-start', mediaId:'missing-trim-a', name:'trim-a.mp4', in:0.5, out:8, src:8, speed:2},
        {id:'trim-main-next', mediaId:'missing-trim-b', name:'trim-b.mp4', in:0, out:5, src:5, speed:1}
      ];
      S.audio = [{id:'trim-audio-start', mediaId:'missing-audio', name:'trim-audio.mp3', in:0, out:8, src:8, start:4}];
      S.overlays = [{id:'trim-overlay', type:'text', text:'T', name:'trim-overlay', start:2, dur:6, layer:1}];
      sel = {id:'trim-main-start', lane:'main'}; t = 1.25; undoStack = [snap()]; redoStack = []; drawTimeline(); refresh(t); updateChrome();
    }""")
    # Let queued browser scroll events run; refresh-driven scrolling must never move the playhead.
    page.wait_for_timeout(75)
    playhead_after_refresh = page.evaluate("t")
    assert abs(playhead_after_refresh - 1.25) < 0.001, playhead_after_refresh
    assert not page.locator('#trimStartBtn').is_disabled(), 'From here should enable when playhead is inside a selected clip'
    page.locator('#trimStartBtn').click()
    main_start = page.evaluate("({in:S.main[0].in, out:S.main[0].out, speed:S.main[0].speed, t, duration:dur(S.main[0])})")
    assert abs(main_start['in'] - 3.0) < 0.001, main_start
    assert abs(main_start['duration'] - 2.5) < 0.001, main_start
    assert abs(main_start['t']) < 0.001, main_start
    print('PASS: From here trims source time correctly for a speed-adjusted main clip')
    page.locator('#undoBtn').click()
    page.wait_for_function("S.main[0].in === 0.5")
    assert abs(page.evaluate("S.main[0].out") - 8) < 0.001, 'undo should restore the complete original trim range'
    page.locator('#redoBtn').click()
    page.wait_for_function("S.main[0].in === 3")
    assert abs(page.evaluate("dur(S.main[0])") - 2.5) < 0.001, 'redo should restore the trimmed source range'
    print('PASS: From here trim participates correctly in Undo and Redo')

    page.evaluate("""() => {
      S.main = [{id:'trim-main-end', mediaId:'missing-trim-c', name:'trim-c.mp4', in:0, out:8, src:8, speed:1}];
      sel = {id:'trim-main-end', lane:'main'}; t = 3; drawTimeline(); refresh(t); updateChrome();
    }""")
    page.locator('#trimEndBtn').click()
    main_end = page.evaluate("({out:S.main[0].out, duration:dur(S.main[0])})")
    assert abs(main_end['out'] - 3) < 0.001 and abs(main_end['duration'] - 3) < 0.001, main_end
    print('PASS: To here trims the main clip ending at the playhead')

    page.evaluate("""() => {
      S.main = [{id:'timeline-support-audio', mediaId:'missing-support-audio', name:'support.mp4', in:0, out:20, src:20, speed:1}]; sel = {id:'trim-audio-start', lane:'audio'}; t = 6; drawTimeline(); refresh(t); updateChrome();
    }""")
    page.locator('#trimStartBtn').click()
    audio_start = page.evaluate("({in:S.audio[0].in, out:S.audio[0].out, start:S.audio[0].start})")
    assert abs(audio_start['in'] - 2) < 0.001 and abs(audio_start['start'] - 6) < 0.001, audio_start
    print('PASS: From here trims audio source and moves its timeline start together')

    page.evaluate("""() => {
      S.audio = [{id:'trim-audio-end', mediaId:'missing-audio-end', name:'end.mp3', in:0, out:8, src:8, start:1}];
      S.main = [{id:'timeline-support-audio-end', mediaId:'missing-support-audio-end', name:'support-end.mp4', in:0, out:20, src:20, speed:1}]; sel = {id:'trim-audio-end', lane:'audio'}; t = 4; drawTimeline(); refresh(t); updateChrome();
    }""")
    page.locator('#trimEndBtn').click()
    audio_end = page.evaluate("({out:S.audio[0].out, start:S.audio[0].start})")
    assert abs(audio_end['out'] - 3) < 0.001 and abs(audio_end['start'] - 1) < 0.001, audio_end
    print('PASS: To here trims an audio clip without shifting its timeline start')

    page.evaluate("""() => {
      S.main = [{id:'timeline-support-overlay', mediaId:'missing-support-overlay', name:'support-overlay.mp4', in:0, out:20, src:20, speed:1}]; sel = {id:'trim-overlay', lane:'overlay'}; t = 4; drawTimeline(); refresh(t); updateChrome();
    }""")
    page.locator('#trimStartBtn').click()
    overlay_start = page.evaluate("({start:S.overlays[0].start, dur:S.overlays[0].dur})")
    assert abs(overlay_start['start'] - 4) < 0.001 and abs(overlay_start['dur'] - 4) < 0.001, overlay_start
    page.evaluate("t = 5; refresh(t); updateChrome();")
    page.locator('#trimEndBtn').click()
    overlay_end = page.evaluate("({start:S.overlays[0].start, dur:S.overlays[0].dur})")
    assert abs(overlay_end['start'] - 4) < 0.001 and abs(overlay_end['dur'] - 1) < 0.001, overlay_end
    print('PASS: From here and To here trim overlay timing and duration correctly')

    page.evaluate("""() => {
      S.main = [{id:'timeline-support-video-overlay', mediaId:'missing-support-video-overlay', name:'support-video-overlay.mp4', in:0, out:20, src:20, speed:1}];
      S.overlays = [{
        id:'trim-overlay-video', type:'video', mediaId:'missing-video-overlay',
        name:'picture-in-picture.mp4', start:2, dur:6, sourceIn:1, srcDur:10, layer:1,
        el:{currentTime:0, paused:true, play:()=>Promise.resolve(), pause:()=>{}}
      }];
      canvas.clear(); canvas.add({pmId:'trim-overlay-video', layer:1, visible:true});
      sel = {id:'trim-overlay-video', lane:'overlay'}; t = 4; drawTimeline(); refresh(t); updateChrome();
    }""")
    page.wait_for_timeout(40)
    assert not page.locator('#trimStartBtn').is_disabled(), 'video overlay From here should enable inside its source range'
    page.locator('#trimStartBtn').click()
    video_overlay_start = page.evaluate("({start:S.overlays[0].start,dur:S.overlays[0].dur,sourceIn:S.overlays[0].sourceIn,previewTime:S.overlays[0].el.currentTime})")
    assert abs(video_overlay_start['start'] - 4) < 0.001 and abs(video_overlay_start['dur'] - 4) < 0.001, video_overlay_start
    assert abs(video_overlay_start['sourceIn'] - 3) < 0.001 and abs(video_overlay_start['previewTime'] - 3) < 0.001, video_overlay_start
    assert abs(page.evaluate("overlaySourceAt({sourceIn:3,start:4},6)") - 5) < 0.001, 'export video source mapping should account for prior source trim'
    assert abs(page.evaluate("overlaySourceAt({sourceIn:3,start:8},6)") - 3) < 0.001, 'export seek before overlay start should preserve its trimmed source-in'
    page.evaluate("t = 5; refresh(t); updateChrome();")
    page.wait_for_timeout(40)
    page.locator('#trimEndBtn').click()
    video_overlay_end = page.evaluate("({start:S.overlays[0].start,dur:S.overlays[0].dur,sourceIn:S.overlays[0].sourceIn})")
    assert abs(video_overlay_end['start'] - 4) < 0.001 and abs(video_overlay_end['dur'] - 1) < 0.001, video_overlay_end
    assert abs(video_overlay_end['sourceIn'] - 3) < 0.001, video_overlay_end
    print('PASS: video overlay trimming preserves source-in across preview, export seek, and audio mixing')

    page.evaluate("""() => {
      S.main = [{id:'trim-one-frame', mediaId:'missing-one-frame', name:'one-frame.mp4', in:0, out:1, src:1, speed:1}];
      sel = {id:'trim-one-frame', lane:'main'}; t = 1/30; drawTimeline(); refresh(t); updateChrome();
    }""")
    page.wait_for_timeout(75)
    assert not page.locator('#trimStartBtn').is_disabled(), 'trim should allow frame-accurate edits, not require a 0.2 second margin'
    page.locator('#trimStartBtn').click()
    one_frame = page.evaluate("({in:S.main[0].in,duration:dur(S.main[0])})")
    assert abs(one_frame['in'] - (1/30)) < 0.0001, one_frame
    assert abs(one_frame['duration'] - (29/30)) < 0.0001, one_frame
    print('PASS: trim precision supports a one-frame edit at 30 fps')

    page.evaluate("""() => {
      S.main = [{id:'trim-boundary', mediaId:'missing-boundary', name:'boundary.mp4', in:0, out:5, src:5}];
      sel = {id:'trim-boundary', lane:'main'}; t = 0; drawTimeline(); refresh(t); updateChrome();
    }""")
    assert page.locator('#trimStartBtn').is_disabled(), 'From here should disable at the clip boundary'
    assert page.locator('#trimEndBtn').is_disabled(), 'To here should disable at the clip boundary'
    page.evaluate("trimSelectionAtPlayhead('start')")
    boundary = page.evaluate("({in:S.main[0].in,out:S.main[0].out})")
    assert boundary == {'in':0,'out':5}, boundary
    print('PASS: trim buttons reject boundary positions that would create zero-length clips')

    # Fast draft is an explicit quality/speed trade-off and must update both export controls.
    draft_settings = page.evaluate("""() => {
      const old = {res:EXP.res, fps:EXP.fps};
      applyExportPreset('draft');
      const chosen = {
        res:EXP.res, fps:EXP.fps,
        resSelected:[...$('resList').children].some(b => +b.dataset.v === 480 && b.classList.contains('on')),
        fpsSelected:[...$('fpsList').children].some(b => +b.dataset.v === 24 && b.classList.contains('on'))
      };
      EXP.res = old.res; EXP.fps = old.fps;
      for (const b of $('resList').children) b.classList.toggle('on', +b.dataset.v === EXP.res);
      for (const b of $('fpsList').children) b.classList.toggle('on', +b.dataset.v === EXP.fps);
      return chosen;
    }""")
    assert draft_settings == {'res':480,'fps':24,'resSelected':True,'fpsSelected':True}, draft_settings
    print('PASS: Fast draft preset switches both resolution and frame rate together')

    caption_chunks = page.evaluate("""async () => {
      const oldAsr = asr, oldCancel = captionCancelRequested;
      const oldLang = $('capLang').value, oldTranslate = $('capTr').checked;
      const sizes = [], progress = [];
      asr = async (pcm, options) => {
        sizes.push(pcm.length);
        return {chunks:[{text:'alpha beta gamma delta', timestamp:[0,1]}]};
      };
      captionCancelRequested = false;
      try {
        const drafts = await captionFrom(
          new Float32Array(CAPTION_SAMPLE_RATE * 61),
          {start:5, in:0, out:61, sp:2, label:'test media'},
          p => progress.push(p.percent)
        );
        return {
          sizes, count:drafts.length,
          starts:drafts.map(x => x.start),
          durations:drafts.map(x => x.dur),
          progress
        };
      } finally {
        asr = oldAsr; captionCancelRequested = oldCancel;
        $('capLang').value = oldLang; $('capTr').checked = oldTranslate;
      }
    }""")
    assert caption_chunks['sizes'] == [30*16000,30*16000,16000], caption_chunks
    assert caption_chunks['count'] == 3, caption_chunks
    assert all(abs(a-b) < 0.001 for a,b in zip(caption_chunks['starts'],[5,20,35])), caption_chunks
    assert all(abs(d-.5) < 0.001 for d in caption_chunks['durations']), caption_chunks
    assert caption_chunks['progress'] == [1/3,2/3,1], caption_chunks
    print('PASS: auto captions stream 30-second inference chunks with correct source-time offsets and progress')

    caption_cancel = page.evaluate("""async () => {
      const oldAsr = asr, oldCancel = captionCancelRequested;
      const before = {overlays:S.overlays.length, nextLayer:S.nextLayer};
      asr = async () => {
        captionCancelRequested = true;
        return {chunks:[{text:'should never be committed',timestamp:[0,1]}]};
      };
      captionCancelRequested = false;
      let name = '';
      try {
        await captionFrom(new Float32Array(CAPTION_SAMPLE_RATE*30), {start:0,in:0,out:30,sp:1,label:'test'}, () => {});
      } catch (error) { name = error.name; }
      finally { asr = oldAsr; captionCancelRequested = oldCancel; }
      return {name, before, after:{overlays:S.overlays.length,nextLayer:S.nextLayer}};
    }""")
    assert caption_cancel['name'] == 'AbortError', caption_cancel
    assert caption_cancel['before'] == caption_cancel['after'], caption_cancel
    print('PASS: cancelling caption inference discards uncommitted caption drafts')

    signal_checks = page.evaluate("""() => {
      const silent = new Float32Array(16000 * 2);
      const speechLike = new Float32Array(16000);
      for (let i=0;i<speechLike.length;i++) speechLike[i]=0.08*Math.sin(i*0.1);
      return {silent:hasAudibleSignal(silent), speech:hasAudibleSignal(speechLike)};
    }""")
    assert signal_checks == {'silent':False,'speech':True}, signal_checks

    print('PASS: silent tracks are skipped before running speech inference')

    export_metrics = page.evaluate("""async () => {
      const before = {
        session: exportSession, last: lastExportPerformance, ff,
        buttonHidden: $('exportTimingBtn').hidden,
        detailsHidden: $('exportTimingDetails').hidden,
        detailsText: $('exportTimingDetails').textContent
      };
      try {
        beginExportTelemetry(999);
        enterExportPhase('Synthetic encode stage');
        exportSession.counters.sourceCacheHits = 2;
        exportSession.counters.sourceCacheMisses = 1;
        exportSession.counters.overlayPngCacheHits = 3;
        exportSession.counters.overlayPngCacheMisses = 1;
        exportSession.counters.bytesStaged = 1024 * 1024;
        exportSession.counters.encodeAttempts = 1;
        exportSession.clips.push({index:1,name:'fixture.mp4',sourceDuration:3,ms:1250});
        const realFF = ff;
        ff = {loaded:true,exec:async args => 0};
        await run(['-f','null','synthetic-output.mp4']);
        ff = realFF;
        exportSession.status = 'Completed';
        const status = finishExportTelemetry();
        return {
          status, report:$('exportTimingDetails').textContent,
          shown:!$('exportTimingBtn').hidden,
          commandRecorded:!!lastExportPerformance && lastExportPerformance.report.includes('synthetic-output.mp4'),
          clipRecorded:lastExportPerformance.clips ? lastExportPerformance.clips.length : null
        };
      } finally {
        ff = before.ff;
        exportSession = before.session;
        lastExportPerformance = before.last;
        $('exportTimingBtn').hidden = before.buttonHidden;
        $('exportTimingDetails').hidden = before.detailsHidden;
        $('exportTimingDetails').textContent = before.detailsText;
      }
    }""")
    assert export_metrics['status'] == 'Completed', export_metrics
    assert export_metrics['shown'], export_metrics
    assert 'Total elapsed:' in export_metrics['report'], export_metrics
    assert 'Synthetic encode stage' in export_metrics['report'], export_metrics
    assert 'Source cache hits/misses: 2/1' in export_metrics['report'], export_metrics
    assert export_metrics['commandRecorded'], export_metrics
    print('PASS: export timing report records stages, cache metrics, clip costs, and FFmpeg commands')

    cancellation_test = page.evaluate("""() => {
      const originalDispose = disposeFFmpeg;
      const originalRunning = exportRunning, originalCancelled = exportCancelRequested;
      const originalButton = {
        hidden:$('busyCancelExport').hidden,
        disabled:$('busyCancelExport').disabled,
        text:$('busyCancelExport').textContent
      };
      let disposeCalls = 0;
      try {
        disposeFFmpeg = () => { disposeCalls++; };
        exportRunning = true;
        exportCancelRequested = false;
        $('busyCancelExport').hidden = false;
        $('busyCancelExport').disabled = false;
        requestExportCancellation();
        return {
          requested:exportCancelRequested,
          disposeCalls,
          disabled:$('busyCancelExport').disabled,
          text:$('busyCancelExport').textContent
        };
      } finally {
        disposeFFmpeg = originalDispose;
        exportRunning = originalRunning;
        exportCancelRequested = originalCancelled;
        $('busyCancelExport').hidden = originalButton.hidden;
        $('busyCancelExport').disabled = originalButton.disabled;
        $('busyCancelExport').textContent = originalButton.text;
        hideBusy();
      }
    }""")
    assert cancellation_test == {
      'requested':True,'disposeCalls':1,'disabled':True,'text':'Cancelling…'
    }, cancellation_test
    print('PASS: export cancellation immediately terminates the worker and prevents repeat cancellation clicks')

    caption_metrics = page.evaluate("""() => {
      const before = {
        session:captionPerformanceSession, last:lastCaptionPerformance,
        btnHidden:$('captionTimingBtn').hidden,
        detailHidden:$('captionTimingDetails').hidden,
        detailText:$('captionTimingDetails').textContent
      };
      try {
        beginCaptionTelemetry();
        enterCaptionPhase('Synthetic audio decode');
        recordCaptionSource('fixture speech.wav', 250, 16000*60, 'decoded');
        enterCaptionPhase('Synthetic inference');
        recordCaptionChunk('fixture speech.wav', {chunkIndex:0,chunkCount:2,ms:1300,pcmSeconds:30});
        captionPerformanceSession.status = 'Completed';
        const status = finishCaptionTelemetry('Completed');
        return {
          status, report:$('captionTimingDetails').textContent,
          shown:!$('captionTimingBtn').hidden,
          hasChunk:lastCaptionPerformance.chunks.length === 1
        };
      } finally {
        captionPerformanceSession = before.session;
        lastCaptionPerformance = before.last;
        $('captionTimingBtn').hidden = before.btnHidden;
        $('captionTimingDetails').hidden = before.detailHidden;
        $('captionTimingDetails').textContent = before.detailText;
      }
    }""")
    assert caption_metrics['status'] == 'Completed', caption_metrics
    assert caption_metrics['shown'] and caption_metrics['hasChunk'], caption_metrics
    assert 'Synthetic audio decode' in caption_metrics['report'], caption_metrics
    assert 'Synthetic inference' in caption_metrics['report'], caption_metrics
    assert 'fixture speech.wav' in caption_metrics['report'], caption_metrics
    print('PASS: caption timing report separates source decode from inference and reports slow chunks')

    caption_cancel_ui = page.evaluate("""() => {
      const originalRunning = captionRunning, originalCancelled = captionCancelRequested;
      const originals = ['capCancelBtn','busyCancelCaption'].map(id => {
        const b=$(id); return {id,hidden:b.hidden,disabled:b.disabled,text:b.textContent};
      });
      try {
        captionRunning=true;
        captionCancelRequested=false;
        $('capCancelBtn').hidden=false;
        $('busyCancelCaption').hidden=false;
        $('busyCancelCaption').disabled=false;
        requestCaptionCancellation();
        return {
          requested:captionCancelRequested,
          busyButtonDisabled:$('busyCancelCaption').disabled,
          busyButtonText:$('busyCancelCaption').textContent,
          sheetButtonDisabled:$('capCancelBtn').disabled
        };
      } finally {
        captionRunning=originalRunning;
        captionCancelRequested=originalCancelled;
        originals.forEach(x => { const b=$(x.id); b.hidden=x.hidden; b.disabled=x.disabled; b.textContent=x.text; });
        hideBusy();
      }
    }""")
    assert caption_cancel_ui == {
      'requested':True,
      'busyButtonDisabled':True,
      'busyButtonText':'Cancelling after current step…',
      'sheetButtonDisabled':True
    }, caption_cancel_ui
    print('PASS: caption cancel remains accessible in the blocking busy dialog')
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
