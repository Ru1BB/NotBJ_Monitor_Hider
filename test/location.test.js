import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpsToAmap } from '../public/location.js';

const lng=116.404, lat=39.915;
const expected={lng:116.41024449916938,lat:39.91640428150164};
function assertFallback(p) {
  assert.ok(Math.abs(p.lng-expected.lng)<1e-8);
  assert.ok(Math.abs(p.lat-expected.lat)<1e-8);
  assert.equal(p.approximate,true);
}

test('优先采用 SDK 转换结果，兼容 LngLat 属性和访问方法',async()=>{
  for (const point of [{lng:116.41,lat:39.92},{getLng:()=>116.41,getLat:()=>39.92}]) {
    const p=await gpsToAmap(lng,lat,(coords,type,cb)=>{
      assert.deepEqual(coords,[lng,lat]); assert.equal(type,'gps');
      cb('complete',{locations:[point]});
    });
    assert.deepEqual(p,{lng:116.41,lat:39.92,approximate:false});
  }
});

test('转换报错、缺少结果、无效坐标、SDK 抛异常时使用已知北京坐标近似值',async()=>{
  const failures=[
    (_coords,_type,cb)=>cb('error','USERKEY_PLAT_NOMATCH'),
    (_coords,_type,cb)=>cb('error',null),
    (_coords,_type,cb)=>cb('complete',{}),
    (_coords,_type,cb)=>cb('complete',{locations:[{lng:NaN,lat:39.9}]}),
    (_coords,_type,cb)=>cb('complete',{locations:[{lng:116.4,lat:999}]}),
    ()=>{throw Error('SDK unavailable');},
    undefined
  ];
  for (const convert of failures) assertFallback(await gpsToAmap(lng,lat,convert));
});

test('转换不回调时超时恢复，迟到的结果不再改变返回位置',async()=>{
  let callback;
  const p=await gpsToAmap(lng,lat,(_coords,_type,cb)=>{callback=cb;},5);
  assertFallback(p);
  callback('complete',{locations:[{lng:117,lat:40}]});
  assertFallback(p);
});

test('无效浏览器坐标不进入转换，覆盖范围以外不擅自使用近似值或原始 GPS',async()=>{
  for (const [x,y] of [[NaN,lat],[lng,Infinity],[181,lat],[lng,-91],[null,lat]]) {
    await assert.rejects(gpsToAmap(x,y,()=>assert.fail('不应转换')),/位置无效/);
  }
  await assert.rejects(gpsToAmap(121.47,31.23,(_coords,_type,cb)=>cb('error',null)),/服务暂不可用/);
});
