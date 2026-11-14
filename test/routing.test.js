import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlan,runPlan,routeHits,parsePoint} from '../public/routing.js';
const origin={lng:116.3,lat:39.9}, destination={lng:116.5,lat:39.9};
const cameras=[{lng:116.4,lat:39.9},{lng:116.45,lat:39.9},{lng:116.4,lat:39.91}];
const direct={paths:[[[116.3,39.9],[116.5,39.9]]],distance:18000,duration:1000};
const detour={paths:[[[116.3,39.9],[116.3,39.91],[116.5,39.91],[116.5,39.9]]],distance:21000,duration:1200};
const safe={paths:[[[116.3,39.9],[116.3,39.92],[116.5,39.92],[116.5,39.9]]],distance:23000,duration:1400};
test('检查长线段内部、40 米边界附近及所有原始点位',()=>{
  assert.equal(routeHits(direct.paths,cameras).length,2);
  assert.equal(routeHits(direct.paths,[{lng:116.4,lat:39.90035}]).length,1);
  assert.equal(routeHits(direct.paths,[{lng:116.4,lat:39.9004}]).length,0);
  assert.deepEqual(parsePoint('116.4，39.9'),{lng:116.4,lat:39.9});
  assert.throws(()=>parsePoint('0,0'));
});
test('一轮批量添加、下一轮保留历史区域，新路线检查通过才成功',async()=>{
  const p=createPlan(origin,destination,cameras), inputs=[];
  await runPlan(p,async input=>{inputs.push(structuredClone(input));return {route:[direct,detour,safe][inputs.length-1],cached:false};});
  assert.deepEqual(inputs.map(i=>i.polygons.length),[0,2,3]);
  assert.deepEqual(inputs[2].polygons.slice(0,2),inputs[1].polygons);
  assert.equal(p.reason,'success');assert.equal(p.calls,3);assert.equal(p.hits.length,0);
});
test('重复路线停止，不会循环消耗预算',async()=>{
  const p=createPlan(origin,destination,cameras);
  await runPlan(p,async()=>({route:direct,cached:false}));
  assert.equal(p.calls,2);assert.equal(p.reason,'unchanged');assert.equal(p.resumable,false);
});
test('额度预算耗尽后可续算，保留避让集合，缓存不计新增高德请求',async()=>{
  const p=createPlan(origin,destination,cameras);
  await runPlan(p,async()=>({route:direct,cached:true}),()=>{},1);
  assert.equal(p.reason,'budget');assert.equal(p.resumable,true);assert.equal(p.calls,0);
  await runPlan(p,async input=>{assert.equal(input.polygons.length,2);return {route:safe,cached:false};});
  assert.equal(p.reason,'success');assert.equal(p.calls,1);assert.equal(p.cacheHits,1);
});
test('区域上限、起终点冲突、无数据提前停止',async()=>{
  assert.throws(()=>createPlan(origin,destination,[]),/数据/);
  assert.throws(()=>createPlan(origin,destination,[origin]),/起点或终点/);
  const p=createPlan(origin,destination,cameras,1);
  let calls=0;
  await runPlan(p,async()=>({route:calls++===0?direct:detour,cached:false}));
  assert.equal(p.reason,'regions');assert.equal(p.calls,2);assert.equal(p.resumable,false);
});
test('区域已满仍先尝试已添加的约束，一个区域也可能绕开多个摄像头',async()=>{
  const p=createPlan(origin,destination,cameras,1);let calls=0;
  await runPlan(p,async input=>{assert.equal(input.polygons.length,calls);return {route:calls++===0?direct:safe,cached:false};});
  assert.equal(p.reason,'success');assert.equal(p.calls,2);assert.equal(p.areas.size,1);
});
test('默认最多五轮，新点位逐轮累积；续算不会重新发普通路线',async()=>{
  const points=Array.from({length:6},(_,i)=>({lng:116.4,lat:39.905+i*.005}));
  const p=createPlan(origin,destination,points);
  const request=async input=>{
    const i=input.polygons.length;
    return {cached:false,route:{paths:[[[116.3,39.9],[116.3,points[i].lat],[116.5,points[i].lat],[116.5,39.9]]],distance:20000,duration:1000}};
  };
  await runPlan(p,request);assert.equal(p.calls,5);assert.equal(p.areas.size,5);assert.equal(p.reason,'budget');
  await runPlan(p,async input=>{assert.equal(input.polygons.length,5);return {cached:false,route:safe};},()=>{},1);
  assert.equal(p.calls,6);
});
