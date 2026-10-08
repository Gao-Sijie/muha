import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readPublicationCandidate } from './publication-candidate.mjs';
const root=new URL('../',import.meta.url).pathname;
const candidate=new URL('../.scratch/npm-candidate/',import.meta.url).pathname;
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});if(r.status!==0)throw new Error(`${cmd}: ${r.stderr}`);return r.stdout.trim();};
function source(){
  const revision=process.env.REVIEWED_REVISION;
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='Gao-Sijie/muha'||process.env.GITHUB_REF!=='refs/heads/main'||! /^[a-f0-9]{40}$/.test(revision??'')||revision!==process.env.GITHUB_SHA||revision!==run('git',['rev-parse','HEAD']))throw new Error('Release must run at the explicitly reviewed main commit');
  run(process.execPath,['scripts/check-repository-policy.mjs',root,'HEAD']);
  if(run('git',['status','--porcelain']))throw new Error('Release source is dirty');
  return revision;
}
const qualification=JSON.parse(await readFile(new URL('./fixtures/sdk-runtime-sha256.json',import.meta.url)));
if(!qualification.requalifications?.some(item=>item.harness==='pi'&&item.sdkVersion==='1.0.4'&&item.status==='PASS'))throw new Error('Pi 1.0.4 requalification is required');
const mode=process.argv[2];
if(mode==='source')source();
else if(mode==='summary'){
  const bytes=await readFile(`${candidate}release.json`),release=JSON.parse(bytes);
  const sha=createHash('sha256').update(bytes).digest('hex');
  await readPublicationCandidate(candidate,{revision:process.env.GITHUB_SHA,version:'0.1.13',manifestSha256:sha});
  await appendFile(process.env.GITHUB_STEP_SUMMARY,`Prepared six-package candidate at ${release.source.revision}.\n\nrelease.json SHA256: \`${sha}\`\n\nReview this artifact before dispatching publish. Candidate tag precedes Registry acceptance; latest follows both consumer jobs.\n`);
  console.log(JSON.stringify({revision:release.source.revision,manifestSha256:sha,packages:release.packages.map(p=>({name:p.name,sha256:p.sha256,integrity:p.integrity}))}));
}else if(mode==='download'){
  const revision=source(),id=process.env.CANDIDATE_RUN;
  if(!/^[1-9][0-9]*$/.test(id??''))throw new Error('A successful reviewed preparation run ID is required');
  const metadata=JSON.parse(run('gh',['api',`repos/Gao-Sijie/muha/actions/runs/${id}`]));
  if(metadata.head_sha!==revision||metadata.conclusion!=='success'||metadata.event!=='workflow_dispatch'||metadata.path!=='.github/workflows/sdk-release.yml')throw new Error('Candidate run does not identify successful preparation of this source');
  await mkdir(candidate,{recursive:true});
  run('gh',['run','download',id,'--repo','Gao-Sijie/muha','--name','npm-candidate','--dir',candidate]);
  await readPublicationCandidate(candidate,{revision,version:'0.1.13',manifestSha256:process.env.REVIEWED_MANIFEST_SHA256});
}else throw new Error('Use source, summary or download');
