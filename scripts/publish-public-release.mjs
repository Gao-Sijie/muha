import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { assertPiPublicationQualification } from './publication-qualification.mjs';
import { readPublicationCandidate } from './publication-candidate.mjs';
import { validateRegistryProvenance } from './registry-provenance.mjs';
const registry='https://registry.npmjs.org/',version='0.1.13';
const directory=new URL('../.scratch/npm-candidate/',import.meta.url).pathname;
const revision=process.env.REVIEWED_REVISION;
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='Gao-Sijie/muha'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_SHA!==revision)throw new Error('Publication requires the reviewed GitHub-hosted source');
assertPiPublicationQualification(JSON.parse(await readFile(new URL('./fixtures/sdk-runtime-sha256.json',import.meta.url))));
const candidate=await readPublicationCandidate(directory,{revision,version,manifestSha256:process.env.REVIEWED_MANIFEST_SHA256});
const mode=process.argv[2];if(!['publish','promote'].includes(mode))throw new Error('Use publish or promote');
if(!process.env.NODE_AUTH_TOKEN)throw new Error('Configure the short-lived NPM_PUBLISH_TOKEN repository secret first');
const repository=await fetch('https://api.github.com/repos/Gao-Sijie/muha',{headers:{'User-Agent':'muha-release'}});
if(!repository.ok||(await repository.json()).private!==false)throw new Error('The reviewed source repository must be public before npm provenance');
function npm(args){const r=spawnSync('npm',args,{cwd:directory,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error(`npm command failed; stop and read back the registry before any retry: ${r.stderr}`);}
async function metadata(item){const response=await fetch(`${registry}${encodeURIComponent(item.name)}/${version}`);if(response.status===404)return undefined;if(!response.ok)throw new Error(`Registry readback HTTP ${response.status}`);return response.json();}
async function verify(item){
  const info=await metadata(item);
  if(!info||info.name!==item.name||info.version!==version||info.dist?.integrity!==item.integrity||!info.dist.attestations?.url||!info.dist.attestations.provenance)throw new Error(`${item.name}: registry identity/integrity/provenance does not match the reviewed cohort`);
  const url=new URL(info.dist.tarball);if(url.origin!==new URL(registry).origin)throw new Error('Unexpected Registry artifact origin');
  const response=await fetch(url);if(!response.ok)throw new Error('Cannot read back published tarball');
  const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error(`${item.name}: registry bytes differ from reviewed tarball`);
  const proofURL=new URL(info.dist.attestations.url);if(proofURL.origin!==new URL(registry).origin)throw new Error('Unexpected provenance Registry origin');
  const proof=await fetch(proofURL);if(!proof.ok)throw new Error('Cannot read back Registry provenance');
  validateRegistryProvenance(await proof.json(),item,revision);
  console.log(JSON.stringify({package:item.name,version,integrity:item.integrity,sha256:item.sha256,provenance:info.dist.attestations.url,status:'READBACK_PASS'}));
}
if(mode==='publish'){
  for(const item of candidate.packages){
    // No automatic upload retries. An interrupted cohort resumes only after
    // existing immutable versions have passed exact-byte/provenance readback.
    if(await metadata(item))await verify(item);
    else{npm(['publish',item.filename,'--access','public','--registry',registry,'--tag','candidate','--provenance']);await verify(item);}
  }
  await appendFile(process.env.GITHUB_STEP_SUMMARY,'Uploaded and read back all six candidate versions. Cold public-Registry consumer acceptance must pass before latest promotion.\n');
}else{
  for(const item of candidate.packages)await verify(item);
  for(const item of candidate.packages)npm(['dist-tag','add',`${item.name}@${version}`,'latest','--registry',registry]);
  for(const item of candidate.packages){const r=await fetch(`${registry}${encodeURIComponent(item.name)}`);if(!r.ok||(await r.json())['dist-tags']?.latest!==version)throw new Error(`${item.name}: latest readback failed`);}
  await appendFile(process.env.GITHUB_STEP_SUMMARY,'Both Node consumer jobs passed. All six latest tags were promoted and read back; source tag and GitHub Release can now be finalized.\n');
}
