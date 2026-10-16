'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
require('../static/app/js/crypto.js');
const c=globalThis.BepastyCrypto, handlers={};
let file, cancelled=false, failAt=-1;
const worker={location:{href:'https://test.invalid/static/app/crypto-download/worker.js',origin:'https://test.invalid'},
 registration:{scope:'https://test.invalid/static/app/crypto-download/'},skipWaiting:async()=>{},addEventListener:(name,fn)=>handlers[name]=fn};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../static/app/crypto-download/worker.js'),'utf8'),{
 self:worker,importScripts(){},BepastyCrypto:c,crypto:globalThis.crypto,URL,Response,ReadableStream,Map,Uint8Array,Date,
 fetch:async()=>{let at=0;return new Response(new ReadableStream({async pull(controller){
  if(at===file.size){controller.close();return;}const end=Math.min(at+32768,file.size),bytes=await file.readEncrypted(at,end);
  if(at<=failAt&&failAt<end)bytes[failAt-at]^=1;at=end;controller.enqueue(bytes);
 },cancel(){cancelled=true;}},{highWaterMark:0}));}
});
async function request(session){let message;handlers.message({data:{action:'prepare',url:'https://test.invalid/ITEM/+download?ciphertext=1',session},ports:[{postMessage:x=>message=x}]});
 let response;handlers.fetch({request:{url:message.url},respondWith:p=>response=p});return response;}
(async()=>{
 const plain=new Blob([new Uint8Array(3*1024*1024+17)]);plain.name='测试.txt';
 file=await c.prepareFile(plain,'test');
 const header=await file.readEncrypted(0,48), n=new DataView(header.buffer).getUint32(44);
 let at=0;const opened=await c.openRecords({read:async count=>{const out=await file.readEncrypted(at,at+count);at+=count;return out;}},'test');
 const response=await request(opened.session);assert.equal(response.status,200);
 assert(response.headers.get('content-disposition').includes(encodeURIComponent('测试.txt')));
 assert.equal((await response.arrayBuffer()).byteLength,plain.size);
 const partial=await request(opened.session), reader=partial.body.getReader();await reader.read();await reader.cancel();assert(cancelled);
 failAt=48+n+16+2*c.chunkSize+33;
 const broken=await request(opened.session);await assert.rejects(broken.arrayBuffer());
 console.log('Download worker: native attachment response, bounded stream, cancellation and authenticated corruption failure passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
