import { classifyRoad } from './road.js';
import { gpsToAmap } from './location.js';
const $ = id => document.getElementById(id);
// Keep assets, APIs and the AMap proxy under the same reverse-proxy prefix.
const appBase = new URL('.', location.href);
const appUrl = path => new URL(path, appBase).href;
const SESSION_KEY = 'jingtu.amap.session';
const roadCache = new Map(), roadPending = new Set();
let geocoder, roadQueueRunning = false, roadRequests = 0, priorityCamera = null;
let map, clusters = [], centerMarker, accuracyCircle, currentPosition, center;
let cameras = [], visible = [], selected = null, choosing = false, loadingMap = false;
let activeCode = '', activeKey = '', usesProxy = false;
let locationRequest = 0;
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roadLabel = road => road.kind === 'major' ? '主路 / 高速 / 高架（推测）' : road.kind === 'other' ? '辅路 / 地面 / 匝道（推测）' : '道路待确认';
function distance(a,b) {
  const rad = n => n*Math.PI/180, dLat=rad(b.lat-a.lat), dLng=rad(b.lng-a.lng);
  const x=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return 12742*Math.asin(Math.sqrt(Math.min(1,x)));
}
function formatDistance(km) { return km < 1 ? `${Math.round(km*1000)} 米` : `${km.toFixed(1)} 公里`; }
function roadKey(c) { return `${c.lng},${c.lat}|${c.name}|${c.description}`; }
function storageUnavailable() {
  const note = '浏览器禁用了会话存储，密钥仅在本页使用，刷新后需要重新输入。';
  $('credential-status').textContent = note; $('security-storage-note').textContent = note;
}
function readCode(key) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (saved?.key === key && typeof saved.code === 'string') return saved.code;
    sessionStorage.removeItem(SESSION_KEY);
  } catch { storageUnavailable(); }
  return '';
}
function saveCode(key, code) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({key, code})); }
  catch { storageUnavailable(); }
}
function setPanel(name, open) {
  for (const panel of ['list', 'settings']) {
    const show = panel === name && open;
    $(panel === 'list' ? 'camera-panel' : 'settings-panel').hidden = !show;
    $('toggle-' + panel).setAttribute('aria-expanded', String(show));
  }
}
function paintDetail(camera) {
  const road = roadCache.get(roadKey(camera)) || camera.road || classifyRoad(camera);
  $('detail-title').textContent = camera.name;
  const nearby = road.nearbyRoads.map(r => `${r.name} · 约 ${Math.round(r.distance)} 米${r.direction ? ' · ' + r.direction : ''}`).join('\n');
  const amapState = road.amapStatus || (roadRequests >= 100 ? '本页辅助查询已达 100 次上限，请刷新后再查' : '等待高德辅助查询');
  const fields = [
    ['位置 / 方向',camera.description], ['直线距离',formatDistance(camera.distance)],
    ['主辅路判断',roadLabel(road) + ' · ' + road.reason], ['高架 / 地面',road.level],
    ['高德辅助信息',amapState], ['高德附近道路',nearby],
    ['高德附近路口',road.crossings.join('\n')], ['高德地址',road.address]
  ];
  $('detail-body').innerHTML = fields.filter(([,v])=>v).map(([k,v])=>`<p><b>${escapeHtml(k)}</b><br>${escapeHtml(v).replace(/\n/g,'<br>')}</p>`).join('')
    + '<details><summary>来源记录</summary>'
    + [['类别',camera.category],['来源日期',camera.date],['来源编辑时间',camera.editTime]].filter(([,v])=>v).map(([k,v])=>`<p>${escapeHtml(k)}：${escapeHtml(v)}</p>`).join('')
    + (camera.url ? `<p><a href="${escapeHtml(camera.url)}" target="_blank" rel="noopener noreferrer">在进京365查看详情 ↗</a></p>` : '<p>来源未提供可用详情链接</p>')
    + '</details><p>来源坐标系尚待核验；附近道路与距离仅作辅助，不能确定实际车道或高架层级。</p>';
}
function showDetail(camera) {
  selected = camera.id; priorityCamera = camera;
  renderList(); paintDetail(camera);
  if (!$('detail').open) $('detail').showModal();
  queueRoadLookup();
}
function renderList() {
  $('count').textContent = center ? visible.length : '—';
  $('list-caption').textContent = center ? `共 ${visible.length} 条 · 按直线距离排序` : '请选择查询位置';
  const list=$('list'); list.replaceChildren();
  if (!center || !visible.length) {
    const empty=document.createElement('div'); empty.className='empty';
    empty.textContent=center ? '附近没有匹配的探头，试试在设置中扩大范围。' : '定位或手动选点后，即可查看附近探头。';
    list.append(empty); return;
  }
  visible.forEach((camera,index)=>{
    const item=document.createElement('button'); item.className='item'+(camera.id===selected?' active':'');
    item.innerHTML=`<span class="item-index">${String(index+1).padStart(2,'0')}</span><span class="item-main"><b>${escapeHtml(camera.name)}</b><small>${escapeHtml(roadLabel(camera.road))}</small></span><span class="item-distance">${formatDistance(camera.distance)} ›</span>`;
    item.addEventListener('click',()=>{ if(map) map.panTo([camera.lng,camera.lat]); showDetail(camera); }); list.append(item);
  });
}
function render() {
  visible = center ? cameras.map(c=>({...c,road:roadCache.get(roadKey(c)) || classifyRoad(c),distance:distance(center,c)})).filter(c=>c.distance<=Number($('radius').value)).sort((a,b)=>a.distance-b.distance) : [];
  renderList();
  if (!map || !window.AMap) return;
  queueRoadLookup();
  clusters.forEach(c => c.setMap(null)); clusters = [];
  for (const kind of ['major','other','unknown']) {
    const group=visible.filter(c => c.road.kind === kind); if (!group.length) continue;
    const points=group.map(c=>({lnglat:[c.lng,c.lat],camera:c}));
    const color={major:'#d94747',other:'#d98a54',unknown:'#829188'}[kind];
    const cluster=new AMap.MarkerCluster(map,points,{gridSize:60,renderMarker(context){
      const el=document.createElement('div'); el.style.cssText=`width:20px;height:20px;border:3px solid white;border-radius:50%;background:${color};box-shadow:0 2px 6px #0005`;
      context.marker.setContent(el); context.marker.setOffset(new AMap.Pixel(-10,-10));
    }});
    cluster.on('click', e=>{ if(e.clusterData?.length===1) showDetail(e.clusterData[0].camera); else if(e.clusterData?.length>1) map.setZoomAndCenter(Math.min(map.getZoom()+2,20),e.lnglat); });
    clusters.push(cluster);
  }
}
async function queueRoadLookup() {
  if (roadQueueRunning || !geocoder || roadRequests >= 100) return;
  roadQueueRunning = true;
  const eligible = c => c && !roadCache.has(roadKey(c)) && !roadPending.has(roadKey(c));
  try {
    while (geocoder && roadRequests < 100) {
      const camera = eligible(priorityCamera) ? priorityCamera : visible.find(eligible);
      priorityCamera = null;
      if (!camera) break;
      const key = roadKey(camera); roadPending.add(key); roadRequests++;
      $('road-status').textContent = `高德道路辅助查询中 · 本页已请求 ${roadRequests} / 100 次`;
      const result = await new Promise(resolve => {
        let done = false;
        const finish = value => { if (!done) { done=true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => finish(null), 8000);
        try { geocoder.getAddress([camera.lng,camera.lat], (status, data) => finish(status === 'complete' && data?.regeocode ? data.regeocode : null)); }
        catch { finish(null); }
      });
      roadPending.delete(key);
      const road = classifyRoad(camera, result?.roads, result || {});
      road.amapStatus = result ? '已获取高德附近道路，供辅助核对' : '高德查询失败或超时；保留来源判断，尚未完成道路核对';
      roadCache.set(key, road);
      render();
      if ($('detail').open && selected === camera.id) paintDetail(camera);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    $('road-status').textContent = roadRequests >= 100 ? '本页高德辅助查询已达 100 次上限，未查询点仍需核对。' : `当前范围辅助查询完成 · 本页已请求 ${roadRequests} / 100 次`;
  } finally { roadQueueRunning = false; }
}
function setCenter(pos, type, accuracy) {
  center=pos;
  if(map) {
    if(centerMarker) map.remove(centerMarker);
    if(accuracyCircle) {map.remove(accuracyCircle); accuracyCircle=null;}
    centerMarker=new AMap.Marker({position:[pos.lng,pos.lat],title:type==='manual'?'手动查询中心':'当前位置',map});
    if(type==='gps' && Number.isFinite(accuracy)) accuracyCircle=new AMap.Circle({center:[pos.lng,pos.lat],radius:accuracy,strokeColor:'#478dcc',strokeOpacity:.5,fillColor:'#7bb1e2',fillOpacity:.14,map});
    map.setZoomAndCenter(14,[pos.lng,pos.lat]);
  }
  $('location-status').textContent=type==='manual'?'以手动选点查询':`当前位置${Number.isFinite(accuracy)?` · 定位精度约 ${Math.round(accuracy)} 米`:''}${pos.approximate?' · 近似转换':''}`;
  $('location-time').textContent=type==='gps'?`定位时间 ${new Date().toLocaleTimeString('zh-CN')}${pos.approximate?'；在线坐标转换暂不可用，已使用本地近似转换，显示的定位精度不包含转换误差。':''}`:'';
  render();
}
function locate() {
  const request = ++locationRequest;
  if (!map) { $('location-status').textContent='请先加载地图'; return; }
  $('location-status').textContent='正在定位…';
  if (!navigator.geolocation) { $('location-status').textContent='浏览器不支持定位，请在设置中手动选点'; return; }
  navigator.geolocation.getCurrentPosition(async pos=>{
    if (request !== locationRequest) return;
    try {
      const p = await gpsToAmap(pos.coords.longitude, pos.coords.latitude, (...args)=>AMap.convertFrom(...args));
      if (request !== locationRequest) return;
      choosing=false; $('map-instruction').hidden=true;
      currentPosition={...p,accuracy:pos.coords.accuracy}; setCenter(currentPosition,'gps',currentPosition.accuracy);
    } catch (e) { if (request === locationRequest) $('location-status').textContent=e.message; }
  },err=>{ if (request === locationRequest) $('location-status').textContent=({1:'未允许定位，可在设置中手动选点',2:'无法获取位置，请重新定位或手动选点',3:'定位超时，请重试或手动选点'}[err.code]||'定位失败，请重试'); },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
}
async function loadSdk(key) {
  if (window.AMap) return;
  await new Promise((resolve,reject)=>{
    const script=document.createElement('script'); script.id='amap-sdk';
    let settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const timer=setTimeout(()=>finish(Error('地图加载超时，请检查网络后重试。')),15000);
    script.src=`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.MarkerCluster,AMap.Geocoder`;
    script.onload=()=>finish(window.AMap ? null : Error('地图 SDK 加载失败，请检查 Key 与安全密钥。'));
    script.onerror=()=>finish(Error('地图 SDK 加载失败，请检查网络后重试。'));
    document.head.append(script);
  });
}
async function loadMap(securityCode = '') {
  if(loadingMap) return false;
  loadingMap=true; $('map-error').hidden=true;
  try {
    const response=await fetch(appUrl('api/config'),{cache:'no-store'});
    if (!response.ok) throw Error('地图配置获取失败，请重试。');
    const config=await response.json();
    if(!config.mapKey) throw Error('尚未配置高德 JS API Key，请参照 README 配置。');
    const code=securityCode || (activeKey === config.mapKey ? activeCode : '') || readCode(config.mapKey);
    usesProxy=!!config.securityProxy;
    $('clear-security').hidden=usesProxy; $('change-security').hidden=usesProxy;
    if(usesProxy) {
      window._AMapSecurityConfig={serviceHost: appUrl('_AMapService')};
      $('credential-status').textContent='当前使用服务端安全代理，无需输入密钥。';
    } else if(code) {
      window._AMapSecurityConfig={securityJsCode:code}; activeCode=code;
    } else {
      $('security-form').hidden=false; $('location-status').textContent='输入安全密钥以加载地图'; return false;
    }
    activeKey=config.mapKey; $('security-form').hidden=true;
    await loadSdk(config.mapKey);
    if(map) {clusters.forEach(c=>c.setMap(null)); clusters=[]; map.destroy(); centerMarker=null; accuracyCircle=null;}
    geocoder = new AMap.Geocoder({radius:100, extensions:'all'});
    map=new AMap.Map('map',{zoom:10,center:[116.397428,39.90923],viewMode:'2D'});
    map.on('click',e=>{ if(choosing) { choosing=false; $('map-instruction').hidden=true; setCenter({lng:e.lnglat.lng,lat:e.lnglat.lat},'manual'); } });
    if (!usesProxy) saveCode(config.mapKey,code);
    if(center) setCenter(center,'manual'); else render();
    return true;
  } catch(e) {
    $('security-form').hidden=true; $('map-error-text').textContent=e.message; $('map-error').hidden=false;
    $('location-status').textContent='地图加载失败'; return false;
  } finally {loadingMap=false;}
}
async function loadData(refresh=false) {
  $('refresh').disabled=true;
  try {
    const response=await fetch(appUrl(refresh?'api/cameras/refresh':'api/cameras'),{method:refresh?'POST':'GET',cache:'no-store'});
    const data=await response.json();
    if(!response.ok && !data.fetchedAt) throw Error(data.warning || '数据加载失败，请稍后刷新重试。');
    cameras=data.cameras;
    $('data-time').textContent=`应用获取时间：${new Date(data.fetchedAt).toLocaleString('zh-CN')}${data.stale?'（旧缓存）':''}`;
    $('notice').textContent=[data.warning, '来源坐标系尚未核验，地图位置仅供参考。'].filter(Boolean).join(' ');
    $('data-indicator').hidden=!data.warning && !data.stale;
    render();
  } catch(e) {
    $('notice').textContent=e.message; $('data-time').textContent='数据获取失败，请点击刷新重试'; $('data-indicator').hidden=false;
    if(!cameras.length) { $('list').innerHTML='<div class="empty">无法获取探头数据，请在设置中刷新重试。</div>'; $('count').textContent='—'; }
  } finally {$('refresh').disabled=false;}
}
function clearSecurity() {
  if (loadingMap) return;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { storageUnavailable(); }
  activeCode=''; $('security-code').value='';
  // AMap retains authentication state in its SDK: reload before using a new code.
  location.reload();
}
for (const name of ['list','settings']) {
  $('toggle-'+name).addEventListener('click',()=>setPanel(name,$('toggle-'+name).getAttribute('aria-expanded') !== 'true'));
  $('close-'+name).addEventListener('click',()=>{setPanel(name,false);$('toggle-'+name).focus();});
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')setPanel('',false);});
$('radius').addEventListener('change',render);
$('refresh').addEventListener('click',()=>loadData(true));
$('locate').addEventListener('click',locate);
$('recenter').addEventListener('click',()=>{ if(currentPosition) { ++locationRequest; choosing=false; $('map-instruction').hidden=true; setCenter(currentPosition,'gps',currentPosition.accuracy); } else locate(); });
$('select').addEventListener('click',()=>{ if(!map) return; ++locationRequest; setPanel('',false); choosing=true; $('map-instruction').hidden=false; });
$('cancel-select').addEventListener('click',()=>{choosing=false;$('map-instruction').hidden=true;});
$('retry-map').addEventListener('click',async()=>{ if(await loadMap()) locate(); });
$('change-security').addEventListener('click',clearSecurity);
$('clear-security').addEventListener('click',clearSecurity);
$('security-form').addEventListener('submit',async e=>{e.preventDefault();const code=$('security-code').value.trim();if(!code)return;$('security-code').value='';if(await loadMap(code))locate();});
$('close-detail').addEventListener('click',()=>$('detail').close());
loadData(); loadMap().then(loaded=>{ if(loaded) locate(); });
