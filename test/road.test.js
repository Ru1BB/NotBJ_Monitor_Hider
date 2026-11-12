import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRoad } from '../public/road.js';
const camera = name => ({name});
test('明确的道路描述及不确定备注', () => {
  assert.equal(classifyRoad(camera('京藏高速主路北向南')).kind, 'major');
  assert.equal(classifyRoad(camera('京藏高速辅路北向南')).kind, 'other');
  assert.equal(classifyRoad(camera('京藏高速出口')).kind, 'other');
  assert.equal(classifyRoad(camera('京藏高速主路待确认')).kind, 'unknown');
  assert.equal(classifyRoad(camera('京藏高速与北清路交口')).kind, 'unknown');
});
test('仅使用名称匹配且附近唯一的高德道路作为线索', () => {
  const c = camera('京藏高速公路北向南');
  assert.equal(classifyRoad(c, [{name:'京藏高速公路',distance:10}]).kind, 'major');
  assert.equal(classifyRoad(camera('机场北线北向南'), [{name:'机场北线高速公路',distance:10}]).kind, 'major');
  assert.equal(classifyRoad(camera('机场北线北向南'), [{name:'机场北线高速公路',distance:''}]).kind, 'unknown');
  assert.equal(classifyRoad(camera('京藏高速公路与北清路交口'), [{name:'京藏高速公路',distance:10}]).kind, 'unknown');
  assert.equal(classifyRoad(camera('某地'), [{name:'京藏高速公路',distance:5}]).kind, 'unknown');
  assert.equal(classifyRoad(camera('北四环辅路附近'), [{name:'北四环辅路',distance:5}]).kind, 'other');
});

test('并行主辅路及来源冲突保留待确认，不把最近道路当作所属道路', () => {
  const parallel = [{name:'北四环主路',distance:5},{name:'北四环辅路',distance:20}];
  const ambiguous = classifyRoad(camera('北四环主路西向东'), parallel);
  assert.equal(ambiguous.kind, 'unknown');
  assert.match(ambiguous.reason, /多条/);
  assert.equal(ambiguous.nearbyRoads.length, 2);
  const conflict = classifyRoad(camera('北四环主路'), [{name:'北四环辅路',distance:5}]);
  assert.equal(conflict.kind, 'unknown');
  assert.match(conflict.reason, /冲突/);
  assert.equal(classifyRoad(camera('某地'), [{name:'北四环主路',distance:0}]).kind, 'unknown');
});

test('高德线索不能确认高架层级，来源不确定备注继续保留', () => {
  const road = classifyRoad(camera('机场北线北向南'), [{name:'机场北线高速公路',distance:10}], {
    formattedAddress:'北京市测试地址', crosses:[{firstRoadName:'测试一路',secondRoadName:'测试二路'}]
  });
  assert.equal(road.kind, 'major');
  assert.match(road.level, /待确认/);
  assert.deepEqual(road.crossings, ['测试一路 × 测试二路']);
  assert.equal(road.address, '北京市测试地址');
  const tentative = classifyRoad(camera('机场北线主路待确认'), [{name:'机场北线高速公路',distance:10}]);
  assert.equal(tentative.kind, 'unknown');
  assert.equal(tentative.nearbyRoads.length, 1);
  assert.match(classifyRoad(camera('测试高架桥上')).level, /高架上/);
  assert.match(classifyRoad(camera('测试高架下')).level, /地面/);
  assert.equal(classifyRoad(camera('京藏高速主路')).level, '待确认；高德附近道路不提供探头所在层级');
});

test('无效距离不参与匹配，同名道路去重且按距离排序', () => {
  for (const invalid of [-1, '', ' ', null, undefined, [], false, Infinity, 'bad']) {
    assert.equal(classifyRoad(camera('机场北线'), [{name:'机场北线高速公路',distance:invalid}]).kind, 'unknown');
  }
  const road = classifyRoad(camera('机场北线'), [
    {name:'机场北线高速公路',distance:'12'}, {name:'机场北线高速公路',distance:10},
    {name:'测试远路',distance:80}, {name:'范围外道路',distance:101}
  ]);
  assert.equal(road.kind, 'major');
  assert.deepEqual(road.nearbyRoads.map(r => r.distance), [10,80]);
});
