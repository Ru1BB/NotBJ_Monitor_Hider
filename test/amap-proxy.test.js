import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { server } from '../server.js';
import worker from '../worker.js';

function nodeRequest(url) {
  return new Promise(resolve=>{
    const res={
      writeHead(status,headers){this.status=status;this.headers=headers;},
      end(body){resolve(new Response([204,205,304].includes(this.status)?null:body,{status:this.status,headers:this.headers}));}
    };
    server.emit('request',{url,method:'GET'},res);
  });
}

for (const [name,request] of [
  ['Node',nodeRequest],
  ['Worker',url=>worker.fetch(new Request('https://example.test'+url),{AMAP_SECURITY_CODE:'test-secret'})]
]) {
  test(`${name}: JSONP 标为 JavaScript，可在 nosniff 下执行高德回调`,async()=>{
    const savedFetch=globalThis.fetch, savedCode=process.env.AMAP_SECURITY_CODE;
    process.env.AMAP_SECURITY_CODE='test-secret';
    const payload={status:'1',info:'ok',locations:'116.403371582032,39.917929958768'};
    const body='amapTest('+JSON.stringify(payload)+')';
    globalThis.fetch=async target=>{
      assert.equal(target.hostname,'restapi.amap.com');
      assert.equal(target.searchParams.get('jscode'),'test-secret');
      assert.equal(target.searchParams.get('s'),'rsv3');
      return new Response(body,{headers:{'Content-Type':'application/json;charset=UTF-8'}});
    };
    try {
      const r=await request('/_AMapService/v3/assistant/coordinate/convert?s=rsv3&callback=amapTest');
      assert.equal(r.status,200);
      assert.match(r.headers.get('content-type'),/^(?:text|application)\/javascript\b/);
      assert.equal(r.headers.get('x-content-type-options'),'nosniff');
      let actual;
      vm.runInNewContext(await r.text(),{amapTest:value=>{actual=value;}});
      assert.equal(actual.locations,payload.locations);
    } finally {
      globalThis.fetch=savedFetch;
      if(savedCode===undefined) delete process.env.AMAP_SECURITY_CODE; else process.env.AMAP_SECURITY_CODE=savedCode;
    }
  });

  test(`${name}: 普通 JSON、HTML、无效回调及不匹配的响应不改为脚本`,async()=>{
    const savedFetch=globalThis.fetch, savedCode=process.env.AMAP_SECURITY_CODE;
    process.env.AMAP_SECURITY_CODE='test-secret';
    try {
      for (const [query,body,type,status=502] of [
        ['','{"status":"1"}','application/json'],
        ['?callback=amapTest','{"status":"0"}','application/json'],
        ['?callback=amapTest','<html>error</html>','text/html'],
        ['?callback=alert(1)','alert(1)({})','application/json'],
        ['?callback=amapTest','anotherCallback({})','application/json'],
        ['?callback=amapTest','amapTest({}); alert(1);','application/json'],
        ['?callback=amapTest&callback=other','amapTest({})','application/json'],
        ['',null,'application/json',204]
      ]) {
        globalThis.fetch=async()=>new Response(body,{status,headers:{'Content-Type':type}});
        const r=await request('/_AMapService/v3/assistant/coordinate/convert'+query);
        assert.equal(r.status,status); assert.equal(r.headers.get('content-type'),type);
        assert.equal(await r.text(),body ?? '');
      }
    } finally {
      globalThis.fetch=savedFetch;
      if(savedCode===undefined) delete process.env.AMAP_SECURITY_CODE; else process.env.AMAP_SECURITY_CODE=savedCode;
    }
  });
}
