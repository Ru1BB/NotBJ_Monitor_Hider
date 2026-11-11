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
