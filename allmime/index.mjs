import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const types=[
  'text/plain','text/html','text/css','text/csv','text/xml','text/markdown',
  'application/javascript','application/json','image/png','image/jpeg','image/gif',
  'image/svg+xml','image/webp','image/x-icon','image/bmp','image/tiff',
  'audio/mpeg','audio/wav','audio/ogg','audio/flac','video/mp4','video/webm',
  'video/x-msvideo','video/quicktime','application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-tar','application/gzip','application/vnd.rar',
  'application/x-7z-compressed','application/wasm','application/x-yaml',
  'font/woff','font/woff2','font/ttf','font/otf','application/vnd.ms-fontobject',
  'application/octet-stream','application/xml',
];
const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const sha=body=>createHash('sha256').update(body).digest('hex');
function request(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const mod=target.protocol==='https:'?https:http;
    const req=mod.request(target,{method,headers,timeout:15000},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));
    if(body)req.write(body);req.end();
  });
}
async function upload(url,body){
  const r=await request(url,'PUT',body,{
    'x-ms-version':'2025-01-05','x-ms-blob-type':'BlockBlob',
    'x-ms-blob-content-type':'\u0085application/json',
    'Content-Type':'application/octet-stream','Content-Length':String(body.length),
  });
  if(r.status!==201)throw new Error(`Blob PUT ${r.status} ${r.headers['x-ms-error-code']||''}`);
}
async function runCase(index,mime){
  const name=`repo-cassette-allmime-${runId}-${index}`;
  const report={index,mime,name};
  try{
    const created=await client.CreateArtifact({...ids,name,version:7,mimeType:StringValue.create({value:mime})});
    report.createOk=created.ok;
    if(!created.ok)return;
    report.uploadBlob=new URL(created.signedUploadUrl).pathname.split('/').at(-1);
    const placeholder=Buffer.from('{}');
    await upload(created.signedUploadUrl,placeholder);
    const finalized=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    if(!finalized.ok)throw new Error('FinalizeArtifact ok=false');
    report.artifactId=String(finalized.artifactId);
    const repository=`${repo}/actions/artifacts/${report.artifactId}/zip`;
    const body=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:mime,stargazers_count:0}));
    await upload(created.signedUploadUrl,body);
    report.expectedSha=sha(body);
    for(let attempt=0;attempt<8;attempt++){
      const api=await request(`https://api.github.com/repos/${repository}`,'GET',null,{
        Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-allmime',
      });
      report.restStatus=api.status;
      if(api.status===404){await new Promise(r=>setTimeout(r,300));continue}
      if(api.status!==302||!api.headers.location)break;
      const location=new URL(api.headers.location);
      report.rsct=location.searchParams.get('rsct');
      report.downloadBlob=location.pathname.split('/').at(-1);
      const final=await request(location.href);
      report.finalStatus=final.status;
      report.finalContentTypeHex=(final.headers['content-type']||'').split('').map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
      report.finalBodyMatch=final.body.equals(body);
      break;
    }
  }catch(error){report.error=String(error.message||error).slice(0,180).replace(/https?:\/\/[^\s"']+/g,'[url]')}
  finally{console.log('ALLMIME',JSON.stringify(report))}
}
for(let i=0;i<types.length;i++)await runCase(i,types[i]);
