import { classifyRoad } from './road.js';
import { gpsToAmap } from './location.js';
import { DIRECTIONS, groupJunctions, junctionMarkerHTML } from './junction.js';
import { parsePoint, createPlan, runPlan } from './routing.js';
const $ = id => document.getElementById(id);
// Keep assets, APIs and the AMap proxy under the same reverse-proxy prefix.
const appBase = new URL('.', location.href);
const appUrl = path => new URL(path, appBase).href;
const SESSION_KEY = 'jingtu.amap.session';
const JUNCTION_EXPAND_ZOOM = 16;
// Permit categories follow source aa codes, independently of road/location remarks.
const PERMIT_TYPES = {
  inner: {label:'需要六环内进京证', color:'#d94747'},
  outer: {label:'需要六环外进京证', color:'#3984c6'},
  peak: {label:'早晚高峰限制进京证', color:'#d98a54'}
};
function permitType(camera) {
  const code = String(camera.category ?? '').trim();
  return PERMIT_TYPES[code === '6' ? 'outer' : code === '1' ? 'peak' : 'inner'];
}
const activeCamera = camera => String(camera.category ?? '').trim() !== '4';
function peakRestrictedAt(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:'Asia/Shanghai',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(date).map(p=>[p.type,p.value]));
  const minutes = Number(parts.hour)*60 + Number(parts.minute);
  return !['Sat','Sun'].includes(parts.weekday) && (minutes>=420 && minutes<540 || minutes>=1020 && minutes<1200);
}
function selectedPeakStatus() {
  const value=$('peak-status').value || 'auto';
  return value === 'auto' ? (peakRestrictedAt() ? 'yes' : 'no') : value;
}
let lastAutoPeakStatus = selectedPeakStatus();
function updatePeakClock() {
  const status=selectedPeakStatus();
  $('peak-clock').textContent=($('peak-status').value || 'auto') === 'auto'
    ? `自动判断：当前为${status==='yes'?'高峰期':'非高峰期'}（北京时间；按周一至周五，节假日调休请手动修正）`
    : `手动选择：${status==='yes'?'高峰期':'非高峰期'}`;
  if(status!==lastAutoPeakStatus) {lastAutoPeakStatus=status;changePassageSettings();}
}
function passage(camera) {
  const permit = $('permit-status').value || 'none';
  const peak = selectedPeakStatus();
  const type = permitType(camera);
  if (type === PERMIT_TYPES.peak) {
    if (peak === 'yes') return {allowed:false, label:'不可通行：当前为受限高峰时段'};
    if (!['inner','outer'].includes(permit)) return {allowed:false, label:'不可通行：需要有效进京证'};
    if (peak !== 'no') return {allowed:false, label:'需确认：是否为受限高峰时段'};
    return {allowed:true, label:'可通行（按所选证件与时段）'};
  }
  const allowed = permit === 'inner' || type === PERMIT_TYPES.outer && permit === 'outer';
  return {allowed, label:allowed ? '可通行（按所选证件与时段）' : `不可通行：${type.label}`};
}
function changePassageSettings() {
  lastAutoPeakStatus=selectedPeakStatus();
  cameraVersion++;
  clearRoute();
  $('route-status').textContent='进京证或高峰时段已更改，请重新规划路线。';
  render();
  const current = cameras.find(c=>c.id===selected);
  if (current && $('detail').open) paintDetail({...current,distance:center?distance(center,current):0});
}


const roadCache = new Map(), roadPending = new Set();
let geocoder, roadQueueRunning = false, roadRequests = 0, priorityCamera = null;
let map, cameraMarkers = [], centerMarker, accuracyCircle, currentPosition, center;
let cameraDataLoaded = false;
let cameras = [], visible = [], selected = null, choosing = false, loadingMap = false;
let activeCode = '', activeKey = '', usesProxy = false;
let junctionMarkers = [], junctionGroups = [], selectedJunction = null, selectedJunctionMembers = [];
let routeEnabled = false, routeMaxRegions = 32, routeBusy = false, routePick = '', routePlan = null, routeOverlays = [], cameraVersion = 0, routeVersion = 0;
// Keep labels separate from coordinates; editing a label invalidates its selection.
const routePlaces = Object.fromEntries(['origin','destination'].map(which=>[which,{version:0,timer:null,selection:null}]));
const routePointMarkers = {origin:null,destination:null};
function removeRoutePointMarker(which) {
  routePointMarkers[which]?.setMap(null);
  routePointMarkers[which]=null;
}
function showRoutePointMarker(which, fit=false) {
  removeRoutePointMarker(which);
  if(!map) return;
  let point;
  try { point=routePoint(which); } catch { return; }
  const name=which==='origin'?'起点 A':'终点 B';
  const content=document.createElement('div');
  content.className='route-point-marker '+which;
  const badge=document.createElement('b'), label=document.createElement('span');
  badge.textContent=which==='origin'?'A':'B';
  label.textContent=`${name} · ${$('route-'+which).value.trim()}`;
  content.append(badge); content.append(label);
  routePointMarkers[which]=new AMap.Marker({map,position:[point.lng,point.lat],content,anchor:'bottom-center',zIndex:220,title:label.textContent});
  if(fit) map.setFitView(Object.values(routePointMarkers).filter(Boolean),false,[100,100,80,80],16);
}
function cancelPlaceSearch(which) {
  const state=routePlaces[which];
  state.version++; clearTimeout(state.timer);
  $('route-'+which+'-results').replaceChildren();
  $('route-'+which+'-results').hidden=true;
  $('route-'+which+'-search-status').textContent='';
  return state.version;
}
function setRoutePoint(which, point, label='') {
  cancelPlaceSearch(which); clearRoute();
  routePick=''; $('map-instruction').hidden=true;
  const value=label || `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
  routePlaces[which].selection={value,point:{lng:point.lng,lat:point.lat}};
  $('route-'+which).value=value;
  $('route-'+which+'-search-status').textContent=label ? `已选择：${point.lng.toFixed(6)},${point.lat.toFixed(6)}` : '';
  $('route-status').textContent='起终点已更新，请点击规划路线。';
  showRoutePointMarker(which,true);
}
function routePoint(which) {
  const value=$('route-'+which).value.trim(), selection=routePlaces[which].selection;
  if(selection && selection.value===value) return selection.point;
  try { return parsePoint(value); }
  catch { throw Error(`请从搜索结果选择${which==='origin'?'起点':'终点'}，也可输入北京周边坐标或在地图上选点。`); }
}
function searchRoutePlaces(which) {
  const version=cancelPlaceSearch(which), state=routePlaces[which];
  state.selection=null; clearRoute();
  showRoutePointMarker(which,true);
  const keyword=$('route-'+which).value.trim(), status=$('route-'+which+'-search-status');
  $('route-status').textContent='起终点已更改，请重新选择地点并规划。';
  if(!keyword) return;
  try { parsePoint(keyword); return; } catch {}
  if(!map || !window.AMap?.PlaceSearch) {status.textContent='请先加载地图后搜索地点。';return;}
  status.textContent='等待搜索…';
  state.timer=setTimeout(()=>{
    if(version!==state.version || routeBusy) return;
    status.textContent='正在搜索高德地点…';
    let settled=false, timeout;
    const finish=(resultStatus,result)=>{
      if(settled) return; settled=true; clearTimeout(timeout);
      if(version!==state.version || routeBusy) return;
      const pois=resultStatus==='complete' ? (result?.poiList?.pois || []).flatMap(poi=>{
        try { const point=parsePoint(`${poi.location?.lng},${poi.location?.lat}`);return [{poi,point}]; } catch {return [];}
      }) : [];
      status.textContent=pois.length?'请选择地点（仅支持北京周边）':resultStatus==='error'?'地点搜索失败，请稍后重试或在地图上选点。':'未找到北京周边地点，请换个关键词或在地图上选点。';
      const list=$('route-'+which+'-results'); list.hidden=!pois.length;
      for(const {poi,point} of pois) {
        const button=document.createElement('button'); button.type='button'; button.className='place-result';
        button.textContent=[poi.name,poi.cityname,poi.adname,typeof poi.address==='string'?poi.address:''].filter(Boolean).join(' · ');
        button.addEventListener('click',()=>{
          if(routeBusy || version!==state.version) return;
          setRoutePoint(which,point,poi.name);
        });
        list.append(button);
      }
    };
    timeout=setTimeout(()=>finish('error'),10000); state.timer=timeout;
    try { new AMap.PlaceSearch({city:'北京',citylimit:false,pageSize:6,extensions:'base'}).search(keyword,finish); }
    catch { finish('error'); }
  },350);
}
async function useRouteLocation(which) {
  if(routeBusy) return;
  const version=cancelPlaceSearch(which), state=routePlaces[which];
  const status=$('route-'+which+'-search-status');
  if(!map) {status.textContent='请先加载地图。';return;}
  if(!navigator.geolocation) {status.textContent='浏览器不支持定位，请搜索地点或在地图上选点。';return;}
  status.textContent='正在获取当前位置，请允许浏览器定位…';
  try {
    const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000,maximumAge:0}));
    if(version!==state.version || routeBusy) return;
    const point=await gpsToAmap(position.coords.longitude,position.coords.latitude,(...args)=>AMap.convertFrom(...args));
    if(version!==state.version || routeBusy) return;
    parsePoint(`${point.lng},${point.lat}`);
    setRoutePoint(which,point,'当前位置');
    if(point.approximate) status.textContent+=' · 已使用近似坐标转换';
  } catch(error) {
    if(version!==state.version || routeBusy) return;
    status.textContent=error.code===1?'定位权限被拒绝，请开启权限或搜索地点。':error.code===3?'定位超时，请重试或搜索地点。':`无法使用当前位置：${error.message || '定位失败'}，请搜索地点或在地图上选点。`;
  }
}
function clearRoute() {
  routePlan = null;
  routeOverlays.forEach(m=>m.setMap(null)); routeOverlays=[];
  $('route-continue').hidden=true;
  $('route-result').hidden=true;
}
function reportRoute(message, state='failure') {
  $('route-status').textContent=message;
  $('route-result').hidden=false;
  $('route-result').setAttribute('data-state',state);
  $('route-result').textContent=(state==='success'?'已找到通过检查的避让路线':state==='pending'?'正在规划与检查路线…':'未找到避让路线，未显示行驶路线')+' · 查看详情';
}
function drawRoute(plan) {
  routeOverlays.forEach(m=>m.setMap(null)); routeOverlays=[];
  if(plan.reason!=='success' || plan.hits.length || !plan.route) return;
  for (const path of plan.route.paths) routeOverlays.push(new AMap.Polyline({map,path,strokeColor:'#245641',strokeWeight:6,strokeOpacity:.85}));
  map.setFitView([...routeOverlays,...Object.values(routePointMarkers).filter(Boolean)]);
}
function routeSummary(plan) {
  const reasons={endpoint:'起点或终点落入所需避让区域，请调整位置。',success:'已找到通过当前证件与时段下已知受限点位检查的路线。',budget:'已达到本轮规划次数上限，仍未找到符合条件的路线。',time:'已达到本轮时间上限，仍未找到符合条件的路线。',regions:'已达到本站避让区域数量上限，仍未找到符合条件的路线。',unchanged:'路线重复或避让未生效，已停止重算。'};
  return `${reasons[plan.reason]} 累计发起 ${plan.calls} 次高德请求，复用 ${plan.cacheHits} 次缓存或并发结果；已累积 ${plan.areas.size} / ${plan.maxRegions} 个避让区域。${plan.route && plan.reason==='success'?` 路程 ${(plan.route.distance/1000).toFixed(1)} 公里，预计 ${Math.ceil(plan.route.duration/60)} 分钟。`:''}${plan.hits.length?` 最后一次检查仍接近 ${plan.hits.length} 条已知点位记录，未显示该路线。`:''}`;
}
async function planRoute(continuing = false) {
  if(routeBusy) return;
  updatePeakClock();
  if(!map || !routeEnabled) { reportRoute('请先加载地图；站点须配置高德 Web 服务 Key 才能规划路线。');return; }
  if(!cameraDataLoaded && !cameras.length) { reportRoute('探头数据未加载，请在设置中刷新后再试。');return; }
  try {
    const origin=routePoint('origin'), destination=routePoint('destination');
    for(const which of ['origin','destination']) showRoutePointMarker(which);
    if(!continuing || !routePlan || routeVersion!==cameraVersion || JSON.stringify(origin)!==JSON.stringify(routePlan.origin) || JSON.stringify(destination)!==JSON.stringify(routePlan.destination)) {
      clearRoute(); routePlan=createPlan(origin,destination,cameras.filter(c=>!passage(c).allowed),routeMaxRegions,{allowEmpty:true}); routeVersion=cameraVersion;
      routePlan.passageKey=($('permit-status').value || 'none')+':'+selectedPeakStatus();
    }
    if(continuing && !routePlan.resumable) return;
    const plan=routePlan;
    routeOverlays.forEach(m=>m.setMap(null)); routeOverlays=[];
    for(const which of ['origin','destination']) cancelPlaceSearch(which);
    routeBusy=true; routePick=''; choosing=false; $('map-instruction').hidden=true;
    $('route-continue').hidden=true;
    for(const id of ['route-start','route-location-origin','route-location-destination','route-current','route-pick-origin','route-pick-destination','route-clear','route-origin','route-destination','refresh','permit-status','peak-status']) $(id).disabled=true;
    await runPlan(plan,async input=>{
      const response=await fetch(appUrl('api/route'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),cache:'no-store',signal:AbortSignal.timeout(15000)});
      const result=await response.json();
      if(!response.ok) throw Error(result.error || '路线规划失败，请稍后重试。');
      return result;
    },p=>{reportRoute(`正在规划与本地检查… 已发起 ${p.calls} 次高德请求，复用 ${p.cacheHits} 次；累积 ${p.areas.size} 个避让区域。`,'pending');});
    if(routeVersion!==cameraVersion || plan.passageKey!==($('permit-status').value || 'none')+':'+selectedPeakStatus()) {clearRoute();reportRoute('规划期间探头数据已更新或通行条件已改变，请重新规划。');return;}
    drawRoute(plan);
    reportRoute(routeSummary(plan),plan.reason==='success'?'success':'failure');
    $('route-continue').hidden=!plan.resumable;
  } catch(e) {
    routeOverlays.forEach(m=>m.setMap(null)); routeOverlays=[];
    $('route-continue').hidden=true;
    reportRoute(`${e.message} 本次未取得通过避让检查的路线。`);
  } finally {
    routeBusy=false;
    for(const id of ['route-start','route-location-origin','route-location-destination','route-current','route-pick-origin','route-pick-destination','route-clear','route-origin','route-destination','refresh','permit-status','peak-status']) $(id).disabled=false;
  }
}
function pickRoutePoint(which) {
  if(!map || routeBusy)return;
  for(const endpoint of ['origin','destination']) cancelPlaceSearch(endpoint);
  routePick=which; choosing=false; setPanel('',false);
  $('map-instruction').hidden=false;
  $('instruction-text').textContent=`点击地图选择${which==='origin'?'起点 A':'终点 B'}`;
}
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
  for (const panel of ['list', 'settings', 'route']) {
    const show = panel === name && open;
    $(panel === 'list' ? 'camera-panel' : panel+'-panel').hidden = !show;
    $('toggle-' + panel).setAttribute('aria-expanded', String(show));
  }
}
function paintDetail(camera) {
  const road = roadCache.get(roadKey(camera)) || camera.road || classifyRoad(camera);
  $('detail-title').textContent = camera.name;
  const nearby = road.nearbyRoads.map(r => `${r.name} · 约 ${Math.round(r.distance)} 米${r.direction ? ' · ' + r.direction : ''}`).join('\n');
  const amapState = road.amapStatus || (roadRequests >= 100 ? '本页辅助查询已达 100 次上限，请刷新后再查' : '等待高德辅助查询');
  const fields = [
    ['当前通行判断',passage(camera).label], ['进京证分类',permitType(camera).label], ['位置 / 方向',camera.description], ['直线距离',formatDistance(camera.distance)],
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
  selectedJunction = null;
  selected = camera.id; priorityCamera = camera;
  renderList(); paintDetail(camera);
  if (!$('detail').open) $('detail').showModal();
  queueRoadLookup();
}
function showJunctionDetail(group) {
  selectedJunction = group.id; selected = null;
  selectedJunctionMembers = group.members.map(c => c.id);
  $('detail-title').textContent = group.name;
  const directions = DIRECTIONS.filter(side => group.sides[side]).map(side => `${side}侧 ${group.sides[side]} 条`).join('、');
  $('detail-body').innerHTML = `<div class="junction-detail-preview">${junctionMarkerHTML(group)}</div>`
    + `<p><b>同路口探头 · ${group.members.length} 条记录（推测）</b><br>当前查询范围内，均距这个高德路口中心 ${group.radius} 米以内。</p>`
    + `<p><b>探头所在方位</b><br>${escapeHtml(directions || '待确认')}${group.unknown ? `；${group.unknown} 条方位待确认` : ''}</p>`
    + '<p>上北下南、左西右东。紫色方位点表示该侧有来源记录，空心表示尚无匹配记录；方位按坐标相对路口计算，中心 15 米内仅采用来源明确的路口方位。它不代表拍摄朝向或受监控的行驶方向。</p>'
    + '<p>以下保留每条来源记录；数量不代表已核实的独立设备数。点击可查看通行方向、道路分类和来源详情。</p>';
  for (const camera of group.members) {
    const button = document.createElement('button'); button.className = 'junction-member';
    button.innerHTML = `<b>${escapeHtml(camera.side === '待确认' ? '方位待确认' : camera.side + '侧')} · 距路口 ${Math.round(camera.junctionDistance)} 米</b><span>${escapeHtml(camera.name)} · ${escapeHtml(permitType(camera).label)} · ${escapeHtml(passage(camera).label)}</span>`;
    button.addEventListener('click', () => showDetail(camera));
    $('detail-body').append(button);
  }
  const note = document.createElement('p');
  note.textContent = '按附近路口和距离推测分组，尚未实地核验；空心方位不表示没有摄像头。高架上、高速、匝道等明确描述的记录保留单点。';
  $('detail-body').append(note);
  renderList();
  if (!$('detail').open) $('detail').showModal();
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
    item.innerHTML=`<span class="item-index">${String(index+1).padStart(2,'0')}</span><span class="item-main"><b>${escapeHtml(camera.name)}</b><small>${escapeHtml(permitType(camera).label)} · ${escapeHtml(roadLabel(camera.road))}</small><small class="passage-status ${passage(camera).allowed?'allowed':'blocked'}">${escapeHtml(passage(camera).label)}</small></span><span class="item-distance">${formatDistance(camera.distance)} ›</span>`;
    item.addEventListener('click',()=>{ if(map) map.panTo([camera.lng,camera.lat]); showDetail(camera); }); list.append(item);
  });
}
function render() {
  visible = center ? cameras.map(c=>({...c,road:roadCache.get(roadKey(c)) || classifyRoad(c),distance:distance(center,c)})).filter(c=>c.distance<=Number($('radius').value)).sort((a,b)=>a.distance-b.distance) : [];
  renderList();
  if (!map || !window.AMap) return;
  queueRoadLookup();
  renderMapMarkers();
}
function renderMapMarkers() {
  if (!map || !window.AMap) return;
  cameraMarkers.forEach(marker => marker.setMap(null)); cameraMarkers = [];
  junctionMarkers.forEach(marker => marker.setMap(null)); junctionMarkers = [];
  const grouped = groupJunctions(visible, $('junction-enabled').checked);
  junctionGroups = grouped.groups;
  const expanded = map.getZoom() >= JUNCTION_EXPAND_ZOOM;
  $('junction-legend').hidden = expanded || !junctionGroups.length;
  $('junction-status').textContent = expanded
    ? `已放大：显示 ${visible.length} 个探头小点；缩小后显示路口分组。`
    : `当前范围：${junctionGroups.length} 个合并路口 · ${grouped.singles.length} 个独立点。放大可展开路口内的探头。`;
  for (const group of expanded ? [] : junctionGroups) {
    const el = document.createElement('button'); el.className = 'junction-marker';
    const sides = DIRECTIONS.filter(side => group.sides[side]).map(side => side + '侧').join('、');
    const title = `${group.name}，${group.members.length} 条探头记录；${sides || '方位待确认'}${group.unknown ? '，部分方位待确认' : ''}。方位为位置推测`;
    el.setAttribute('aria-label', title); el.title = title;
    el.innerHTML = junctionMarkerHTML(group);
    el.addEventListener('click', event => { event.stopPropagation(); showJunctionDetail(group); });
    junctionMarkers.push(new AMap.Marker({position:[group.lng,group.lat],map,content:el,offset:new AMap.Pixel(-18,-18),zIndex:140,title}));
  }
  if (selectedJunction && $('detail').open) {
    const group = junctionGroups.find(g => g.id === selectedJunction)
      || junctionGroups.find(g => g.members.filter(c => selectedJunctionMembers.includes(c.id)).length >= 2);
    if (group) showJunctionDetail(group);
    else { selectedJunction = null; $('detail').close(); }
  }
  for (const camera of expanded ? visible : grouped.singles) {
    const color=permitType(camera).color;
    const el=document.createElement('button'); el.className='camera-marker';
    const title = `${camera.name}，${permitType(camera).label}，${passage(camera).label}，${roadLabel(camera.road)}`;
    el.title=title; el.setAttribute('aria-label',title);
    el.innerHTML=`<span class="camera-dot" style="background:${color};${passage(camera).allowed?'box-shadow:0 0 0 3px #2b884b':''}" aria-hidden="true"></span>`;
    el.addEventListener('click',event=>{event.stopPropagation();showDetail(camera);});
    cameraMarkers.push(new AMap.Marker({position:[camera.lng,camera.lat],map,content:el,offset:new AMap.Pixel(-12,-12),zIndex:130,title}));
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
// A generation invalidates callbacks from stopped watches and older conversions.
let watchId = null, locationGeneration = 0, locationSequence = 0;
let following = false, lastFixAt = 0, lastFixTimestamp = 0;
function stopLocationWatch() {
  locationGeneration++;
  if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
  watchId = null;
}
function setCenter(pos, type, accuracy, initial = true) {
  center = pos;
  if (type === 'manual') { following = false; stopLocationWatch(); }
  if (map) {
    if (centerMarker) map.remove(centerMarker);
    if (accuracyCircle) { map.remove(accuracyCircle); accuracyCircle = null; }
    centerMarker = new AMap.Marker({position:[pos.lng,pos.lat],title:type==='manual'?'手动查询中心':'当前位置',map});
    if (type === 'gps' && Number.isFinite(accuracy)) accuracyCircle = new AMap.Circle({center:[pos.lng,pos.lat],radius:accuracy,strokeColor:'#478dcc',strokeOpacity:.5,fillColor:'#7bb1e2',fillOpacity:.14,map});
    if (initial) map.setZoomAndCenter(14,[pos.lng,pos.lat]);
    else if (!choosing) map.panTo([pos.lng,pos.lat]);
  }
  $('location-status').textContent = type === 'manual' ? '以手动选点查询' : `当前位置 · 实时定位中${Number.isFinite(accuracy)?` · 精度约 ${Math.round(accuracy)} 米`:''}${pos.approximate?' · 近似转换':''}`;
  $('location-time').textContent = type === 'gps' ? `定位时间 ${new Date(pos.timestamp || Date.now()).toLocaleTimeString('zh-CN')}${pos.approximate?'；在线坐标转换暂不可用，已使用本地近似转换，显示的定位精度不包含转换误差。':''}` : '';
  render();
  if ($('detail').open && selected !== null) {
    const camera = visible.find(c => c.id === selected);
    if (camera) paintDetail(camera);
    else { $('detail').close(); selected = null; }
  }
}
function locate() {
  if (!map) { $('location-status').textContent = '请先加载地图'; return; }
  stopLocationWatch();
  following = true;
  routePick='';
  choosing = false; $('map-instruction').hidden = true;
  $('location-status').textContent = '定位中，请允许浏览器获取位置…';
  if (!navigator.geolocation) { following = false; $('location-status').textContent = '浏览器不支持定位，请手动选择地图位置。'; return; }
  const generation = locationGeneration;
  let initial = true;
  lastFixAt = 0; lastFixTimestamp = 0;
  watchId = navigator.geolocation.watchPosition(async pos => {
    if (generation !== locationGeneration || !following) return;
    if (pos.timestamp < lastFixTimestamp) return;
    lastFixTimestamp = pos.timestamp;
    const sequence = ++locationSequence;
    try {
      const p = await gpsToAmap(pos.coords.longitude, pos.coords.latitude, (...args) => AMap.convertFrom(...args));
      if (generation !== locationGeneration || sequence !== locationSequence || !following) return;
      lastFixAt = Date.now();
      currentPosition = {...p,accuracy:pos.coords.accuracy,timestamp:pos.timestamp};
      setCenter(currentPosition,'gps',currentPosition.accuracy,initial);
      initial = false;
    } catch (e) {
      if (generation === locationGeneration && sequence === locationSequence) $('location-status').textContent = `${e.message}，周边探头暂未更新。`;
    }
  }, err => {
    if (generation !== locationGeneration) return;
    locationSequence++;
    $('location-status').textContent = ({1:'定位权限被拒绝，请开启权限后重新定位或手动选点。',2:'无法获取新位置，周边探头暂未更新，等待定位恢复。',3:'定位超时，周边探头暂未更新，等待定位恢复。'}[err.code] || '定位失败，请重试或手动选点。');
    if (err.code === 1) { following = false; stopLocationWatch(); }
  }, {enableHighAccuracy:true,timeout:15000,maximumAge:0});
}
// Browsers may suspend location in the background; request a fresh watch on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updatePeakClock();
  if (!following) return;
  if (document.hidden) stopLocationWatch();
  else locate();
});
window.addEventListener('pagehide', stopLocationWatch);
window.addEventListener('pageshow', () => { if (following && watchId === null) locate(); });
setInterval(() => {
  if (following && lastFixAt && Date.now() - lastFixAt > 30000) $('location-status').textContent = '位置超过 30 秒未更新，当前为上次位置的周边探头，等待定位恢复。';
}, 5000);
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
    script.src=`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Geocoder,AMap.PlaceSearch`;
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
    routeEnabled=!!config.routingEnabled; routeMaxRegions=config.routeMaxRegions||32;
    $('route-limits').textContent=`本站单次最多支持 ${routeMaxRegions} 个避让区域。`;
    if(!routeEnabled) $('route-status').textContent='路线规划尚未配置 Web 服务 Key，请联系站点管理员。';
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
    for(const which of ['origin','destination']) cancelPlaceSearch(which);
    if(map) {clearRoute();for(const which of ['origin','destination']) removeRoutePointMarker(which);cameraMarkers.forEach(m=>m.setMap(null)); cameraMarkers=[]; junctionMarkers.forEach(m=>m.setMap(null)); junctionMarkers=[]; map.destroy(); centerMarker=null; accuracyCircle=null;}
    geocoder = new AMap.Geocoder({radius:300, extensions:'all'});
    map=new AMap.Map('map',{zoom:10,center:[116.397428,39.90923],viewMode:'2D',rotation:0,rotationEnable:false,pitchEnable:false});
    map.on('zoomend',renderMapMarkers);
    map.on('click',e=>{
      if(routePick) {
        setRoutePoint(routePick,{lng:e.lnglat.lng,lat:e.lnglat.lat});
        routePick=''; $('map-instruction').hidden=true; setPanel('route',true);
        $('route-status').textContent='起终点已更新，请点击规划路线。'; return;
      }
      if(choosing) { choosing=false; $('map-instruction').hidden=true; setCenter({lng:e.lnglat.lng,lat:e.lnglat.lat},'manual'); }
    });
    if (!usesProxy) saveCode(config.mapKey,code);
    if(center) setCenter(center,following?'gps':'manual',center.accuracy); else render();
    for(const which of ['origin','destination']) showRoutePointMarker(which,true);
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
    cameras=data.cameras.filter(activeCamera);
    cameraDataLoaded=true;
    cameraVersion++;
    if(routePlan && !routeBusy) { clearRoute(); $('route-status').textContent='探头数据已更新，请重新规划路线。'; }
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
for (const name of ['list','settings','route']) {
  $('toggle-'+name).addEventListener('click',()=>setPanel(name,$('toggle-'+name).getAttribute('aria-expanded') !== 'true'));
  $('close-'+name).addEventListener('click',()=>{setPanel(name,false);$('toggle-'+name).focus();});
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')setPanel('',false);});
$('radius').addEventListener('change',render);
$('route-start').addEventListener('click',()=>planRoute());
$('route-result').addEventListener('click',()=>setPanel('route',true));
$('route-continue').addEventListener('click',()=>planRoute(true));
$('route-clear').addEventListener('click',()=>{for(const which of ['origin','destination']) cancelPlaceSearch(which);clearRoute();$('route-status').textContent='路线已清除。';});
for(const which of ['origin','destination']) {
  $('route-pick-'+which).addEventListener('click',()=>pickRoutePoint(which));
  $('route-'+which).addEventListener('input',()=>searchRoutePlaces(which));
  $('route-location-'+which).addEventListener('click',()=>useRouteLocation(which));
}
$('route-current').addEventListener('click',()=>{if(!center){$('route-status').textContent='请先定位或选择查询中心。';return;}setRoutePoint('origin',center);});
$('junction-enabled').addEventListener('change',render);
for(const id of ['permit-status','peak-status']) $(id).addEventListener('change',()=>{changePassageSettings();updatePeakClock();});
updatePeakClock();
setInterval(updatePeakClock,15000);
$('refresh').addEventListener('click',()=>loadData(true));
$('locate').addEventListener('click',locate);
$('recenter').addEventListener('click',locate);
$('select').addEventListener('click',()=>{ if(!map) return; routePick=''; setPanel('',false); choosing=true; $('instruction-text').textContent='点击地图选择查询中心'; $('map-instruction').hidden=false; });
$('cancel-select').addEventListener('click',()=>{choosing=false;const wasRoute=!!routePick;routePick='';$('map-instruction').hidden=true;if(wasRoute)setPanel('route',true);});
$('retry-map').addEventListener('click',async()=>{ if(await loadMap()) locate(); });
$('change-security').addEventListener('click',clearSecurity);
$('clear-security').addEventListener('click',clearSecurity);
$('security-form').addEventListener('submit',async e=>{e.preventDefault();const code=$('security-code').value.trim();if(!code)return;$('security-code').value='';if(await loadMap(code))locate();});
$('close-detail').addEventListener('click',()=>$('detail').close());
loadData(); loadMap().then(loaded=>{ if(loaded) locate(); });
