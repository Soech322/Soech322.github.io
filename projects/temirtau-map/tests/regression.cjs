'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,'');
function fixture() {
 const events={}, stored=new Map(), writes=[], audits=[], revoked=[];
 const deleted={sentinel:'delete'};
 const App={mapClickHandlers:[],auth:{isAdmin:true,user:{uid:'admin',getIdToken:async()=> 'id-token'}},
  store:{get:(k,d)=>stored.has(k)?stored.get(k):d,set:(k,v)=>stored.set(k,v)},
  on:(name,fn)=>(events[name]??=[]).push(fn),emit:(name,...a)=>(events[name]||[]).forEach(fn=>fn(...a)),
  normalizeSearch:s=>String(s||'').toLowerCase(),plainText:s=>String(s??'').replace(/<br>/g,'\n').replace(/<[^>]*>/g,'').trim(),
  esc:s=>String(s??'').replaceAll('<','&lt;'),t:k=>k,ic:()=>'',toast(){},localizeData:s=>s,formatDate:()=>'',sheet:{key:()=>null},
  fb:{ok:true,db:{collection(name){return {doc:id=>({set:async data=>writes.push({name,id,data})}),add:async data=>audits.push(data)}}}},
  $:()=>null,$$:()=>[]};
 const bucket='test-bucket';
 const reference=p=>({fullPath:p||'',bucket,delete:async()=>{}});
 App.fb.storage={ref:reference,refFromURL:url=>reference(decodeURIComponent(url.split('/o/')[1].split('?')[0]))};
 const doc={querySelectorAll:()=>[],body:{classList:{remove(){},toggle(){}}},readyState:'loading',addEventListener(){}};
 const ctx={window:{App},document:doc,console:{warn(){},error(){},log(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,Map,Set,URL,AbortController,Blob,
  firebase:{firestore:{FieldValue:{delete:()=>deleted,serverTimestamp:()=> 'timestamp'}}},
  crypto:require('node:crypto').webcrypto};
 vm.createContext(ctx);
 vm.runInContext(read('js/sheet-sync.js'),ctx);
 vm.runInContext(read('js/photos.js'),ctx);
 const src=read('js/registry.js').replace('  App.registry = {','  App.test = { makeFeature, buildGroups, applySheet, detailsHtml, chipsHtml, entryHtml, saveOverride, revertChange, overrides, setupLayers, uploadPhoto, deletePhoto };\n  App.registry = {');
 vm.runInContext(src,ctx);
 return {App,ctx,stored,writes,audits,deleted,revoked,events};
}
const base={id:'test',name:'Test address',description:'Original',geometry:{type:'Point',coordinates:{lat:50,lng:73}}};
test('all JavaScript and JSON files parse; referenced local assets exist',()=>{
 for(const file of [...fs.readdirSync(path.join(root,'js')).map(n=>'js/'+n),...fs.readdirSync(root).filter(n=>n.endsWith('.js'))])new vm.Script(read(file),{filename:file});
 JSON.parse(read('firebase.json'));JSON.parse(read('manifest.webmanifest'));
 for(const m of read('index.html').replace(/<script>[\s\S]*?<\/script>/g,'').matchAll(/(?:src|href)="([^"#]+)"/g)){if(!/^(https?:|data:|blob:)/.test(m[1]))assert.ok(fs.existsSync(path.join(root,m[1])),m[1]);}
});
test('house range includes intermediate houses and preserves reverse-order corpus format',()=>{
 const {App}=fixture();
 const p=App.sheetSync.parseAddress;
 assert.deepEqual(Array.from(p('проспект Республики, дома 1-3').nums),['1','2','3']);
 assert.deepEqual(Array.from(p('проспект Республики, дом 32-1').nums),['32/1']);
 assert.deepEqual(Array.from(p('проспект Республики, дома 1–3').nums),['1','2','3']);
});
test('valid empty sheet replaces stale cache and clears old completed work',async()=>{
 const {App,ctx,stored}=fixture();
 stored.set('sheetCache',{rows:[['Краска','Песок','Карусель'],['3 мкр, дом 16','','']],at:'old'});
 ctx.fetch=async()=>({ok:true,text:async()=>'"Краска","Песок","Карусель"\n'});
 await App.sheetSync.load(true);
 assert.equal(App.sheetSync.state.hasData,true);assert.equal(App.sheetSync.state.rows.length,0);
 assert.equal(App.sheetSync.state.fromCache,false);assert.equal(App.sheetSync.state.error,null);
 assert.equal(stored.get('sheetCache').rows.length,1);
});
test('sheet refresh keeps the last successful statuses while loading',async()=>{
 const {App,ctx}=fixture();
 ctx.fetch=async()=>({ok:true,text:async()=>'Краска,Песок,Карусель\n3 мкр дом 16,,\n'});
 await App.sheetSync.load();
 let release;ctx.fetch=()=>new Promise(r=>release=r);
 const loading=App.sheetSync.load();
 const g={point:{id:'a',name:'3 мкр дом 16',tasks:{paint:false}},tasks:{paint:false}};
 App.test.applySheet({groups:[g]});assert.equal(g.tasks.paint,true);
 release({ok:true,text:async()=>'Краска,Песок,Карусель\n'});await loading;
});
test('corrupt cached sheet cannot leave synchronizer stuck in loading',async()=>{
 const {App,ctx,stored}=fixture();
 stored.set('sheetCache',{rows:[['not a valid header']]});
 ctx.fetch=async()=>({ok:true,text:async()=>'bad header'});
 await App.sheetSync.load();assert.equal(App.sheetSync.state.status,'error');
 ctx.fetch=async()=>({ok:true,text:async()=>'Краска,Песок,Карусель\n'});
 await App.sheetSync.load();assert.equal(App.sheetSync.state.status,'ok');
});
test('explicit clear persists; old corrupt blank descriptions still fall back',()=>{
 const {App}=fixture();
 assert.equal(App.test.makeFeature('gis',base,{description:'',descriptionHidden:true}).description,'');
 assert.equal(App.test.makeFeature('gis',base,{description:''}).description,'Original');
 assert.equal(App.test.makeFeature('gis',base,{description:'Кадастровый номер: Площадь: кв.м Категория:'}).description,'Original');
});
test('first description edit is restorable from history; null removes override',async()=>{
 const {App,writes,audits,deleted}=fixture();
 await App.test.saveOverride('gis','test',{description:'Changed'});
 assert.equal(audits[0].before.description,null);
 assert.ok(App.test.entryHtml({...audits[0],_id:'log'},false).includes('data-restore-log'));
 await App.test.revertChange('gis','test',{description:null});
 assert.equal(writes[1].data.description,deleted);
});
test('cleared description history records and restores the hidden flag',async()=>{
 const {App,audits}=fixture();
 await App.test.saveOverride('gis','test',{descriptionHidden:true});
 assert.equal(audits[0].before.description,null);assert.equal(audits[0].after.descriptionHidden,true);
 await App.test.revertChange('gis','test',audits[0].before);
 assert.equal(App.test.overrides.gis.get('test').descriptionHidden,undefined);
});
test('photo section and photo count are omitted for non-admin visitors',()=>{
 const {App}=fixture();App.auth.isAdmin=false;
 const g=App.test.buildGroups('gis',[App.test.makeFeature('gis',base,{photo1Url:'registry-photos/gis/test/a.jpg'})]).groups[0];
 assert.ok(!App.test.detailsHtml(g).includes('photo-section'));assert.ok(!App.test.chipsHtml(g).includes('image'));
});
test('admin photo section has click controls and no image URL or automatic fetch',()=>{
 const {App,ctx}=fixture();let calls=0;ctx.fetch=async()=>{calls++};
 const g=App.test.buildGroups('gis',[App.test.makeFeature('gis',base,{photo1Url:'registry-photos/gis/test/a.jpg'})]).groups[0];
 const html=App.test.detailsHtml(g);assert.ok(html.includes('<details class="block photo-section">'));
 assert.ok(html.includes('data-photo='));assert.ok(!/<img[^>]+src=/.test(html));assert.equal(calls,0);
});
test('private loader denies anonymous and signed-in non-admin requests before fetching',async()=>{
 const {App,ctx}=fixture();let calls=0;ctx.fetch=async()=>{calls++};
 App.auth.isAdmin=false;
 await assert.rejects(App.photos.load('registry-photos/gis/test/a.jpg'),/not admin/);
 App.auth.user=null;await assert.rejects(App.photos.load('registry-photos/gis/test/a.jpg'),/not admin/);assert.equal(calls,0);
});
test('authenticated photo requests omit download tokens, deduplicate and cache only in memory',async()=>{
 const {App,ctx}=fixture();const requests=[];
 ctx.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,blob:async()=>new Blob(['image'],{type:'image/jpeg'})}};
 const value='https://firebasestorage.googleapis.com/v0/b/test-bucket/o/registry-photos%2Fgis%2Ftest%2Fa.jpg?alt=media&token=old-public-token';
 const [a,b]=await Promise.all([App.photos.load(value),App.photos.load(value)]);
 assert.equal(a,b);assert.equal(await App.photos.load(value),a);assert.equal(requests.length,1);
 assert.ok(!requests[0].url.includes('token='));assert.equal(requests[0].options.headers.Authorization,'Firebase id-token');
 assert.equal(requests[0].options.cache,'no-store');App.photos.clear();
});
test('failed photo request is retryable and logout invalidates in-flight results',async()=>{
 const {App,ctx}=fixture();let attempts=0;
 ctx.fetch=async()=>{attempts++;return {ok:false,status:403}};
 await assert.rejects(App.photos.load('registry-photos/gis/test/a.jpg'),/403/);
 ctx.fetch=async()=>{attempts++;return {ok:true,blob:async()=>new Blob(['image'],{type:'image/jpeg'})}};
 await App.photos.load('registry-photos/gis/test/a.jpg');assert.equal(attempts,2);App.photos.clear();
 let finish;ctx.fetch=()=>new Promise(r=>finish=r);
 const pending=App.photos.load('registry-photos/gis/test/b.jpg');await new Promise(setImmediate);
 App.auth.isAdmin=false;App.emit('auth');finish({ok:true,blob:async()=>new Blob(['image'],{type:'image/jpeg'})});
 await assert.rejects(pending,/session changed/);
});
test('custom vector panes inherit the native geographic overlay pane',()=>{
 const {App}=fixture();const parent={},panes=[];
 App.map={getPane:name=>{assert.equal(name,'overlayPane');return parent},createPane:(name,container)=>{panes.push({name,container});return {style:{}}}};
 const source=read('js/registry.js');
 // Functions close over L at execution time, using the same loaded VM context.
 const fx=fixture();fx.App.map=App.map;fx.ctx.L={layerGroup:()=>({addTo(){return this}})};fx.App.test.setupLayers();
 assert.equal(panes.length,2);assert.ok(panes.every(p=>p.container===parent));
 assert.ok(!source.includes("createPane('zonesPane')."));
});
test('route rendering never invokes camera methods',()=>{
 const {App,ctx}=fixture();
 const dom=new Map();
 ctx.document.querySelector=selector=>{if(!dom.has(selector))dom.set(selector,{classList:{add(){},remove(){}},textContent:''});return dom.get(selector)};
 ctx.L={geoJSON:()=>({addTo(){return this},getBounds(){throw new Error('route must not request bounds')}})};
 vm.runInContext(read('js/core.js').replace('  function boot() {','  App.__routeTest = { showRouteResult, setMap(value) { map=value; } };\n  function boot() {'),ctx);
 App.t=k=>k;
 const camera=new Proxy({removeLayer(){}},{get(target,key){if(key in target)return target[key];throw new Error('Unexpected camera method: '+String(key))}});
 App.__routeTest.setMap(camera);
 App.__routeTest.showRouteResult({type:'LineString',coordinates:[]},100,60,'test');
 App.__routeTest.showRouteResult({type:'LineString',coordinates:[]},100,60,'test again');
});
test('photo replacement commits new reference before deleting old photo; failed commit keeps old photo',async()=>{
 const {App,ctx}=fixture();
 const source=read('js/registry.js');
 const compressStart=source.indexOf('  function compressImage('),compressEnd=source.indexOf('  async function showPrivatePhoto',compressStart);
 let testSrc=source.slice(0,compressStart)+"  async function compressImage() { return new Blob(['image'],{type:'image/webp'}); }\n"+source.slice(compressEnd);
 testSrc=testSrc.replace('  App.registry = {','  App.__upload = uploadPhoto;\n  App.registry = {');
 vm.runInContext(testSrc,ctx);
 const order=[];
 App.fb.storage.ref=p=>({fullPath:p,bucket:'test-bucket',put:async()=>order.push('put-new'),delete:async()=>order.push('delete-new')});
 App.photos.reference=()=>({delete:async()=>order.push('delete-old')});App.photos.forget=()=>{};
 App.fb.db.collection=()=>({doc:()=>({set:async()=>order.push('commit')}),add:async()=>{}});
 const g={section:'gis',primary:{id:'test',photo1Url:'registry-photos/gis/test/old.jpg'}};
 const event=()=>({target:{files:[{}],value:'file'}});
 await App.__upload(g,1,event());assert.deepEqual(order,['put-new','commit','delete-old']);
 order.length=0;App.fb.db.collection=()=>({doc:()=>({set:async()=>{order.push('commit-failed');throw new Error('denied')}})});
 await App.__upload(g,1,event());assert.deepEqual(order,['put-new','commit-failed','delete-new']);
});
test('privacy rules close both current and legacy photo APIs; service worker excludes authenticated requests',()=>{
 const rules=read('storage.rules');assert.ok(!rules.includes('allow read: if true'));
 assert.match(rules,/match \/registry-photos[\s\S]*?allow read: if isAdmin\(\)/);
 assert.match(rules,/match \/card-photos[\s\S]*?allow read: if isAdmin\(\)/);
 assert.ok(read('sw.js').includes("req.headers.has('Authorization')"));
 assert.ok(read('css/app.css').includes('.route-field input { font-size: 16px; }'));
 assert.match(read('index.html'),/type="button"[^>]+id="route-build"/);
});



test('single HTML embeds and parses every required script and stylesheet',()=>{
 const html=read('index.html');
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
 assert.equal(scripts.length,19);
 for(const [i,script]of scripts.entries())new vm.Script(script[1],{filename:'inline-'+i+'.js'});
 assert.equal([...html.matchAll(/<style>/g)].length,2);
 assert.ok(!/<script\s+src=/.test(html));
 const shell=html.replace(/<script>[\s\S]*?<\/script>/g,'');
 assert.ok(!/href="(?:css|vendor)\//.test(shell));
 assert.ok(!/src="icon\.svg"/.test(shell));
});
