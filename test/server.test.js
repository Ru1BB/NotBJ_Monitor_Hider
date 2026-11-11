import { test } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';
const request = (url, method = 'GET') => new Promise(resolve => {
  const res = { writeHead(status) { this.status = status; }, end(body) { resolve({ status:this.status, body:JSON.parse(body) }); } };
  server.emit('request', { url, method }, res);
});
test('source failure retains the last successful cache', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(), fail = false;
  Date.now = () => now;
  globalThis.fetch = async () => fail ? new Response('failed', {status:500}) : new Response("var LabelsData = [{name:'测试',position:[116.4,39.9],aa:'2',time:'2026-11-10',href:'/content/?1.html',icon,}];", {headers:{'Content-Type':'text/html; charset=utf-8'}});
  try {
    const first = await request('/api/cameras');
    assert.equal(first.status, 200);
    assert.equal(first.body.cameras[0].name, '测试');
    fail = true; now += 61_000;
    const second = await request('/api/cameras/refresh', 'POST');
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.cameras, first.body.cameras);
    assert.equal(second.body.fetchedAt, first.body.fetchedAt);
    assert.equal(second.body.stale, true);
    assert.match(second.body.warning, /失败/);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('map proxy stays on the configured upstream host', async () => {
  const originalFetch = globalThis.fetch, originalCode = process.env.AMAP_SECURITY_CODE;
  let target;
  process.env.AMAP_SECURITY_CODE = 'test-secret';
  globalThis.fetch = async url => { target = url; return new Response('{}', {headers:{'Content-Type':'application/json'}}); };
  try {
    const result = await request('/_AMapService//example.com/path?key=abc');
    assert.equal(result.status, 200);
    assert.equal(target.hostname, 'restapi.amap.com');
    assert.equal(target.searchParams.get('jscode'), 'test-secret');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCode === undefined) delete process.env.AMAP_SECURITY_CODE; else process.env.AMAP_SECURITY_CODE = originalCode;
  }
});
