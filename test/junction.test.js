import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUNCTION_RADIUS, normalizeIntersections, groupJunctions, cameraSide, metersBetween, junctionMarkerHTML } from '../public/junction.js';

const center = {lng:116.4, lat:39.9};
const point = (east = 0, north = 0) => ({lng:center.lng + east / (111195 * Math.cos(center.lat * Math.PI / 180)), lat:center.lat + north / 111195});
const crossing = (east = 0, north = 0, first = '甲路', second = '乙街') => normalizeIntersections({crosses:[{location:point(east, north), firstRoadName:first, secondRoadName:second}]})[0];
const camera = (id, east, north, intersections = [], name = '探头') => ({id, ...point(east, north), name, road:{intersections}});
const ids = values => values.map(c => c.id).sort();

test('JS SDK 和 REST 路口坐标规范化，过滤缺失名称和无效坐标', () => {
  const a = crossing();
  for (const location of ['116.4,39.9', [116.4,39.9], {getLng:()=>116.4,getLat:()=>39.9}]) {
    const [b] = normalizeIntersections({roadinters:[{location, first_name:'乙街', second_name:'甲路'}]});
    assert.equal(a.signature, b.signature);
    assert.equal(b.lng, 116.4);
  }
  for (const location of [null, '', [null,39.9], ['',39.9], [181,39], [116,Infinity], {lng:116}]) {
    assert.deepEqual(normalizeIntersections({crosses:[{location,firstRoadName:'甲路',secondRoadName:'乙街'}]}), []);
  }
  assert.deepEqual(normalizeIntersections({crosses:[{location:center,firstRoadName:'甲路'}]}), []);
});

test('每个成员都在路口半径内，超过阈值的记录仍是单点', () => {
  const rows = [camera('N',0,90,[crossing()]), camera('E',90,0), camera('far',101,0)];
  const {groups, singles} = groupJunctions(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0].members), ['E','N']);
  assert.deepEqual(ids(singles), ['far']);
  assert.equal(groups[0].sides['北'], 1);
  assert.equal(groups[0].sides['东'], 1);
  assert.equal(JUNCTION_RADIUS,100);
  assert.equal(groups[0].radius,100);
  assert.ok(groups[0].members.every(c => metersBetween(c,groups[0]) <= 100));
  const boundary = groupJunctions([camera('N',0,99,[crossing()]),camera('E',99,0),camera('outside',0,100.1)]);
  assert.equal(boundary.groups[0].members.length,2);
  assert.deepEqual(ids(boundary.singles),['outside']);
});

test('同一道路组合的两个相邻路口保留两个中心，不按相邻摄像头串联合并', () => {
  const a = crossing(), b = crossing(220);
  const rows = [camera('A1',0,40,[a,b]),camera('A2',0,-40),camera('B1',220,40),camera('B2',220,-40)];
  const result = groupJunctions(rows);
  assert.deepEqual(result.groups.map(g => ids(g.members)).sort(), [['A1','A2'],['B1','B2']]);
  assert.equal(new Set(result.groups.map(g => g.id)).size, 2);
});

test('靠近两路口距离接近时保持单点，来源完整匹配可帮助区分', () => {
  const a = crossing(), b = crossing(100,0,'甲路','丙街');
  const rows = [camera('one',0,10,[a,b]),camera('two',0,-20),camera('ambiguous',50,0)];
  assert.deepEqual(ids(groupJunctions(rows).singles), ['ambiguous']);
  rows[2].name = '甲路与乙街交口 东向西';
  assert.equal(groupJunctions(rows).groups[0].members.length, 3);
});

test('重复返回的路口中心去重，中心去重不发生链式扩张', () => {
  const rows = [camera('one',0,60,[crossing(0),crossing(20),crossing(40)]),camera('two',0,-60)];
  // 0m and 20m are one anchor; 40m must remain a second anchor, causing a tie.
  assert.equal(groupJunctions(rows).groups.length,0);
  const result = groupJunctions([camera('one',0,60,[crossing(),crossing(2)]),camera('two',0,-60)]);
  assert.equal(result.groups.length,1);
});

test('缺少路口坐标、只有一个成员、禁用分组时不合并', () => {
  assert.equal(groupJunctions([camera('one',0,0),camera('two',1,0)]).groups.length,0);
  const rows=[camera('one',0,60,[crossing()]),camera('two',0,-60)];
  assert.equal(groupJunctions(rows.slice(0,1)).singles.length,1);
  assert.deepEqual(ids(groupJunctions(rows,false).singles),['one','two']);
});

test('明确高架上、高速、匝道等记录不与地面路口自动合并', () => {
  for (const name of ['高架桥上','桥上主路','京藏高速','匝道探头','地下隧道']) {
    const rows=[camera('one',0,60,[crossing()]),camera('two',0,-60),camera('upper',20,0,[],name)];
    const result=groupJunctions(rows);
    assert.equal(result.groups[0].members.length,2);
    assert.deepEqual(ids(result.singles),['upper']);
  }
});

test('八方位由探头相对路口的位置决定，不把通行方向当所在侧', () => {
  for (const [east,north,side] of [[0,60,'北'],[60,60,'东北'],[60,0,'东'],[60,-60,'东南'],[0,-60,'南'],[-60,-60,'西南'],[-60,0,'西'],[-60,60,'西北']]) {
    assert.equal(cameraSide(camera('x',east,north,[],'北向南'),center),side);
  }
  assert.equal(cameraSide(camera('x',0,0,[],'路口北 北向南'),center),'北');
  assert.equal(cameraSide(camera('x',0,0,[],'路口 东向西'),center),'待确认');
  assert.equal(cameraSide(camera('x',0,0,[],'交口东北侧 东向西'),center),'东北');
});

test('中心附近方位不明显示问号，紫色方位数量只计算有记录的方向', () => {
  const {groups:[group]}=groupJunctions([camera('one',0,0,[crossing()]),camera('two',0,60)]);
  assert.equal(group.unknown,1);
  const html=junctionMarkerHTML(group);
  assert.equal((html.match(/junction-sector occupied/g)||[]).length,1);
  assert.equal((html.match(/class="junction-sector/g)||[]).length,8);
  assert.match(html,/junction-unknown/);
  assert.match(html,/junction-count[^>]+>2</);
});
