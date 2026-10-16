import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {spawn,spawnSync} from 'node:child_process'
import {validateLinuxBoard,sshArguments,releasePayload,deployLinux,verifyLinuxExecutable} from '../src/linux/deploy.mjs'
import {createFixture,writeJson,capture} from './helpers/fixture.mjs'
import {runGea} from '../src/gea.mjs'
function fixtureOptions(s,out) {
  const file=path.join(s.f.root,'boards.json')
  assert.ok(file.startsWith(s.f.root+path.sep),'explicit boards fixture must be under its test root')
  return {...out.io,cwd:s.app.root,env:{...process.env,GEA_BOARDS_CONFIG:file}}
}
function fixtureRun(args,options,root) {
  const file=options.env?.GEA_BOARDS_CONFIG
  assert.ok(typeof file==='string'&&file.startsWith(root+path.sep),'write-capable test requires explicit owned boards fixture')
  return runGea(args,options)
}
const sha=b=>createHash('sha256').update(b).digest('hex')
function setup(t) {
  const f=createFixture(t),app={id:'watch',root:path.join(f.root,'apps/watch')}
  const knownHosts=path.join(f.root,'known_hosts'),identityFile=path.join(f.root,'identity'),hookSource=path.join(f.root,'hook.py')
  fs.writeFileSync(knownHosts,'authored-board ssh-ed25519 YXV0aG9yZWQ=\n',{mode:0o600});fs.writeFileSync(identityFile,'authored private fixture',{mode:0o600})
  fs.writeFileSync(hookSource,hook,{mode:0o600})
  const board={target:'raspberry-pi-os',appPlatform:'raspberry-pi-os',adapter:'linux-native',transports:{ssh:{host:'192.0.2.10',user:'tester',port:22,hostKeyAlias:'authored-board',knownHosts,identityFile}},linuxDeployment:{releaseRoot:path.join(fs.realpathSync(f.root),'releases'),hookSource,hookSha256:sha(Buffer.from(hook)),profile:{phaseTimeoutSeconds:Object.fromEntries(['prepare','quiesce','backup','activate','verify','protect','observe','rollback','inspect'].map(name=>[name,2])),transferTimeoutSeconds:2,audioOff:true,quiet:true,stateDirectory:'/authored-state',service:'authored.service',storage:{program:'/usr/local/sbin/authored-storage',sha256:'0'.repeat(64)},session:{uid:1000,runtimeDirectory:'/run/user/1000',type:'x11',display:':77'}}}}
  fs.mkdirSync(board.linuxDeployment.releaseRoot,{mode:0o700})
  const root=path.join(app.root,'dist/raspberry-pi-os/watch');fs.mkdirSync(path.join(root,'resources'),{recursive:true})
  const elf=Buffer.alloc(64);elf.write('7f454c46',0,'hex');elf[4]=2;elf[5]=1;elf.writeUInt16LE(2,16);elf.writeUInt16LE(183,18);elf.writeBigUInt64LE(64n,24)
  fs.writeFileSync(path.join(root,'watch'),elf,{mode:0o755});fs.writeFileSync(path.join(root,'resources','authored.txt'),'resource',{mode:0o644})
  return {f,app,board,root}
}
// The authored handler exercises the transaction transport only; it does not
// model a systemd/storage service or a protected boot.
const hook=`import json,sys,os\nc=json.load(sys.stdin);p=c['phase'];r={k:c[k] for k in ('protocol','transaction','release','phase')}\nr.update(bootId='boot-after' if p=='observe' else 'boot-before',status='ok')\nif p=='prepare':r.update(status='maintenance_ready',profileVerified=True,rollbackReady=True)\nif p=='quiesce':r.update(processReaped=True,flushed=True)\nif p=='backup':r.update(backupVerified=True,backupSha256='a'*64)\nif p in ('verify','observe'):r.update(releaseVerified=True,statePreserved=True,sessionVerified=True)\nif p=='observe':r['status']='protected'\nif p=='protect':r['rebootRequired']=True\nif p=='inspect':r.update(status='inspection',readOnly=True)\nif p=='rollback':r.update(status='rolled_back',statePreserved=True,rollbackVerified=True)\nprint(json.dumps(r))\n`
function request(s,transaction='12345678-1234-1234-1234-123456789abc') {const p=releasePayload(s.app);return {protocol:1,transaction,...p,root:s.board.linuxDeployment.releaseRoot,profile:s.board.linuxDeployment.profile,hook:Buffer.from(hook).toString('base64'),hookSha256:sha(Buffer.from(hook))}}
const transactionScript=new URL('../src/linux/transaction.py',import.meta.url).pathname
function remote(r) {return spawnSync('python3',[transactionScript],{input:JSON.stringify(r),encoding:'utf8',timeout:10000})}
test('registered SSH identity is explicit, strict and isolated from ambient configuration',t=>{
  const s=setup(t);validateLinuxBoard(s.board);const args=sshArguments(s.board.transports.ssh).join(' ')
  for(const value of ['-F /dev/null','BatchMode=yes','StrictHostKeyChecking=yes','HostKeyAlias=authored-board','ProxyCommand=none','ProxyJump=none','IdentitiesOnly=yes','ControlPath=none'])assert.ok(args.includes(value),value)
  assert.throws(()=>validateLinuxBoard({...s.board,transports:{ssh:{...s.board.transports.ssh,hostKeyAlias:'different'}}}),/identity/)
  fs.chmodSync(s.board.transports.ssh.identityFile,0o644);assert.throws(()=>validateLinuxBoard(s.board),/private/)
})
test('reviewed hook, quiet profile and registered destination refuse ambiguous authority',t=>{
  const s=setup(t)
  for(const mutate of [b=>b.transports.ssh.host='x;touch bad',b=>b.transports.ssh.port=0,b=>b.linuxDeployment.hookSha256='0'.repeat(64),b=>b.linuxDeployment.profile.quiet=false,b=>b.linuxDeployment.releaseRoot='/']) {const b=structuredClone(s.board);mutate(b);assert.throws(()=>validateLinuxBoard(b))}
})
test('regular exact release manifest refuses symlinks and wrong architecture',t=>{
  const s=setup(t),p=releasePayload(s.app);assert.equal(p.files.length,2);assert.equal(p.manifest[1].sha256,sha(Buffer.from('resource')))
  fs.symlinkSync('authored.txt',path.join(s.root,'resources','alias'));assert.throws(()=>releasePayload(s.app),/nonregular/)
  fs.unlinkSync(path.join(s.root,'resources','alias'));const bytes=fs.readFileSync(path.join(s.root,'watch'));bytes.writeUInt16LE(62,18);fs.writeFileSync(path.join(s.root,'watch'),bytes);assert.throws(()=>releasePayload(s.app),/AArch64/)
})
test('actual local transport stages exact bytes, returns pending, resumes only bound protected observation',t=>{
  const s=setup(t),r=request(s),first=remote(r);assert.equal(first.status,0,first.stderr)
  const receipt=JSON.parse(first.stdout);assert.equal(receipt.status,'pending_protected_boot')
  assert.equal(fs.readFileSync(path.join(r.root,'transaction-'+r.transaction,'release','resources','authored.txt'),'utf8'),'resource')
  const resumed=remote(r);assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).status,'complete')
  const different=structuredClone(r);different.profile.stateDirectory='/other';assert.notEqual(remote(different).status,0)
})
test('tampered payload never reaches handler or modifies an existing release',t=>{
  const s=setup(t),r=request(s);r.files[1].data=Buffer.from('changed').toString('base64')
  const result=remote(r);assert.notEqual(result.status,0);assert.match(result.stderr,/payload hash/)
})
test('failed activation retains inflight state and never automatically invokes rollback',t=>{
  const s=setup(t),r=request(s);const bad=hook.replace("if p=='protect':", "if p=='activate':sys.exit(9)\nif p=='protect':")
  r.hook=Buffer.from(bad).toString('base64');r.hookSha256=sha(Buffer.from(bad))
  const result=remote(r);assert.notEqual(result.status,0)
  const state=JSON.parse(fs.readFileSync(path.join(r.root,'transaction-'+r.transaction,'state.json')));assert.equal(state.next,'activate');assert.equal(state.failedPhase,'activate');assert.equal(state.inflight,'activate');assert.equal(state.receipts.some(x=>x.phase==='rollback'),false)
})
test('CLI registration and flash dry-run use native alias without network or repurposing',async t=>{
  const s=setup(t),config=path.join(s.f.root,'linux-board.json');writeJson(config,s.board)
  const pkg=path.join(s.app.root,'package.json'),m=JSON.parse(fs.readFileSync(pkg));m.gea.targets['raspberry-pi-os']=true;writeJson(pkg,m)
  const out=capture(),opts=fixtureOptions(s,out),run=(args)=>fixtureRun(args,opts,s.f.root)
  assert.equal(await run(['boards','add','authored-pi','--linux-config',config]),0)
  await assert.rejects(run(['boards','add','authored-pi','--linux-config',config]),/already exists/)
  assert.equal(await run(['flash','--board','authored-pi','--app','watch','--dry-run']),0)
  assert.match(out.out.join('\n'),/no connection opened/)
  await assert.rejects(run(['flash','--board','authored-pi','--host','other','--dry-run']),/registered SSH/)
})

test('write-capable harness rejects missing fixture authority before invoking CLI',t=>{const s=setup(t),out=capture();assert.throws(()=>fixtureRun(['boards','add'],{...out.io,env:{}},s.f.root),/explicit owned boards fixture/);assert.throws(()=>fixtureRun(['boards','add'],{...out.io,env:{GEA_BOARDS_CONFIG:'/not-owned/boards.json'}},s.f.root),/explicit owned boards fixture/)})

test('deployment renderer gate refuses backend-only ELF and WebView coexistence',t=>{
  const s=setup(t),tool=path.join(s.f.root,'inspection-tool');fs.writeFileSync(tool,'fixture',{mode:0o700})
  const env={GEA_NATIVE_READELF:tool,GEA_NATIVE_NM:tool}
  const outputs=['Class: ELF64\nData: little endian\nMachine: AArch64\nINTERP','Shared library: [libSDL2-2.0.so.0]','1 T rpios_display_present\n2 T gea::platform::display::Display::flush()\n U SDL_CreateWindow\n U SDL_CreateRenderer\n U SDL_RenderPresent']
  const inspect=(values)=>{let n=0;return verifyLinuxExecutable('authored-elf',env,()=>({status:0,stdout:values[n++]}))}
  assert.ok(inspect(outputs).headerSha256)
  assert.throws(()=>inspect([outputs[0],outputs[1],' U SDL_CreateWindow']),/producer/)
  assert.throws(()=>inspect([outputs[0],outputs[1]+' Shared library: [libWebKit.so]',outputs[2]]),/no-WebView/)
  assert.throws(()=>inspect([outputs[0].replace('INTERP',''),outputs[1],outputs[2]]),/architecture/)
})

test('maintenance pending does not advance mutation phases and wrong-boot observation refuses completion',t=>{
  const s=setup(t),r=request(s)
  const pending=hook.replace("status='maintenance_ready',profileVerified=True,rollbackReady=True","status='maintenance_required'")
  r.hook=Buffer.from(pending).toString('base64');r.hookSha256=sha(Buffer.from(pending))
  const result=remote(r);assert.equal(result.status,0,result.stderr)
  const receipt=JSON.parse(result.stdout);assert.equal(receipt.status,'pending_maintenance');assert.deepEqual(receipt.receipts.map(x=>x.phase),['prepare'])
  const s2=setup(t),r2=request(s2),sameBoot=hook.replace("'boot-after' if p=='observe' else 'boot-before'","'boot-before'")
  r2.hook=Buffer.from(sameBoot).toString('base64');r2.hookSha256=sha(Buffer.from(sameBoot))
  assert.equal(remote(r2).status,0);const second=remote(r2);assert.notEqual(second.status,0);assert.match(second.stderr,/reboot not observed/)
})
test('resume refuses altered staged bytes and uncertain prior mutation',t=>{
  const s=setup(t),r=request(s);assert.equal(remote(r).status,0)
  const dir=path.join(r.root,'transaction-'+r.transaction)
  fs.writeFileSync(path.join(dir,'release','resources','authored.txt'),'foreign')
  assert.match(remote(r).stderr,/hash mismatch/)
  fs.writeFileSync(path.join(dir,'release','resources','authored.txt'),'resource')
  const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));state.inflight='activate';fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(state))
  assert.match(remote(r).stderr,/interrupted phase/)
})

test('fresh release permissions are exact under restrictive inherited umask',t=>{
  const s=setup(t),r=request(s)
  const result=spawnSync('python3',['-c','import os,runpy,sys;os.umask(0o077);runpy.run_path(sys.argv[1],run_name="__main__")',new URL('../src/linux/transaction.py',import.meta.url).pathname],{input:JSON.stringify(r),encoding:'utf8',timeout:10000})
  assert.equal(result.status,0,result.stderr)
  const file=path.join(r.root,'transaction-'+r.transaction,'release','resources','authored.txt')
  assert.equal(fs.statSync(file).mode&0o777,0o644)
  fs.chmodSync(file,0o600);assert.match(remote(r).stderr,/mode changed/)
})

test('durable root ownership refuses a second UUID while pending and releases after protected completion',t=>{
  const s=setup(t),r=request(s),other=request(s,'87654321-4321-4321-4321-cba987654321')
  assert.equal(remote(r).status,0)
  const second=remote(other);assert.notEqual(second.status,0);assert.match(second.stderr,/retains active release-root ownership/)
  assert.equal(fs.existsSync(path.join(r.root,'transaction-'+other.transaction)),false)
  assert.equal(remote(r).status,0)
  assert.equal(remote(other).status,0)
})
test('different UUID concurrent invocation refuses before another hook side effect',async t=>{
  const s=setup(t),r=request(s),marker=path.join(s.f.root,'hook-entered')
  const held=hook.replace("c=json.load(sys.stdin);p=c['phase'];",`c=json.load(sys.stdin);p=c['phase'];\nif p=='prepare':\n open(${JSON.stringify(marker)},'w').write('entered');__import__('time').sleep(.5)\n`)
  r.hook=Buffer.from(held).toString('base64');r.hookSha256=sha(Buffer.from(held))
  const child=spawn('python3',[transactionScript],{stdio:['pipe','pipe','pipe']})
  child.stdin.end(JSON.stringify(r));let err='';child.stderr.on('data',b=>err+=b)
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code)=>resolve(code))})
  const deadline=Date.now()+3000
  while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(fs.existsSync(marker),true,'first actual handler reached barrier')
  const other={...r,transaction:'87654321-4321-4321-4321-cba987654321'},second=remote(other)
  assert.notEqual(second.status,0);assert.match(second.stderr,/another deployment invocation owns/)
  assert.equal(fs.existsSync(path.join(r.root,'transaction-'+other.transaction)),false)
  assert.equal(await done,0,err)
})

function authorize(r,auth){const raw=Buffer.from(JSON.stringify(auth));return {...r,authorization:auth,authorizationBytes:raw.toString('base64'),authorizationSha256:sha(raw)}}
test('pending candidate and transition review never advance protect; authorization bytes bind exact phase',t=>{
 const s=setup(t),r=request(s)
 const paused=hook.replace("if p=='prepare':", "if p=='verify':r.update(status='awaiting_acceptance')\nif p=='prepare':")
 r.hook=Buffer.from(paused).toString('base64');r.hookSha256=sha(Buffer.from(paused))
 const first=remote(r);assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).status,'pending_candidate')
 const dir=path.join(r.root,'transaction-'+r.transaction),before=fs.readFileSync(path.join(dir,'state.json'))
 const bad=authorize(r,{transaction:r.transaction,release:r.release,hookSha256:r.hookSha256,phase:'verify'});bad.authorizationBytes=Buffer.from('{}').toString('base64')
 assert.match(remote(bad).stderr,/authorization bytes/);assert.deepEqual(fs.readFileSync(path.join(dir,'state.json')),before)
 assert.equal(JSON.parse(before).receipts.some(x=>x.phase==='protect'),false)
 const s2=setup(t),r2=request(s2),transition=hook.replace("if p=='prepare':", "if p=='verify':r.update(status='awaiting_transition_approval')\nif p=='prepare':")
 r2.hook=Buffer.from(transition).toString('base64');r2.hookSha256=sha(Buffer.from(transition))
 const result=remote(r2);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'pending_transition_review')
 assert.equal(JSON.parse(result.stdout).receipts.some(x=>x.phase==='protect'),false)
})
test('read-only inspection and explicit rollback use stored hook and exact uncertain state authorization',t=>{
 const s=setup(t),r=request(s),bad=hook.replace("if p=='protect':", "if p=='activate':sys.exit(9)\nif p=='protect':")
 r.hook=Buffer.from(bad).toString('base64');r.hookSha256=sha(Buffer.from(bad));assert.notEqual(remote(r).status,0)
 const dir=path.join(r.root,'transaction-'+r.transaction),statepath=path.join(dir,'state.json'),raw=fs.readFileSync(statepath)
 const minimal={protocol:1,transaction:r.transaction,root:r.root,action:'inspect'}
 const observed=remote(minimal);assert.equal(observed.status,0,observed.stderr);const inspection=JSON.parse(observed.stdout)
 assert.equal(inspection.status,'inspection');assert.equal(inspection.transportStateSHA256,sha(raw));assert.deepEqual(fs.readFileSync(statepath),raw)
 const rollback={...minimal,action:'rollback'},auth={transaction:r.transaction,release:r.release,hookSha256:r.hookSha256,phase:'rollback',transportStateSHA256:'0'.repeat(64)}
 assert.match(remote(authorize(rollback,auth)).stderr,/state\/owner/);assert.deepEqual(fs.readFileSync(statepath),raw)
 const result=remote(authorize(rollback,{...auth,transportStateSHA256:sha(raw)}));assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'rolled_back')
 assert.equal(fs.existsSync(path.join(r.root,'active.json')),false)
 const final=JSON.parse(fs.readFileSync(statepath));assert.equal(final.recoveries[0].fromInflight,'activate');assert.equal(final.receipts.at(-1).phase,'rollback')
})
test('hook timeout kills and reaps its process group, preserves uncertainty and refuses automatic retry',async t=>{
 const s=setup(t),r=request(s),marker=path.join(s.f.root,'descendant.pid')
 const held=hook.replace("if p=='prepare':", `if p=='prepare':\n import subprocess,time\n child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])\n open(${JSON.stringify(marker)},'w').write(str(child.pid))\n time.sleep(30)\nif p=='prepare':`)
 r.hook=Buffer.from(held).toString('base64');r.hookSha256=sha(Buffer.from(held));r.profile.phaseTimeoutSeconds.prepare=1
 const started=Date.now(),result=remote(r);assert.notEqual(result.status,0);assert.ok(Date.now()-started<5000,result.stderr)
 assert.match(result.stderr,/timed out/);const state=JSON.parse(fs.readFileSync(path.join(r.root,'transaction-'+r.transaction,'state.json')))
 assert.equal(state.inflight,'prepare');assert.equal(state.receipts.length,0);assert.match(remote(r).stderr,/interrupted phase/)
 const pid=Number(fs.readFileSync(marker,'utf8'));let alive=true
 for(let n=0;n<100;n++){try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH'){alive=false;break}throw error}await new Promise(resolve=>setTimeout(resolve,10))}
 assert.equal(alive,false,'actual descendant must be absent after process-group timeout')
})

test('Node inspection and recovery dispatch use stored authority without build or local hook/artifact',t=>{
 const s=setup(t),transaction='12345678-1234-1234-1234-123456789abc',selection={boardName:'authored-pi',linuxBoard:s.board}
 fs.rmSync(s.root,{recursive:true});fs.unlinkSync(s.board.linuxDeployment.hookSource)
 const calls=[],execute=(program,args,options)=>{
  calls.push({program,args,options});const r=JSON.parse(options.input)
  assert.equal(program,'ssh');assert.equal(options.timeout,630000);assert.deepEqual(options.env,{PATH:'/usr/bin:/bin',LANG:'C'})
  assert.equal(r.transaction,transaction);assert.equal(r.files,undefined);assert.equal(r.hook,undefined);assert.equal(r.profile,undefined)
  return {status:0,stdout:JSON.stringify({app:s.app.id,transaction,release:'a'.repeat(64),status:r.action==='inspect'?'inspection':'rolled_back',receipts:[]})}
 }
 assert.equal(deployLinux({app:s.app,selection,env:{PATH:'/usr/bin:/bin'},transaction,action:'inspect',execute,stdout:()=>{}}),0)
 const auth=path.join(s.f.root,'recovery.json');fs.writeFileSync(auth,JSON.stringify({transaction,release:'a'.repeat(64),hookSha256:'b'.repeat(64),phase:'rollback',transportStateSHA256:'c'.repeat(64)}),{mode:0o600})
 assert.equal(deployLinux({app:s.app,selection,env:{PATH:'/usr/bin:/bin'},transaction,action:'rollback',authorizationFile:auth,execute,stdout:()=>{}}),0)
 assert.equal(calls.length,2);assert.match(calls[0].args.join(' '),/HostKeyAlias=authored-board/)
 assert.throws(()=>deployLinux({app:s.app,selection,env:{},transaction,action:'rollback',execute,stdout:()=>{}}),/explicit rollback/)
 assert.equal(calls.length,2,'missing recovery authority never opens SSH executor')
})

test('transport validates budget before spawn and reaps an exited-child cancellation race',()=>{
 const script=String.raw`import importlib.util,sys,subprocess
spec=importlib.util.spec_from_file_location('transport',sys.argv[1]);m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
c={'phase':'prepare','profile':{'phaseTimeoutSeconds':{'prepare':0}}}
spawned=[];errors=[]
def forbidden(*args,**kwargs):spawned.append(1);raise AssertionError('spawn before budget validation')
m.subprocess.Popen=forbidden
try:m.invoke(c,'/authored-unused')
except RuntimeError as e:assert str(e)=='phase budget'
except AssertionError as e:errors.append(str(e))
else:errors.append('malformed budget admitted')
if spawned:errors.append('malformed budget spawned child')
class ExitedChild:
 pid=12345
 def __init__(self):self.waited=0
 def communicate(self,*args,**kwargs):raise subprocess.TimeoutExpired('authored-hook',1)
 def wait(self):self.waited+=1;return 0
child=ExitedChild();m.subprocess.Popen=lambda *a,**k:child
c['profile']['phaseTimeoutSeconds']['prepare']=1
def gone(*args):raise ProcessLookupError('already exited')
m.os.killpg=gone
try:m.invoke(c,'/authored-unused')
except subprocess.TimeoutExpired:pass
except ProcessLookupError:errors.append('exit race replaced original timeout')
else:errors.append('timeout not preserved')
if child.waited!=1:errors.append('exit-racing child not waited')
assert not errors,errors
print('PASS malformed budget no spawn; exited child always reaped and original timeout retained')
`
 const result=spawnSync('python3',['-I','-c',script,new URL('../src/linux/transaction.py',import.meta.url).pathname],{encoding:'utf8',timeout:10000})
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS malformed budget no spawn/)
})
