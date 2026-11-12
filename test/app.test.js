import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { classifyRoad } from '../public/road.js';
import { gpsToAmap } from '../public/location.js';
import * as junction from '../public/junction.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace("import { classifyRoad } from './road.js';", '')
  .replace("import { gpsToAmap } from './location.js';", '')
  .replace("import { DIRECTIONS, groupJunctions, junctionMarkerHTML } from './junction.js';", '')
  .replace('loadData(); loadMap().then(loaded=>{ if(loaded) locate(); });', '');
const SESSION_KEY = 'jingtu.amap.session';

// Exercise the production initialization and handlers with deterministic DOM/SDK/network adapters.
function page({store = new Map(), blocked = false, proxy = false, sdkFailure = false, prefix = '/'} = {}) {
  const elements = new Map();
  class Element {
    constructor() { this.hidden=false; this.value=''; this.events={}; this.attributes={}; this.children=[]; this.style={}; }
    addEventListener(name, handler) { this.events[name]=handler; }
    setAttribute(name, value) { this.attributes[name]=value; }
    getAttribute(name) { return this.attributes[name]; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children=[]; }
    focus() {}
    remove() { this.removed=true; }
    showModal() { this.open=true; }
    close() { this.open=false; }
  }
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element=new Element(); element.hidden=/\bhidden\b/.test(match[0]);
    element.checked=/\bchecked\b/.test(match[0]);
    element.attributes['aria-expanded']=match[0].match(/aria-expanded="([^"]+)"/)?.[1];
    elements.set(match[1],element);
  }
  elements.get('radius').value='3';
  let reloads=0, maps=0, requests=0, scripts=0, context;
  const apiRequests = [], markers = [], clusterPoints = [];
  const amap = {
    Map: class { constructor(){maps++;this.events={};} on(name,cb){this.events[name]=cb;} destroy(){} remove(){} setZoomAndCenter(){} },
    Geocoder: class { getAddress(_position, cb) {requests++; cb('complete',{regeocode:{roads:[{name:'北四环辅路',distance:10}],crosses:[]}});} },
    Marker: class {constructor(options){this.options=options; markers.push(this);} setMap(map){this.removed=!map;}}, Circle: class {}, Pixel: class {},
    MarkerCluster: class {constructor(_map,points){clusterPoints.push(points);} setMap(){} on(){}},
  };
  const document = {getElementById:id=>elements.get(id), createElement:()=>new Element(), addEventListener(){}, head:{append(script){
    scripts++;
    queueMicrotask(()=>{
      if(sdkFailure) script.onerror();
      else {context.window.AMap=amap; context.AMap=amap; script.onload();}
    });
  }}};
  context=vm.createContext({
    document, classifyRoad, gpsToAmap, ...junction, URL, window:{}, navigator:{}, location:{origin:'http://localhost',href:'http://localhost'+prefix,reload(){reloads++;}},
    sessionStorage:{getItem(key){if(blocked)throw Error('disabled');return store.get(key)||null;},setItem(key,value){if(blocked)throw Error('disabled');store.set(key,value);},removeItem(key){if(blocked)throw Error('disabled');store.delete(key);}},
    fetch:async(url,options)=>{apiRequests.push({url,options});return {ok:true,json:async()=>String(url).endsWith('api/config') ? {mapKey:'fake-js-key',securityProxy:proxy} : {cameras:[],fetchedAt:'2026-11-12T00:00:00Z',stale:false}};},
    setTimeout, clearTimeout
  });
  vm.runInContext(source + '\nglobalThis.client={loadMap,clearSecurity,setPanel,showDetail,queueRoadLookup,setCenter,loadData,locate};',context);
  return {client:context.client,elements,store,context,apiRequests,markers,clusterPoints, stats:()=>({reloads,maps,requests,scripts})};
}

test('首次要求输入密钥，加载成功后刷新同标签页自动恢复；清除会移除会话并重载', async()=>{
  const first=page();
  assert.equal(await first.client.loadMap(), false);
  assert.equal(first.elements.get('security-form').hidden, false);
  assert.equal(await first.client.loadMap('fake-security-code'), true);
  assert.equal(first.elements.get('security-form').hidden, true);
  const refreshed=page({store:first.store});
  assert.equal(await refreshed.client.loadMap(), true);
  assert.equal(refreshed.context.window._AMapSecurityConfig.securityJsCode,'fake-security-code');
  assert.equal(refreshed.stats().maps,1);
  refreshed.client.clearSecurity();
  assert.equal(refreshed.store.has(SESSION_KEY),false);
  assert.equal(refreshed.stats().reloads,1);
  assert.equal(await page({store:refreshed.store}).client.loadMap(),false);
});

test('坐标转换服务失败仍显示附近位置，回到当前位置保留近似转换提示', async()=>{
  const p=page({proxy:true}); await p.client.loadMap();
  p.context.AMap.convertFrom=(_point,_type,cb)=>cb('error',undefined);
  p.context.navigator.geolocation={getCurrentPosition(success){success({coords:{longitude:116.404,latitude:39.915,accuracy:20}});}};
  p.client.locate();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(p.elements.get('location-status').textContent,/当前位置.*近似转换/);
  assert.match(p.elements.get('location-time').textContent,/不包含转换误差/);
  assert.ok(Math.abs(vm.runInContext('center.lng',p.context)-116.41024449916938)<1e-8);
  p.elements.get('recenter').events.click();
  assert.match(p.elements.get('location-status').textContent,/近似转换/);
});

test('连续定位与手动选点不被旧的转换回调覆盖', async()=>{
  const p=page({proxy:true}); await p.client.loadMap();
  const conversions=[];
  p.context.AMap.convertFrom=(_point,_type,cb)=>conversions.push(cb);
  p.context.navigator.geolocation={getCurrentPosition(success){success({coords:{longitude:116.404,latitude:39.915,accuracy:20}});}};
  p.client.locate(); p.client.locate();
  conversions[1]('complete',{locations:[{lng:116.42,lat:39.92}]});
  await new Promise(resolve=>setImmediate(resolve));
  conversions[0]('complete',{locations:[{lng:116.41,lat:39.91}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('center.lng',p.context),116.42);
  p.client.locate();
  p.elements.get('select').events.click();
  vm.runInContext('map.events.click({lnglat:{lng:116.5,lat:39.9}})',p.context);
  conversions[2]('complete',{locations:[{lng:116.43,lat:39.93}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('center.lng',p.context),116.5);
  assert.equal(p.elements.get('location-status').textContent,'以手动选点查询');
});

test('拒绝定位时不调用转换且保留明确提示', async()=>{
  const p=page({proxy:true}); await p.client.loadMap();
  p.context.AMap.convertFrom=()=>assert.fail('不应转换');
  p.context.navigator.geolocation={getCurrentPosition(_success,error){error({code:1});}};
  p.client.locate();
  assert.match(p.elements.get('location-status').textContent,/未允许定位/);
  assert.equal(vm.runInContext('center',p.context),undefined);
});

test('不同 Key 不复用旧密钥，损坏或被禁用的会话存储不阻止手动加载',async()=>{
  const changed=page({store:new Map([[SESSION_KEY,JSON.stringify({key:'old-key',code:'old-code'})]])});
  assert.equal(await changed.client.loadMap(),false);
  assert.equal(changed.store.has(SESSION_KEY),false);
  const corrupt=page({store:new Map([[SESSION_KEY,'bad-json']])});
  assert.equal(await corrupt.client.loadMap('fake-code'),true);
  const blocked=page({blocked:true});
  assert.equal(await blocked.client.loadMap(),false);
  assert.equal(await blocked.client.loadMap('fake-code'),true);
  assert.match(blocked.elements.get('credential-status').textContent,/禁用/);
});

test('SDK 网络失败后保留本页输入供重试，错误提示可见，重试可恢复',async()=>{
  const failed=page({sdkFailure:true});
  assert.equal(await failed.client.loadMap('fake-code'),false);
  assert.equal(failed.elements.get('map-error').hidden,false);
  failed.context.document.head.append=script=>queueMicrotask(()=>{
    failed.context.window.AMap={Map:class {on(){}}, Geocoder:class {}};
    failed.context.AMap=failed.context.window.AMap; script.onload();
  });
  assert.equal(await failed.client.loadMap(),true);
  assert.equal(failed.context.window._AMapSecurityConfig.securityJsCode,'fake-code');
  assert.equal(failed.elements.get('map-error').hidden,true);
});

test('服务端代理不要求输入，不保存安全密钥',async()=>{
  const proxy=page({proxy:true});
  assert.equal(await proxy.client.loadMap(),true);
  assert.equal(proxy.context.window._AMapSecurityConfig.serviceHost,'http://localhost/_AMapService');
  assert.equal(proxy.store.has(SESSION_KEY),false);
  assert.equal(proxy.elements.get('clear-security').hidden,true);
});

test('HTTPS 反向代理子路径下配置、探头刷新及高德代理保持同一前缀',async()=>{
  const p=page({proxy:true,prefix:'/jingtu/'});
  assert.equal(await p.client.loadMap(),true);
  await p.client.loadData();
  await p.client.loadData(true);
  assert.deepEqual(p.apiRequests.map(r=>r.url),[
    'http://localhost/jingtu/api/config',
    'http://localhost/jingtu/api/cameras',
    'http://localhost/jingtu/api/cameras/refresh'
  ]);
  assert.equal(p.apiRequests[2].options.method,'POST');
  assert.equal(p.context.window._AMapSecurityConfig.serviceHost,'http://localhost/jingtu/_AMapService');
  assert.match(html,/href="\.\/style\.css"/);
  assert.match(html,/src="\.\/app\.js"/);
});

test('列表、设置及说明默认收起，打开一个面板会收起另一个',()=>{
  const p=page();
  assert.equal(p.elements.get('camera-panel').hidden,true);
  assert.equal(p.elements.get('settings-panel').hidden,true);
  assert.equal(/<details\b[^>]*\bopen\b/.test(html),false);
  p.client.setPanel('list',true);
  assert.equal(p.elements.get('camera-panel').hidden,false);
  p.client.setPanel('settings',true);
  assert.equal(p.elements.get('camera-panel').hidden,true);
  assert.equal(p.elements.get('settings-panel').hidden,false);
  assert.equal(p.elements.get('toggle-list').getAttribute('aria-expanded'),'false');
  p.client.setPanel('settings',false);
  assert.equal(p.elements.get('settings-panel').hidden,true);
});

test('来源主路及带不确定备注的探头也查询高德，失败保留来源并显示状态',async()=>{
  const p=page(); await p.client.loadMap('fake-code');
  p.client.showDetail({id:'one',name:'北四环主路',lng:116.4,lat:39.9,distance:0.1});
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(p.stats().requests,1);
  assert.match(p.elements.get('detail-body').innerHTML,/主辅路冲突/);
  assert.match(p.elements.get('detail-body').innerHTML,/北四环辅路/);
  p.client.showDetail({id:'two',name:'北四环主路待确认',lng:116.41,lat:39.9,distance:0.2});
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(p.stats().requests,2);
  assert.match(p.elements.get('detail-body').innerHTML,/来源描述存在不确定信息/);
  vm.runInContext("geocoder.getAddress=(_position,cb)=>cb('error',{});",p.context);
  p.client.showDetail({id:'three',name:'京藏高速主路',lng:116.42,lat:39.9,distance:0.3});
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.match(p.elements.get('detail-body').innerHTML,/高德查询失败或超时/);
  assert.match(p.elements.get('detail-body').innerHTML,/来源名称或描述提到主路/);
});

test('同路口仅绘制一个紫色方位点，详情可查看各成员，关闭分组恢复原点',async()=>{
  const p=page({proxy:true}); await p.client.loadMap();
  vm.runInContext(`
    geocoder=null;
    cameras=[
      {id:'north',name:'甲路与乙街交口北 北向南',lng:116.4,lat:39.9006},
      {id:'east',name:'甲路与乙街交口东 东向西',lng:116.4008,lat:39.9},
      {id:'far',name:'远处探头',lng:116.405,lat:39.9}
    ];
    roadCache.set(roadKey(cameras[0]),classifyRoad(cameras[0],[],{crosses:[{location:[116.4,39.9],firstRoadName:'甲路',secondRoadName:'乙街'}]}));
  `,p.context);
  p.client.setCenter({lng:116.4,lat:39.9},'manual');
  const marker=p.markers.find(m=>m.options.content?.className==='junction-marker');
  assert.ok(marker);
  assert.equal(p.elements.has('junction-radius'),false);
  assert.equal(p.elements.get('junction-legend').hidden,false);
  assert.equal(vm.runInContext('junctionGroups.length',p.context),1);
  assert.deepEqual(p.clusterPoints.flat().map(c=>c.camera.id),['far']);
  assert.match(marker.options.content.getAttribute('aria-label'),/北侧、东侧/);
  marker.options.content.events.click({stopPropagation(){}});
  assert.equal(p.elements.get('detail').open,true);
  assert.match(p.elements.get('detail-title').textContent,/甲路 × 乙街/);
  assert.match(p.elements.get('detail-body').innerHTML,/不代表拍摄朝向/);
  p.elements.get('detail-body').children.find(c=>c.className==='junction-member').events.click();
  assert.match(p.elements.get('detail-title').textContent,/北向南/);
  p.elements.get('junction-enabled').checked=false;
  p.elements.get('junction-enabled').events.change();
  assert.equal(marker.removed,true);
  assert.equal(p.elements.get('junction-legend').hidden,true);
  assert.equal(vm.runInContext('junctionGroups.length',p.context),0);
  assert.equal(p.clusterPoints.slice(1).flat().length,3);
});
