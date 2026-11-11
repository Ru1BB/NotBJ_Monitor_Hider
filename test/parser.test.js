import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabels } from '../parser.js';

test('parses documented source format without executing icon', () => {
  const result = parseLabels(`var LabelsData = [
    {name: '开发区 科创十四街与经海四路交口 南向北', position: [116.564749, 39.777381], aa: '2', time: '2026-11-10', edittime: '', href: '/content/?6898.html', icon,},
    {name: '方向待确认', position: [116.4, 39.9], aa: '6', time: '2026-01-01', edittime: '编辑日期', href: 'https://evil.example/', icon: icon},
    {name: '坏坐标', position: [0, 0], icon,},
  ];`);
  assert.equal(result.cameras.length, 2);
  assert.equal(result.invalid, 1);
  assert.deepEqual(Object.fromEntries(['name','lng','lat','category','date','editTime','url'].map(k => [k,result.cameras[0][k]])), {
    name:'开发区 科创十四街与经海四路交口 南向北', lng:116.564749, lat:39.777381, category:'2', date:'2026-11-10', editTime:'', url:'https://www.jinjing365.com/content/?6898.html'
  });
  assert.equal(result.cameras[1].name, '方向待确认');
  assert.equal(result.cameras[1].editTime, '编辑日期');
  assert.equal(result.cameras[1].url, '');
});
test('retains compatibility with separate coordinates and missing optional fields', () => {
  const { cameras } = parseLabels(`var LabelsData = [{name:'测试点',lng:116.4,lat:39.9,description:'位置待确认',url:'/detail.asp?id=1'}]`);
  assert.equal(cameras[0].description, '位置待确认');
  assert.equal(cameras[0].url, 'https://www.jinjing365.com/detail.asp?id=1');
  assert.equal(cameras[0].category, '');
});
test('rejects executable expressions, malformed and empty data', () => {
  for (const input of ['var LabelsData = [alert(1)]', 'var LabelsData = [{position:[116.4,39.9], icon: alert(1)}]', 'var LabelsData = [{position:[116.4,39.9], other}]', 'var LabelsData = []', 'nothing here']) assert.throws(() => parseLabels(input));
});
