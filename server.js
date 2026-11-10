import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseLabels } from './parser.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE = 'https://www.jinjing365.com/index.asp';
const root = path.dirname(fileURLToPath(import.meta.url));
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
      const charset = response.headers.get('content-type')?.match(/charset\s*=\s*([^;\s]+)/i)?.[1] || 'gb18030';
      let html; try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder('gb18030').decode(bytes); }
      const result = parseLabels(html);
      if (cache && result.cameras.length < cache.cameras.length * 0.5) throw Error('记录数量较上次大幅减少');
      cache = { ...result, fetchedAt: new Date().toISOString() }; lastError = '';
    } catch (e) { lastError = String(e.message || e); console.error('来源数据更新失败:', lastError); }
    finally { pending = null; }
  })(); return pending;
}
function payload() { return { cameras: cache?.cameras || [], fetchedAt: cache?.fetchedAt || null, source: SOURCE, stale: !!cache && (Date.now() - Date.parse(cache.fetchedAt) > ttl || !!lastError), warning: lastError ? '来源数据更新失败，请稍后重试。' : cache?.invalid ? `有 ${cache.invalid} 条异常记录被忽略，数据可能不完整。` : '', coordinateSystem: '来源坐标系尚未核验' }; }
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); }
const files = { '/': ['public/index.html','text/html; charset=utf-8'], '/app.js':['public/app.js','text/javascript; charset=utf-8'], '/style.css':['public/style.css','text/css; charset=utf-8'] };
export const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res,200,{mapKey:process.env.AMAP_KEY || '', securityProxy: !!process.env.AMAP_SECURITY_CODE});
    if (url.pathname === '/api/cameras' && req.method === 'GET') { if ((!cache || Date.now()-Date.parse(cache.fetchedAt)>ttl) && Date.now()-lastAttempt>=refreshInterval) await update(); return json(res,cache ? 200 : 503,payload()); }
    if (url.pathname === '/api/cameras/refresh' && req.method === 'POST') { if (pending) await pending; else if (Date.now()-lastAttempt>=refreshInterval) await update(); else return json(res,cache ? 200 : 429,{...payload(), warning:'刷新过于频繁，请稍后重试。'}); return json(res,cache ? 200 : 503,payload()); }
    if (url.pathname.startsWith('/_AMapService/')) {
      if (!process.env.AMAP_SECURITY_CODE || !['GET','POST'].includes(req.method)) return json(res,404,{error:'Not found'});
      const target = new URL('https://restapi.amap.com/'+url.pathname.slice('/_AMapService/'.length)); target.search = url.search; target.searchParams.set('jscode',process.env.AMAP_SECURITY_CODE);
      const upstream = await fetch(target,{method:req.method,signal:AbortSignal.timeout(12000)}); res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type') || 'application/json','Cache-Control':'no-store'}); return res.end(Buffer.from(await upstream.arrayBuffer()));
    }
    if (req.method === 'GET' && files[url.pathname]) { const [file,type] = files[url.pathname]; res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'}); return res.end(await readFile(path.join(root,file))); }
    json(res,404,{error:'Not found'});
  } catch (e) { console.error('请求处理失败:', e.message); if (!res.headersSent) json(res,500,{error:'服务暂时不可用'}); else res.end(); }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(Number(process.env.PORT || 3000),process.env.HOST || '127.0.0.1',()=>console.log(`Listening on ${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`));
