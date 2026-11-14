// Route checks use all raw camera coordinates, independently of map radius/grouping.
export const BUFFER_METERS = 40;
const valid = p => p && Number.isFinite(p.lng) && Number.isFinite(p.lat) && p.lng >= 115 && p.lng <= 118 && p.lat >= 39 && p.lat <= 42;
export function parsePoint(value) {
  const parts = String(value).trim().split(/[,，\s]+/);
  if (parts.length !== 2 || parts.some(v => !v)) throw Error('请输入北京周边坐标：经度,纬度，或在地图上选点。');
  const p = {lng:Number(parts[0]), lat:Number(parts[1])};
  if (!valid(p)) throw Error('起终点须位于北京周边（经度 115–118，纬度 39–42）。');
  return p;
}
export function pointDistance(p, a, b = a) {
  const scale = Math.cos(p.lat * Math.PI / 180) * 111320;
  const ax = (a.lng-p.lng)*scale, ay = (a.lat-p.lat)*111320;
  const bx = (b.lng-p.lng)*scale, by = (b.lat-p.lat)*111320;
  const dx = bx-ax, dy = by-ay;
  const t = dx*dx+dy*dy ? Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy))) : 0;
  return Math.hypot(ax+t*dx,ay+t*dy);
}
export function routeHits(paths, cameras, radius = BUFFER_METERS) {
  const points=paths.flat(), segments=[];
  const dy=radius/111320, dx=dy/Math.cos(42*Math.PI/180);
  for(let i=1;i<points.length;i++) {
    const a={lng:points[i-1][0],lat:points[i-1][1]}, b={lng:points[i][0],lat:points[i][1]};
    segments.push({a,b,minLng:Math.min(a.lng,b.lng)-dx,maxLng:Math.max(a.lng,b.lng)+dx,minLat:Math.min(a.lat,b.lat)-dy,maxLat:Math.max(a.lat,b.lat)+dy});
  }
  return cameras.filter(c=>valid(c) && segments.some(s=>c.lng>=s.minLng && c.lng<=s.maxLng && c.lat>=s.minLat && c.lat<=s.maxLat && pointDistance(c,s.a,s.b)<=radius));
}
const cameraKey = c => `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`;
export function avoidBox(c) {
  // Circumscribed square: includes the complete check radius, plus rounding margin.
  const dy = (BUFFER_METERS+2)/111320, dx = dy/Math.cos(c.lat*Math.PI/180);
  return [[c.lng-dx,c.lat-dy],[c.lng+dx,c.lat-dy],[c.lng+dx,c.lat+dy],[c.lng-dx,c.lat+dy]]
    .map(p=>p.map(n=>Number(n.toFixed(6))));
}
export function createPlan(origin, destination, cameras, maxRegions = 32) {
  if (!valid(origin) || !valid(destination)) throw Error('起终点坐标无效。');
  if (!cameras.length || cameras.some(c=>!valid(c))) throw Error('探头数据尚未完整加载，请刷新数据后再规划。');
  if (pointDistance(origin,destination)<5) throw Error('起终点距离过近，请重新选择。');
  if (cameras.some(c=>pointDistance(c,origin)<=BUFFER_METERS || pointDistance(c,destination)<=BUFFER_METERS))
    throw Error('起点或终点位于已知摄像头附近，请调整位置。');
  return {origin:{...origin}, destination:{...destination}, cameras:cameras.map(c=>({...c})), maxRegions,
    areas:new Map(), seen:new Set(), route:null, hits:[], calls:0, cacheHits:0, rounds:0, reason:'', resumable:false};
}
export async function runPlan(plan, request, onProgress = () => {}, budget = 5) {
  plan.resumable = false;
  const started = Date.now();
  for (let round=0; round<budget; round++) {
    onProgress(plan);
    const result = await request({origin:plan.origin, destination:plan.destination, polygons:[...plan.areas.values()]});
    plan.calls += result.cached ? 0 : 1; plan.cacheHits += result.cached ? 1 : 0; plan.rounds++;
    plan.route = result.route;
    plan.hits = routeHits(plan.route.paths, plan.cameras);
    if (!plan.hits.length) { plan.reason='success'; return plan; }
    const fingerprint = JSON.stringify(plan.route.paths);
    if (plan.seen.has(fingerprint)) { plan.reason='unchanged'; return plan; }
    plan.seen.add(fingerprint);
    let added = 0;
    for (const c of plan.hits) {
      const key = cameraKey(c);
      if (plan.areas.has(key)) continue;
      if (plan.areas.size >= plan.maxRegions) break;
      const box=avoidBox(c);
      if([plan.origin,plan.destination].some(p=>p.lng>=box[0][0] && p.lng<=box[2][0] && p.lat>=box[0][1] && p.lat<=box[2][1])) {plan.reason='endpoint';return plan;}
      plan.areas.set(key,box); added++;
    }
    if (!added) { plan.reason=plan.areas.size>=plan.maxRegions?'regions':'unchanged'; return plan; }
    if (Date.now()-started>=45000) { plan.reason='time'; plan.resumable=true; return plan; }
  }
  plan.reason='budget'; plan.resumable=true; return plan;
}
