// Shared Node/Worker adapter. Coordinates stay in bounded short-lived memory only.
export const routeLimits = env => Math.max(1,Math.min(32,Number.parseInt(env.AMAP_ROUTE_MAX_REGIONS,10)||32));
export function createRouteService({fetcher = (...args)=>fetch(...args), now = ()=>Date.now()} = {}) {
  const cache = new Map(), pending = new Map();
  const fail = (message,status=400) => Object.assign(Error(message),{status});
  function point(p) {
    if (!p || !Number.isFinite(p.lng) || !Number.isFinite(p.lat) || p.lng<115 || p.lng>118 || p.lat<39 || p.lat>42) throw fail('起终点或避让坐标无效。');
    return [p.lng,p.lat].map(n=>Number(n.toFixed(6)));
  }
  return async function plan(input,env) {
    if (!env.AMAP_WEB_SERVICE_KEY) throw fail('路线规划尚未配置 Web 服务 Key，请联系站点管理员。',503);
    const origin = point(input?.origin), destination = point(input?.destination);
    if (!Array.isArray(input.polygons) || input.polygons.length>routeLimits(env)) throw fail('避让区域数量超过本站配置上限。');
    const polygons = input.polygons.map(poly=>{
      if (!Array.isArray(poly) || poly.length<3 || poly.length>16) throw fail('避让区域格式无效。');
      const points = poly.map(p=>{if(!Array.isArray(p)||p.length!==2)throw fail('避让坐标无效。');return point({lng:p[0],lat:p[1]});});
      if (Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]))>.02 || Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]))>.02) throw fail('避让区域过大。');
      return points.map(p=>p.join(',')).join(';');
    }).sort();
    const key = JSON.stringify([env.AMAP_WEB_SERVICE_KEY,origin,destination,polygons]);
    for (const [k,v] of cache) if (v.expires<=now()) cache.delete(k);
    if (cache.has(key)) return {route:cache.get(key).route,cached:true};
    if (pending.has(key)) return {route:await pending.get(key),cached:true};
    if (pending.size>=8) throw fail('路线规划繁忙，请稍后重试。',429);
    const task = (async()=>{
      const params = new URLSearchParams({key:env.AMAP_WEB_SERVICE_KEY,origin:origin.join(','),destination:destination.join(','),strategy:'0',show_fields:'polyline,cost'});
      if(polygons.length) params.set('avoidpolygons',polygons.join('|'));
      let response;
      try { response = await fetcher('https://restapi.amap.com/v5/direction/driving',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString(),signal:AbortSignal.timeout(12000)}); }
      catch { throw fail('高德路线请求失败或超时，请稍后重试。',502); }
      if(!response.ok)throw fail('高德路线服务暂时不可用。',502);
      let data; try { data=await response.json(); } catch { throw fail('高德路线响应格式异常。',502); }
      if(String(data.status)!=='1') {
        const code = /^\d{5}$/.test(String(data.infocode)) ? String(data.infocode) : '未知';
        throw fail(`高德未完成路线规划（错误码 ${code}），请检查服务权限、额度及避让区域配置。`,502);
      }
      const path = data.route?.paths?.[0];
      if(!path)throw fail('当前避让条件下高德未返回可用路线。',422);
      const paths = (path.steps||[]).map(s=>String(s.polyline||'').split(';').map(v=>v.split(',').map(n=>n.trim()===''?NaN:Number(n))));
      if(!paths.length || paths.some(p=>p.length<2 || p.some(v=>v.length!==2 || !v.every(Number.isFinite) || Math.abs(v[0])>180 || Math.abs(v[1])>90))) throw fail('路线坐标不完整，无法检查沿线摄像头。',502);
      const route = {paths,distance:Number(path.distance)||0,duration:Number(path.cost?.duration)||0};
      if(cache.size>=100)cache.delete(cache.keys().next().value);
      cache.set(key,{route,expires:now()+60000});
      return route;
    })();
    pending.set(key,task);
    try {return {route:await task,cached:false};} finally {pending.delete(key);}
  };
}
