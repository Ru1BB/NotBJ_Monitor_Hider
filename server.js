import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { parseLabels } from './parser.js';
import { amapContentType } from './amap-proxy.js';
import { createRouteService, routeLimits } from './route-service.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE = 'https://www.jinjing365.com/index.asp';
const root = path.dirname(fileURLToPath(import.meta.url));
const planRoute = createRouteService();
const ttl = 10 * 60_000, refreshInterval = 60_000;
let cache = null, pending = null, lastAttempt = 0, lastError = '';
async function update() {
  if (pending) return pending;
  lastAttempt = Date.now();
  pending = (async () => {
    try {
      const response = await fetch(SOURCE, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'CameraMap/0.1' } });
      if (!response.ok) throw Error(`来源站 HTTP ${response.status}`);
      const bytes = await response.arrayBuffer(); if (bytes.byteLength > 10_000_000) throw Error('来源页面过大');
      const charset = response.headers.get('content-type')?.match(/charset\s*=\s*([^;\s]+)/i)?.[1] || 'utf-8';
      let html; try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder('utf-8').decode(bytes); }
      const result = parseLabels(html);
      if (cache && result.cameras.length < cache.cameras.length * 0.5) throw Error('记录数量较上次大幅减少');
      cache = { ...result, fetchedAt: new Date().toISOString() }; lastError = '';
    } catch (e) { lastError = String(e.message || e); console.error('来源数据更新失败:', lastError); }
    finally { pending = null; }
  })(); return pending;
}
function payload() { return { cameras: cache?.cameras || [], fetchedAt: cache?.fetchedAt || null, source: SOURCE, stale: !!cache && (Date.now() - Date.parse(cache.fetchedAt) > ttl || !!lastError), warning: lastError ? '来源数据更新失败，请稍后重试。' : cache?.invalid ? `有 ${cache.invalid} 条异常记录被忽略，数据可能不完整。` : '', coordinateSystem: '来源坐标系尚未核验' }; }
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); }
const files = { '/routing.js':['public/routing.js','text/javascript; charset=utf-8'], '/': ['public/index.html','text/html; charset=utf-8'], '/app.js':['public/app.js','text/javascript; charset=utf-8'], '/road.js':['public/road.js','text/javascript; charset=utf-8'], '/junction.js':['public/junction.js','text/javascript; charset=utf-8'], '/location.js':['public/location.js','text/javascript; charset=utf-8'], '/style.css':['public/style.css','text/css; charset=utf-8'] };
export const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res,200,{mapKey:process.env.AMAP_KEY || '', securityProxy: !!process.env.AMAP_SECURITY_CODE, routingEnabled:!!process.env.AMAP_WEB_SERVICE_KEY, routeMaxRegions:routeLimits(process.env)});
    if (req.method === 'POST' && url.pathname === '/api/route') {
      try {
        const chunks=[]; let size=0;
        for await (const chunk of req) {size+=chunk.length;if(size>32768)return json(res,413,{error:'路线请求过大。'});chunks.push(chunk);}
        let input; try {input=JSON.parse(Buffer.concat(chunks).toString());} catch {return json(res,400,{error:'路线请求格式无效。'});}
        return json(res,200,await planRoute(input,process.env));
      } catch(e) {return json(res,e.status||502,{error:e.status?e.message:'路线规划暂时不可用。'});}
    }
    if (url.pathname === '/api/cameras' && req.method === 'GET') { if (pending) await pending; else if ((!cache || Date.now()-Date.parse(cache.fetchedAt)>ttl) && Date.now()-lastAttempt>=refreshInterval) await update(); return json(res,cache ? 200 : 503,payload()); }
    if (url.pathname === '/api/cameras/refresh' && req.method === 'POST') { if (pending) await pending; else if (Date.now()-lastAttempt>=refreshInterval) await update(); else return json(res,cache ? 200 : 429,{...payload(), warning:'刷新过于频繁，请稍后重试。'}); return json(res,cache ? 200 : 503,payload()); }
    if (url.pathname.startsWith('/_AMapService/')) {
      if (!process.env.AMAP_SECURITY_CODE || !['GET','POST'].includes(req.method)) return json(res,404,{error:'Not found'});
      const target = new URL('https://restapi.amap.com/'); target.pathname = '/' + url.pathname.slice('/_AMapService/'.length); target.search = url.search; target.searchParams.set('jscode',process.env.AMAP_SECURITY_CODE);
      const upstream = await fetch(target,{method:req.method,signal:AbortSignal.timeout(12000)});
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status,{'Content-Type':amapContentType(url,upstream.headers.get('content-type'),body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return res.end(body);
    }
    if (req.method === 'GET' && files[url.pathname]) { const [file,type] = files[url.pathname]; res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'}); return res.end(await readFile(path.join(root,file))); }
    json(res,404,{error:'Not found'});
  } catch (e) { console.error('请求处理失败:', e.message); if (!res.headersSent) json(res,500,{error:'服务暂时不可用'}); else res.end(); }
});
let entryPath;
try { entryPath = process.argv[1] && realpathSync(process.argv[1]); } catch {}
if (entryPath === fileURLToPath(import.meta.url)) server.listen(Number(process.env.PORT || 3000),process.env.HOST || '127.0.0.1',()=>console.log(`Listening on ${process.env.HOST || '127.0.0.1'}:${server.address().port}`));
