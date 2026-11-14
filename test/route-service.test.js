import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRouteService} from '../route-service.js';
const env={AMAP_WEB_SERVICE_KEY:'test-only-web-key',AMAP_ROUTE_MAX_REGIONS:'32'};
const input={origin:{lng:116.3,lat:39.9},destination:{lng:116.5,lat:39.9},polygons:[]};
const payload={status:'1',route:{paths:[{distance:'18000',cost:{duration:'1000'},steps:[{polyline:'116.3,39.9;116.5,39.9'}]}]}};
test('相同请求短时缓存，过期重新调用；独立密钥不会共用结果',async()=>{
  let calls=0,now=0;
  const service=createRouteService({now:()=>now,fetcher:async(url,opts)=>{
    calls++;assert.equal(url,'https://restapi.amap.com/v5/direction/driving');
    assert.equal(opts.method,'POST');assert.equal(new URLSearchParams(opts.body).get('show_fields'),'polyline,cost');
    return Response.json(payload);
  }});
  assert.equal((await service(input,env)).cached,false);
  assert.equal((await service(input,env)).cached,true);assert.equal(calls,1);
  now=60001;await service(input,env);assert.equal(calls,2);
  await service(input,{...env,AMAP_WEB_SERVICE_KEY:'another-test-key'});assert.equal(calls,3);
});
test('相同在途请求只发一次，错误不缓存也不泄露凭据',async()=>{
  let release,calls=0;
  const service=createRouteService({fetcher:async()=>{calls++;await new Promise(r=>release=r);return Response.json(payload);}});
  const first=service(input,env),second=service(input,env);release();
  const result=await Promise.all([first,second]);assert.equal(calls,1);assert.equal(result[1].cached,true);
  const bad=createRouteService({fetcher:async()=>{calls++;throw Error('secret-url');}});
  await assert.rejects(bad(input,env),/请求失败或超时/);await assert.rejects(bad(input,env),/请求失败或超时/);assert.equal(calls,3);
});
test('缺失 Key、无效坐标、超限区域、异常响应均不得当作成功路线',async()=>{
  const service=createRouteService({fetcher:async()=>Response.json(payload)});
  await assert.rejects(service(input,{}),/Web 服务 Key/);
  await assert.rejects(service({...input,origin:{lng:0,lat:0}},env),/坐标/);
  await assert.rejects(service({...input,polygons:[[],[]]},{...env,AMAP_ROUTE_MAX_REGIONS:'1'}),/数量/);
  const bad=createRouteService({fetcher:async()=>Response.json({status:'0',infocode:'10003',info:'private-data'})});
  await assert.rejects(bad(input,env),/错误码 10003/);
  const noLine=createRouteService({fetcher:async()=>Response.json({status:'1',route:{paths:[{steps:[]}]}})});
  await assert.rejects(noLine(input,env),/坐标不完整/);
  const emptyCoords=createRouteService({fetcher:async()=>Response.json({status:'1',route:{paths:[{steps:[{polyline:',;,'}]}]}})});
  await assert.rejects(emptyCoords(input,env),/坐标不完整/);
});
