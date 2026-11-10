import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
const assets={};
for(const [url,file,type] of [['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']]) assets[url]={body:await readFile('public/'+file,'utf8'),type:type+'; charset=utf-8'};
const parser=await readFile('parser.js','utf8');
const worker=await readFile('worker.js','utf8');
await mkdir('dist/server',{recursive:true}); await mkdir('dist/.openai',{recursive:true});
await writeFile('dist/server/index.js',parser+'\nconst assets='+JSON.stringify(assets)+';\n'+worker);
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
