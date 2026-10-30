// ==UserScript==
// @name         K-Manga Overlay Translator (Personal V2)
// @namespace    https://example.invalid/kmanga-personal
// @version      2.0.0
// @description  在 Safari 韓漫網頁上把韓文翻成繁體中文並覆蓋對話位置（OCR/Gemini）
// @match        https://bomtoon.com/*
// @match        https://*.bomtoon.com/*
// @match        https://ridibooks.com/*
// @match        https://*.ridibooks.com/*
// @match        https://ridi.com/*
// @match        https://*.ridi.com/*
// @match        https://lezhin.com/*
// @match        https://*.lezhin.com/*
// @match        https://*.github.io/*
// @match        http://localhost/*
// @run-at       document-idle
// @noframes
// @inject-into  content
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// ==/UserScript==

/* global GM, Tesseract */
(() => {
  'use strict';
  if (window.__kmangaOverlayV2) return;
  window.__kmangaOverlayV2 = true;

  const STORAGE = 'kmanga_v2_';
  const MODEL_OPTIONS = ['gemini-2.5-flash','gemini-2.5-flash-lite'];
  const state = { workerUrl:'', accessToken:'', mode:'ocr', model:MODEL_OPTIONS[0], glossary:'',
    selecting:false, busy:false, worker:null, overlays:[], boxesHidden:false, stats:{requests:0,input:0,output:0,total:0}, cacheIndex:[] };
  const host = document.createElement('div');
  host.id = 'kmanga-translator-host';
  host.style.cssText = 'position:fixed!important;bottom:calc(18px + env(safe-area-inset-bottom))!important;right:12px!important;z-index:2147483647!important;pointer-events:auto!important;';
  const shadow = host.attachShadow({ mode:'open' });
  shadow.innerHTML = `<style>
    *,*:before,*:after {box-sizing:border-box} .mini {border:0;border-radius:999px;color:white;background:#3449c4;font:600 14px -apple-system,system-ui,sans-serif;box-shadow:0 5px 22px #0005;padding:12px 16px;cursor:pointer}
    .panel {width:min(350px,calc(100vw - 24px));max-height:min(75vh,660px);overflow:auto;background:#fff;color:#15151a;border-radius:16px;padding:14px;box-shadow:0 14px 55px #0006;font:14px -apple-system,BlinkMacSystemFont,'PingFang TC',sans-serif}
    .hidden {display:none!important} header {display:flex;align-items:center;justify-content:space-between;margin-bottom:10px} strong{font-size:16px}
    label{font-size:12px;color:#424653;display:block;margin:9px 0 4px} input,select,textarea{width:100%;border:1px solid #cbd0d9;border-radius:8px;background:#fff;color:#111;font:14px system-ui;padding:8px} textarea{min-height:44px;resize:vertical}
    .buttons{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px}.btn{border:0;border-radius:9px;min-height:39px;padding:8px;color:#fff;background:#3449c4;font-weight:600;cursor:pointer}
    .gray{background:#677188}.danger{background:#8b4343}.muted{font-size:11px;line-height:1.5;color:#667085;margin-top:8px}
    .status{font-size:12px;line-height:1.55;background:#f0f2f8;padding:9px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
    .topbutton{border:0;background:#edf0fa;border-radius:8px;padding:6px 9px;color:#263967;cursor:pointer}
  </style>
  <button class="mini" id="float" type="button">韓漫翻譯</button>
  <section class="panel hidden" id="panel">
   <header><strong>韓漫翻譯 V2</strong><button id="close" type="button" class="topbutton">收起 ✕</button></header>
   <label for="url">Cloudflare Worker 網址</label><input id="url" placeholder="https://kmanga-proxy.xxx.workers.dev" inputmode="url" />
   <label for="token">ACCESS_TOKEN（不是 Gemini API Key）</label><input id="token" type="password" autocomplete="off" placeholder="僅保存在此頁記憶體" />
   <label for="mode">翻譯模式</label><select id="mode"><option value="ocr">省額度：OCR → Gemini</option><option value="vision">高品質：Gemini 看圖片</option></select>
   <label for="model">Gemini 模型</label><select id="model"><option>gemini-2.5-flash</option><option>gemini-2.5-flash-lite</option></select>
   <label for="glossary">角色姓名對照（可選）</label><textarea id="glossary" placeholder="주빈=晝濱；이경=以暻"></textarea>
   <div class="buttons">
    <button id="current" class="btn" type="button">翻譯目前畫面</button><button id="choose" class="btn" type="button">點選漫畫圖片</button>
    <button id="toggle" class="btn gray" type="button">隱藏／顯示中文</button><button id="clear" class="btn gray" type="button">清除本頁翻譯</button>
    <button id="save" class="btn gray" type="button">儲存一般設定</button><button id="resetcache" class="btn danger" type="button">清除翻譯快取</button>
   </div>
   <p class="status" id="status">先輸入 Worker 網址和 ACCESS_TOKEN，再按「翻譯目前畫面」。</p>
   <div class="muted" id="usage">Gemini Token：尚未使用</div>
   <p class="muted">文字是蓋在原圖上，不會修改或下載漫畫。若網站圖片受跨網域限制，瀏覽器可能禁止 OCR。可點中文區塊手動更正。</p>
  </section>`;
  const q = (selector) => shadow.querySelector(selector);
  const status = (message) => { q('#status').textContent=String(message); };
  function open() { q('#panel').classList.remove('hidden'); q('#float').classList.add('hidden'); }
  function close() { q('#panel').classList.add('hidden'); q('#float').classList.remove('hidden'); }
  q('#float').addEventListener('click',open);
  q('#close').addEventListener('click',close);
  (document.body||document.documentElement).appendChild(host);

  const overlayLayer = document.createElement('div');
  overlayLayer.setAttribute('data-kmanga-overlay','');
  overlayLayer.style.cssText='position:fixed!important;inset:0!important;z-index:2147483645!important;pointer-events:none!important;contain:layout style!important;';
  (document.body||document.documentElement).appendChild(overlayLayer);
  function saveFormValues() {
    state.workerUrl=q('#url').value.trim().replace(/\/+$/,'');
    state.accessToken=q('#token').value.trim();
    state.mode=q('#mode').value;
    state.model=q('#model').value;
    state.glossary=q('#glossary').value.trim();
  }
  async function saveSettings(){saveFormValues();await GM.setValue(STORAGE+'settings',{workerUrl:state.workerUrl,mode:state.mode,model:state.model,glossary:state.glossary});status('已儲存設定（不包含 ACCESS_TOKEN）。');}
  q('#save').addEventListener('click',()=>saveSettings().catch(err=>status(err.message)));
  (async()=>{
    try {
      const prefs=await GM.getValue(STORAGE+'settings',{});
      q('#url').value=prefs.workerUrl||'';
      q('#mode').value=prefs.mode||'ocr';
      q('#model').value=MODEL_OPTIONS.includes(prefs.model)?prefs.model:MODEL_OPTIONS[0];
      q('#glossary').value=prefs.glossary||'';
      state.stats=await GM.getValue(STORAGE+'stats',state.stats);
      state.cacheIndex=await GM.getValue(STORAGE+'index',[]);
      updateUsage();
    } catch(err){status('設定讀取失敗：'+err.message)}
  })();
  function updateUsage(){q('#usage').textContent=`此腳本累計：${state.stats.requests||0} 次 API，輸入 ${state.stats.input||0}、輸出 ${state.stats.output||0}、總計 ${state.stats.total||0} tokens（快取不計；不代表 Google 專案全部用量）`;}
  function usageTotals(usage) {
    if(!usage||typeof usage!=='object')return;
    state.stats.requests=(state.stats.requests||0)+1;
    state.stats.input=(state.stats.input||0)+(usage.promptTokenCount||0);
    state.stats.output=(state.stats.output||0)+(usage.candidatesTokenCount||0);
    state.stats.total=(state.stats.total||0)+(usage.totalTokenCount||0);
    updateUsage();
    GM.setValue(STORAGE+'stats',state.stats).catch(console.warn);
  }
  function ensureConfig(){
    saveFormValues();
    if(!/^https:\/\/[a-z0-9.-]+(?:\/)?$/i.test(state.workerUrl))throw Error('請輸入完整 HTTPS Worker 網址（不包含 /overlay）。');
    if(!state.accessToken)throw Error('請輸入 ACCESS_TOKEN（不是 Gemini API Key）。');
  }
  function findVisibleImages(){
    const vh=innerHeight,vw=innerWidth;
    return [...document.querySelectorAll('img')].filter(img=>img.complete&&img.naturalWidth>180&&img.naturalHeight>160)
      .map(img=>{const r=img.getBoundingClientRect();const ix=Math.max(0,Math.min(vw,r.right)-Math.max(0,r.left));const iy=Math.max(0,Math.min(vh-30,r.bottom)-Math.max(0,r.top));return {img,area:ix*iy,rect:r};})
      .filter(x=>x.area>12000).sort((a,b)=>b.area-a.area);
  }
  function captureVisible(img){
    const r=img.getBoundingClientRect();
    if(!r.width||!r.height||!img.naturalWidth||!img.naturalHeight)throw Error('圖片尚未載入完成。');
    const left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight-20,r.bottom);
    if(right-left<60||bottom-top<50)throw Error('請先把漫畫圖片滑動到畫面中央。');
    const source={x:Math.max(0,(left-r.left)/r.width),y:Math.max(0,(top-r.top)/r.height),w:(right-left)/r.width,h:(bottom-top)/r.height};
    const sx=Math.max(0,Math.floor(source.x*img.naturalWidth)), sy=Math.max(0,Math.floor(source.y*img.naturalHeight));
    const sw=Math.min(img.naturalWidth-sx,Math.ceil(source.w*img.naturalWidth)),sh=Math.min(img.naturalHeight-sy,Math.ceil(source.h*img.naturalHeight));
    const scale=Math.min(1,1550/sw,1900/sh);
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(sw*scale));canvas.height=Math.max(1,Math.round(sh*scale));
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
    let dataUrl;
    try{dataUrl=canvas.toDataURL('image/jpeg',0.86)}catch(err){
      if(err.name==='SecurityError')throw Error('這張圖片有跨網域讀取限制（CORS），Safari 禁止取得像素，因此無法直接 OCR。這不是 API Key 錯誤；目前版本無法保證在該網站使用。');
      throw err;
    }
    return {img,source,canvas,dataUrl};
  }
  function parseTsv(tsv,w,h){
    if(typeof tsv!=='string')return [];
    const rows=tsv.trim().split(/\r?\n/).slice(1);
    const groups=new Map();
    for(const row of rows){const c=row.split('\t');if(c.length<12||Number(c[0])!==5)continue;
      const word=c.slice(11).join('\t').trim();if(!word||!/[\u3131-\u318E\uAC00-\uD7A3]/.test(word))continue;
      const left=+c[6],top=+c[7],ww=+c[8],hh=+c[9],confidence=+c[10];
      if(![left,top,ww,hh].every(Number.isFinite)||ww<=0||hh<=0||confidence<20)continue;
      const key=[c[2],c[3],c[4]].join('-');
      if(!groups.has(key))groups.set(key,{text:[],x1:Infinity,y1:Infinity,x2:0,y2:0});
      const g=groups.get(key);g.text.push(word);g.x1=Math.min(g.x1,left);g.y1=Math.min(g.y1,top);g.x2=Math.max(g.x2,left+ww);g.y2=Math.max(g.y2,top+hh);
    }
    return [...groups.values()].filter(g=>g.text.join('').length>=2).sort((a,b)=>a.y1-b.y1||a.x1-b.x1).slice(0,35).map((g,i)=>({id:String(i),text:g.text.join(' '),bbox:[g.x1/w,g.y1/h,g.x2/w,g.y2/h]}));
  }
  async function recognize(capture){
    const engine=typeof Tesseract!=='undefined'?Tesseract:window.Tesseract;
    if(!engine||typeof engine.createWorker!=='function')throw Error('OCR 套件未載入。請確認 Userscripts 的 @require 有下載 Tesseract.js。');
    if(!state.worker){status('第一次使用：正在下載韓文 OCR 模型…');state.worker=await engine.createWorker('kor');}
    status('正在辨識畫面中的韓文與文字座標…');
    const response=await state.worker.recognize(capture.dataUrl,{}, {tsv:true,text:true});
    let lines=parseTsv(response.data.tsv,capture.canvas.width,capture.canvas.height);
    if(!lines.length && /[\uAC00-\uD7A3]/.test(response.data.text||''))throw Error('已辨識到韓文，但無法取得文字框位置；請試高品質模式。');
    return lines;
  }
  function cacheHash(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(36)+'_'+text.length;}
  async function cacheKey(capture,lines){
    const text=[capture.dataUrl,state.mode,state.model,state.glossary,JSON.stringify(lines||[])].join('|');
    if(crypto&&crypto.subtle){const bytes=new TextEncoder().encode(text);const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
    return cacheHash(text);
  }
  async function getCache(key){return GM.getValue(STORAGE+'cache_'+key,null);}
  async function putCache(key,data){
    await GM.setValue(STORAGE+'cache_'+key,data);
    state.cacheIndex=state.cacheIndex.filter(x=>x!==key);state.cacheIndex.push(key);
    while(state.cacheIndex.length>30){const oldest=state.cacheIndex.shift();await GM.deleteValue(STORAGE+'cache_'+oldest)}
    await GM.setValue(STORAGE+'index',state.cacheIndex);
  }
  async function postWorker(body){
    // GM.xmlHttpRequest is the Userscripts extension's cross-site request bridge.
    // The Worker still requires ACCESS_TOKEN and may check allowed Origins.
    const res=await GM.xmlHttpRequest({url:state.workerUrl+'/overlay',method:'POST',responseType:'text',timeout:90000,
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.accessToken},data:JSON.stringify(body)});
    let data;try{data=JSON.parse(res.responseText||res.response||'{}')}catch{throw Error('Worker 沒有回傳 JSON，HTTP '+res.status)}
    if(res.status<200||res.status>=300)throw Error(data.error||`Worker HTTP ${res.status}`);
    return data;
  }
  async function translateImage(img){
    if(state.busy)return;
    state.busy=true;
    q('#current').disabled=true;q('#choose').disabled=true;
    try{
      ensureConfig();
      await saveSettings();
      status('正在讀取目前畫面…');
      const capture=captureVisible(img);
      let lines=null;
      if(state.mode==='ocr'){
        lines=await recognize(capture);
        if(!lines.length)throw Error('沒有找到清晰的韓文。可改用「Gemini 看圖片」模式。');
      }
      const key=await cacheKey(capture,lines);
      let data=await getCache(key);
      const isCached=!!data;
      if(!data){
        status('正在呼叫 Gemini 翻譯…');
        const request={mode:state.mode,model:state.model,glossary:state.glossary};
        if(state.mode==='ocr')request.lines=lines.map(({id,text})=>({id,text}));
        else {request.mimeType='image/jpeg';request.imageBase64=capture.dataUrl.split(',')[1];}
        data=await postWorker(request);
        usageTotals(data.usage);
        await putCache(key,{translations:data.translations||null,boxes:data.boxes||null});
      }
      let boxes=[];
      if(state.mode==='ocr'){
        const translated=new Map((data.translations||[]).map(v=>[String(v.id),v.zh]));
        boxes=lines.filter(l=>translated.get(l.id)).map(l=>({bbox:l.bbox,text:l.text,zh:translated.get(l.id)}));
      } else {
        boxes=(data.boxes||[]).filter(b=>Array.isArray(b.bbox)&&b.bbox.length===4).map(b=>({bbox:b.bbox.map(n=>Math.max(0,Math.min(1,+n/1000))),text:b.text,zh:b.zh}));
      }
      if(!boxes.length)throw Error('Gemini 沒有回傳可覆蓋的中文文字框。');
      addOverlays(capture,boxes);
      status(`完成：已在漫畫上覆蓋 ${boxes.length} 個中文文字框${isCached?'（命中快取，沒有使用新 Token）':''}。向下滑動後可再次按「翻譯目前畫面」。`);
    } catch(err) {status('失敗：'+String(err.message||err));console.error('[K-Manga]',err);}
    finally{state.busy=false;q('#current').disabled=false;q('#choose').disabled=false;}
  }
  function addOverlays(capture,boxes){
    state.boxesHidden=false;
    for(const b of boxes){
      if(!b.zh||!b.bbox||b.bbox.length!==4)continue;
      const el=document.createElement('div');
      el.className='kmanga-zh';
      el.textContent=b.zh;
      el.title='點一下修改翻譯';
      el.style.cssText='position:absolute!important;pointer-events:auto!important;display:flex!important;align-items:center!important;justify-content:center!important;text-align:center!important;white-space:pre-wrap!important;overflow:hidden!important;padding:2px 4px!important;line-height:1.2!important;color:#101010!important;background:rgba(255,255,255,.95)!important;border-radius:7px!important;box-shadow:0 0 0 1px #3333!important;font-family:-apple-system,"PingFang TC",sans-serif!important;font-weight:650!important;z-index:1!important;';
      const ob={el,img:capture.img,source:capture.source,bbox:b.bbox};
      el.addEventListener('click',()=>{const value=prompt('修改中文翻譯',el.textContent);if(value!==null)el.textContent=value;});
      overlayLayer.appendChild(el);state.overlays.push(ob);
    }
    refreshPositions();
  }
  function refreshPositions(){
    for(const ob of state.overlays){
      if(!ob.img.isConnected){ob.el.remove();continue;}
      const r=ob.img.getBoundingClientRect();
      const [x1,y1,x2,y2]=ob.bbox.map(n=>Math.max(0,Math.min(1,n)));
      const x=r.left+(ob.source.x+ob.source.w*x1)*r.width;
      const y=r.top+(ob.source.y+ob.source.h*y1)*r.height;
      const width=Math.max(44,ob.source.w*(x2-x1)*r.width+12);
      const height=Math.max(23,ob.source.h*(y2-y1)*r.height+12);
      ob.el.style.left=(x-6)+'px';ob.el.style.top=(y-6)+'px';
      ob.el.style.width=width+'px';ob.el.style.minHeight=height+'px';
      ob.el.style.maxHeight=Math.max(32,height*1.65)+'px';
      ob.el.style.fontSize=Math.max(10,Math.min(21,height/2.0,width/Math.max(3,ob.el.textContent.length)*1.75))+'px';
      ob.el.style.display=(state.boxesHidden||r.bottom<0||r.top>innerHeight||y<-90||y>innerHeight+90)?'none':'flex';
    }
  }
  let raf=0;
  function queueRefresh(){if(raf)return;raf=requestAnimationFrame(()=>{raf=0;refreshPositions()});}
  window.addEventListener('scroll',queueRefresh,{passive:true,capture:true});
  window.addEventListener('resize',queueRefresh,{passive:true});
  q('#current').addEventListener('click',()=>{const candidates=findVisibleImages();if(!candidates.length)return status('目前畫面沒有可選取的 <img> 漫畫圖片。網站可能使用 Canvas 或特殊閱讀器。');translateImage(candidates[0].img);});
  q('#choose').addEventListener('click',()=>{
    state.selecting=true;close();
    alert('請點一下想翻譯的漫畫圖片。選取後會翻譯「目前看得到的區段」。');
  });
  document.addEventListener('click',(event)=>{
    if(!state.selecting)return;
    const target=event.target instanceof Element?event.target.closest('img'):null;
    if(!target)return;
    event.preventDefault();event.stopImmediatePropagation();state.selecting=false;open();translateImage(target);
  },true);
  q('#toggle').addEventListener('click',()=>{state.boxesHidden=!state.boxesHidden;refreshPositions();status(state.boxesHidden?'已暫時隱藏中文。':'已顯示中文。');});
  q('#clear').addEventListener('click',()=>{for(const ob of state.overlays)ob.el.remove();state.overlays=[];status('已移除此頁的中文覆蓋。');});
  q('#resetcache').addEventListener('click',async()=>{
    if(!confirm('要清除目前裝置內所有 K-Manga 翻譯快取嗎？'))return;
    try{for(const key of state.cacheIndex)await GM.deleteValue(STORAGE+'cache_'+key);state.cacheIndex=[];await GM.setValue(STORAGE+'index',[]);status('翻譯快取已清除；累計 Token 統計保留。');}
    catch(e){status('清除失敗：'+e.message)}
  });
})();
