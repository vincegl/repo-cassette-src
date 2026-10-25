import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {CreateArtifactResponse, StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';

const ids=getBackendIdsFromToken();
const token=process.env.ACTIONS_RUNTIME_TOKEN;
const repo=process.env.GITHUB_REPOSITORY;
const runId=process.env.GITHUB_RUN_ID;
const finalizeClient=internalArtifactTwirpClient({maxAttempts:1});
const sha=body=>createHash('sha256').update(body).digest('hex');
const utf8Nel=Buffer.from('\u0085application/json','utf8');
const rawNel=Buffer.concat([Buffer.from([0x85]),Buffer.from('application/json')]);
const good=Buffer.from('application/json');
const zip=Buffer.from('application/zip');

function varint(input){
  let n=BigInt(input);const bytes=[];
  do{let b=Number(n&0x7fn);n>>=7n;if(n)b|=0x80;bytes.push(b)}while(n);
  return Buffer.from(bytes);
}
function bytesField(number,value){
  const body=Buffer.isBuffer(value)?value:Buffer.from(String(value));
  return Buffer.concat([varint((number<<3)|2),varint(body.length),body]);
}
function intField(number,value){return Buffer.concat([varint(number<<3),varint(value)])}
function mimeField(value){return bytesField(6,bytesField(1,value))}
function request(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);const transport=target.protocol==='https:'?https:http;
    const req=transport.request(target,{method,headers,timeout:15000},res=>{
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
const cases=[];
const add=(label,fields)=>cases.push({label,fields});
add('control-v7-json',[intField(5,7),mimeField(good)]);
add('control-v6-nel',[intField(5,6),mimeField(utf8Nel)]);
for(const [kind,nel] of [['utf8',utf8Nel],['raw',rawNel]]){
  add(`mime-${kind}-good-then-nel`,[intField(5,7),mimeField(good),mimeField(nel)]);
  add(`mime-${kind}-nel-then-good`,[intField(5,7),mimeField(nel),mimeField(good)]);
  add(`inner-${kind}-good-then-nel`,[intField(5,7),bytesField(6,Buffer.concat([bytesField(1,good),bytesField(1,nel)]))]);
  add(`inner-${kind}-nel-then-good`,[intField(5,7),bytesField(6,Buffer.concat([bytesField(1,nel),bytesField(1,good)]))]);
}
for(let legacy=0;legacy<=6;legacy++){
  add(`version-${legacy}-then-7-nel`,[intField(5,legacy),intField(5,7),mimeField(utf8Nel)]);
  add(`version-7-then-${legacy}-nel`,[intField(5,7),intField(5,legacy),mimeField(utf8Nel)]);
}
for(const [label,versions,mimes] of [
  ['combined-6-7-good-nel',[6,7],[good,utf8Nel]],
  ['combined-6-7-nel-good',[6,7],[utf8Nel,good]],
  ['combined-7-6-good-nel',[7,6],[good,utf8Nel]],
  ['combined-7-6-nel-good',[7,6],[utf8Nel,good]],
])add(label,[...versions.map(v=>intField(5,v)),...mimes.map(m=>mimeField(m))]);

async function runCase(index,{label,fields}){
  const name=`repo-cassette-protomatrix-${runId}-${index}`;
  const report={label,name,versionFields:fields.filter(f=>f[0]===0x28).map(f=>f[1]),mimeFieldsHex:fields.filter(f=>f[0]===0x32).map(f=>f.toString('hex'))};
  try{
    const payload=Buffer.concat([
      bytesField(1,ids.workflowRunBackendId),
      bytesField(2,ids.workflowJobRunBackendId),
      bytesField(3,name),
      ...fields,
    ]);
    const endpoint=new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',process.env.ACTIONS_RESULTS_URL);
    const created=await request(endpoint.href,'POST',payload,{
      Authorization:`Bearer ${token}`,
      Accept:'application/protobuf',
      'Content-Type':'application/protobuf',
      'Content-Length':String(payload.length),
    });
    report.createStatus=created.status;
    if(created.status!==200){
      report.createError=created.body.toString('utf8').slice(0,220).replace(/https?:\/\/[^\s"']+/g,'[url]');
      return;
    }
    const response=CreateArtifactResponse.fromBinary(created.body);
    report.createOk=response.ok;
    if(!response.ok||!response.signedUploadUrl)return;
    report.uploadBlob=new URL(response.signedUploadUrl).pathname.split('/').at(-1);
    const placeholder=Buffer.from('{}');
    await upload(response.signedUploadUrl,placeholder);
    const finalized=await finalizeClient.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    if(!finalized.ok)throw new Error('FinalizeArtifact ok=false');
    report.artifactId=String(finalized.artifactId);
    const repository=`${repo}/actions/artifacts/${report.artifactId}/zip`;
    const body=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:label,stargazers_count:0}));
    await upload(response.signedUploadUrl,body);
    report.expectedSha=sha(body);
    for(let attempt=0;attempt<8;attempt++){
      const api=await request(`https://api.github.com/repos/${repository}`,'GET',null,{
        Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,
        Accept:'application/vnd.github.v3+json',
        'User-Agent':'repo-cassette-protobuf-matrix',
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
  }catch(error){report.error=String(error.message||error).slice(0,220).replace(/https?:\/\/[^\s"']+/g,'[url]')}
  finally{console.log('PROTO_MATRIX',JSON.stringify(report))}
}
for(let i=0;i<cases.length;i++)await runCase(i,cases[i]);
