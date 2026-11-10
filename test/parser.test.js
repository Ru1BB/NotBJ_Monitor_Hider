import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabels } from '../parser.js';
test('parses safe literals and rejects untrusted links and invalid coordinates',()=>{ const result=parseLabels(`var LabelsData = [{name:'测试点',lng:116.4,lat:39.9,description:'位置待确认',url:'/detail.asp?id=1'}, {name:'bad',lng:0,lat:0}, {name:'另一个',lng:116.5,lat:39.8,url:'https://evil.example/'}];`); assert.equal(result.cameras.length,2); assert.equal(result.invalid,1); assert.equal(result.cameras[0].url,'https://www.jinjing365.com/detail.asp?id=1'); assert.equal(result.cameras[0].description,'位置待确认'); assert.equal(result.cameras[1].url,''); });
test('rejects executable expressions and empty data',()=>{ assert.throws(()=>parseLabels('var LabelsData = [alert(1)]')); assert.throws(()=>parseLabels('var LabelsData = []')); assert.throws(()=>parseLabels('nothing here')); });
