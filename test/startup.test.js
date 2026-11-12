import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('server starts through a release directory symlink', {timeout:10_000}, async t=>{
  const temp = await mkdtemp(path.join(tmpdir(),'jingtu-startup-'));
  let child;
  try {
    const link=path.join(temp,'current');
    try { await symlink(fileURLToPath(new URL('..',import.meta.url)),link,process.platform==='win32'?'junction':'dir'); }
    catch (error) { if (error.code==='EPERM') return t.skip('Directory links unavailable'); throw error; }
    child=spawn(process.execPath,[path.join(link,'server.js')],{
      env:{...process.env,HOST:'127.0.0.1',PORT:'0',AMAP_KEY:'',AMAP_SECURITY_CODE:''},
      stdio:['ignore','pipe','pipe']
    });
    const address=await new Promise((resolve,reject)=>{
      let output='', errors='';
      const timer=setTimeout(()=>reject(Error('Startup timed out')),5000);
      child.stdout.on('data',chunk=>{
        output+=chunk;
        const match=/Listening on (127\.0\.0\.1:\d+)/.exec(output);
        if(match){clearTimeout(timer);resolve(match[1]);}
      });
      child.stderr.on('data',chunk=>{errors+=chunk;});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);reject(Error('Server exited before listening: '+code+' '+errors));});
    });
    const response=await fetch('http://'+address+'/api/config');
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{mapKey:'',securityProxy:false});
  } finally {
    if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    if(path.dirname(path.resolve(temp))!==path.resolve(tmpdir()) || !path.basename(temp).startsWith('jingtu-startup-')) throw Error('Unexpected temporary cleanup path');
    await rm(temp,{recursive:true,force:true});
  }
});
