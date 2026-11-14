import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {server} from '../server.js';

function nodeRequest(path,method='GET',body) {
  return new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);req.url=path;req.method=method;
    const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(value){resolve(new Response(value,{status:this.status,headers:this.headers}));}};
    server.emit('request',req,res);
  });
}
test('Node 与构建 Worker：配置不泄露 Web Key、路由缓存、模块与错误处理一致',async()=>{
  // Build in memory as build.mjs does, without relying on pre-existing dist output.
  const [parser,proxy,routes,worker,routing]=await Promise.all(['parser.js','amap-proxy.js','route-service.js','worker.js','public/routing.js'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')));
  const module=await import('data:text/javascript;base64,'+Buffer.from(parser+'\n'+proxy+'\n'+routes+'\nconst assets={"/routing.js":'+JSON.stringify({body:routing,type:'text/javascript'})+'};\n'+worker.replace("import { amapContentType } from './amap-proxy.js';",'').replace("import { createRouteService, routeLimits } from './route-service.js';",'')).toString('base64'));
  const originalFetch=globalThis.fetch, prior=process.env.AMAP_WEB_SERVICE_KEY, priorLimit=process.env.AMAP_ROUTE_MAX_REGIONS;
  const env={AMAP_WEB_SERVICE_KEY:'test-http-web-key',AMAP_ROUTE_MAX_REGIONS:'32'};
  Object.assign(process.env,env);
  const input={origin:{lng:116.3,lat:39.9},destination:{lng:116.5,lat:39.9},polygons:[]};
  let upstream=0;
  globalThis.fetch=async()=>{upstream++;return Response.json({status:'1',route:{paths:[{distance:'10',cost:{duration:'5'},steps:[{polyline:'116.3,39.9;116.5,39.9'}]}]}});};
  try {
    for(const request of [nodeRequest,(path,method='GET',body)=>module.default.fetch(new Request('https://example.test'+path,{method,body}),env)]) {
      const config=await (await request('/api/config')).json();assert.equal(config.routingEnabled,true);assert.equal(config.routeMaxRegions,32);assert.equal(JSON.stringify(config).includes(env.AMAP_WEB_SERVICE_KEY),false);
      const first=await request('/api/route','POST',JSON.stringify(input));assert.equal(first.status,200);assert.equal((await first.json()).cached,false);
      assert.equal((await (await request('/api/route','POST',JSON.stringify(input))).json()).cached,true);
      assert.equal((await request('/api/route','POST','{')).status,400);
      assert.equal((await request('/api/route','POST','x'.repeat(33000))).status,413);
      const asset=await request('/routing.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
    }
    assert.equal(upstream,2);
  } finally {
    globalThis.fetch=originalFetch;
    if(prior===undefined)delete process.env.AMAP_WEB_SERVICE_KEY;else process.env.AMAP_WEB_SERVICE_KEY=prior;
    if(priorLimit===undefined)delete process.env.AMAP_ROUTE_MAX_REGIONS;else process.env.AMAP_ROUTE_MAX_REGIONS=priorLimit;
  }
});
