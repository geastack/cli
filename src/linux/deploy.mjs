import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {runLinux} from './adapter.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const digest = /^[a-f0-9]{64}$/
function refuse(message) { throw new Error(`Linux deployment: ${message}`) }
function regular(file, {privateKey=false}={}) {
  if(!path.isAbsolute(file)) refuse('an explicit absolute local file is required')
  const stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o022)||stat.uid!==process.getuid()) refuse(`unsafe local file: ${file}`)
  if(privateKey&&(stat.mode&0o077)) refuse('SSH identity must be private')
  return fs.readFileSync(file)
}
// Machine-local registration is the authority. --host/ambient SSH configuration
// never substitutes a destination or key for this entry.
export function validateLinuxBoard(board,{transportOnly=false}={}) {
  if(typeof process.getuid!=='function') refuse('native deployment currently requires a POSIX client')
  if(board?.target!=='raspberry-pi-os'||board?.appPlatform!=='raspberry-pi-os'||board?.adapter!=='linux-native') refuse('target raspberry-pi-os and adapter linux-native required')
  const s=board.transports?.ssh,d=board.linuxDeployment
  if(!s||!d) refuse('registered SSH and linuxDeployment configuration required')
  if(typeof s.host!=='string'||!s.host||s.host.length>253||!/^[A-Za-z0-9.:[\]-]+$/.test(s.host)||s.host.startsWith('-')) refuse('invalid registered SSH host')
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(s.user||'')) refuse('invalid registered SSH user')
  if(!Number.isInteger(s.port)||s.port<1||s.port>65535) refuse('explicit SSH port required')
  if(!identifier.test(s.hostKeyAlias||'')) refuse('explicit HostKeyAlias required')
  const known=regular(s.knownHosts).toString('utf8').split(/\r?\n/).filter(line=>line.trim()&&!line.startsWith('#'))
  if(known.length!==1) refuse('known_hosts must contain exactly one pinned identity')
  const fields=known[0].trim().split(/\s+/)
  if(fields.length!==3||fields[0]!==s.hostKeyAlias||!['ssh-ed25519','ssh-rsa','ecdsa-sha2-nistp256'].includes(fields[1])||!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[2])) refuse('known_hosts identity does not match HostKeyAlias')
  regular(s.identityFile,{privateKey:true})
  if(!/^\/[A-Za-z0-9_./-]+$/.test(d.releaseRoot||'')||d.releaseRoot.includes('/../')||d.releaseRoot==='/'||path.posix.normalize(d.releaseRoot)!==d.releaseRoot||d.releaseRoot.endsWith('/')) refuse('explicit absolute releaseRoot required')
  if(transportOnly)return {ssh:s,deployment:d}
  const hook=regular(d.hookSource)
  if(!digest.test(d.hookSha256||'')||sha(hook)!==d.hookSha256) refuse('reviewed transaction hook SHA mismatch')
  if(!d.profile||typeof d.profile!=='object'||Array.isArray(d.profile)) refuse('explicit transaction profile required')
  if(d.profile.audioOff!==true||d.profile.quiet!==true||typeof d.profile.stateDirectory!=='string'||!d.profile.stateDirectory.startsWith('/')) refuse('explicit quiet profile and absolute state directory required')
  const phases=['prepare','quiesce','backup','activate','verify','protect','observe','rollback','inspect']
  if(!d.profile.phaseTimeoutSeconds||Object.keys(d.profile.phaseTimeoutSeconds).sort().join(',')!==[...phases].sort().join(',')||phases.some(name=>!Number.isInteger(d.profile.phaseTimeoutSeconds[name])||d.profile.phaseTimeoutSeconds[name]<1||d.profile.phaseTimeoutSeconds[name]>600))refuse('explicit bounded per-phase timeouts required')
  if(!Number.isInteger(d.profile.transferTimeoutSeconds)||d.profile.transferTimeoutSeconds<1||d.profile.transferTimeoutSeconds>300)refuse('explicit bounded transfer timeout required')
  const p=d.profile
  if(path.posix.normalize(p.stateDirectory)!==p.stateDirectory||p.stateDirectory==='/') refuse('canonical state directory required')
  if(!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/.test(p.service||'')) refuse('explicit service unit required')
  if(!p.storage||!/^\/[A-Za-z0-9_./-]+$/.test(p.storage.program||'')||!digest.test(p.storage.sha256||'')||path.posix.normalize(p.storage.program)!==p.storage.program) refuse('explicit pinned storage program required')
  const session=p.session
  if(!session||!Number.isInteger(session.uid)||session.uid<0||session.runtimeDirectory!==`/run/user/${session.uid}`||!['x11','wayland'].includes(session.type)||typeof session.display!=='string'||!session.display||/[\r\n\0]/.test(session.display)) refuse('explicit graphical session profile required')
  return {ssh:s,deployment:d,hook}
}
export function sshArguments(s) {
  return ['-F','/dev/null','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`HostKeyAlias=${s.hostKeyAlias}`,'-o',`UserKnownHostsFile=${s.knownHosts}`,'-o','GlobalKnownHostsFile=/dev/null','-o','IdentitiesOnly=yes','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','ProxyCommand=none','-o','ProxyJump=none','-o','ClearAllForwardings=yes','-o','ControlMaster=no','-o','ControlPath=none','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-i',s.identityFile,'-p',String(s.port),'--',`${s.user}@${s.host}`]
}
export function verifyLinuxExecutable(file,env,execute=spawnSync) {
  const readelf=env.GEA_NATIVE_READELF,nm=env.GEA_NATIVE_NM
  for(const tool of [readelf,nm]) if(typeof tool!=='string'||!path.isAbsolute(tool)||!fs.statSync(tool).isFile()) refuse('explicit native readelf/nm tools required')
  const run=(tool,args)=>{const r=execute(tool,args,{encoding:'utf8',timeout:15000,maxBuffer:16*1024*1024});if(r.error||r.status!==0)refuse('native ELF inspection failed');return r.stdout}
  const header=run(readelf,['-h','-l',file]),dynamic=run(readelf,['-d',file]),symbols=run(nm,['-a','-C',file])
  if(!/Class:\s+ELF64/.test(header)||!/Data:.*little endian/i.test(header)||!/Machine:\s+AArch64/.test(header)||!/\bINTERP\b/.test(header)) refuse('native executable architecture/interpreter refused')
  if(!/Shared library: \[libSDL2[^\]]*\]/.test(dynamic)||/webkit|webview|javascriptcore/i.test(dynamic+symbols)) refuse('SDL renderer/no-WebView linkage refused')
  for(const symbol of ['rpios_display_present','gea::platform::display::Display::flush()']) if(!symbols.split('\n').some(line=>/\b[Tt]\s/.test(line)&&line.endsWith(symbol))) refuse('actual SDL presentation producer absent')
  for(const symbol of ['SDL_CreateWindow','SDL_CreateRenderer','SDL_RenderPresent']) if(!new RegExp('\\bU\\s+'+symbol+'(?:@[^\\s]+)?(?:\\s|$)').test(symbols)) refuse('actual SDL imports absent')
  return {headerSha256:sha(Buffer.from(header)),dynamicSha256:sha(Buffer.from(dynamic)),symbolsSha256:sha(Buffer.from(symbols))}
}
export function releasePayload(app) {
  if(!identifier.test(app.id)) refuse('invalid app id')
  const root=path.join(app.root,'dist/raspberry-pi-os',app.id), files=[]
  let total=0
  function add(name) {
    const file=path.join(root,name),before=fs.lstatSync(file)
    if(!before.isFile()||before.isSymbolicLink()) refuse(`nonregular release file: ${name}`)
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
    let st,data
    try {st=fs.fstatSync(fd);if(!st.isFile()||st.dev!==before.dev||st.ino!==before.ino||st.size>64*1024*1024)refuse(`nonregular/oversized release file: ${name}`);data=fs.readFileSync(fd);const after=fs.fstatSync(fd);if(data.length!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs)refuse('release changed while reading')} finally {fs.closeSync(fd)}
    total+=data.length
    if(total>128*1024*1024||files.length>=4096) refuse('release budget exceeded')
    files.push({path:name,size:data.length,mode:name===app.id?0o755:st.mode&0o777,sha256:sha(data),data:data.toString('base64')})
  }
  function walk(dir) {
    const st=fs.lstatSync(path.join(root,dir));if(!st.isDirectory()||st.isSymbolicLink()) refuse('unsafe resource directory')
    for(const name of fs.readdirSync(path.join(root,dir)).sort()) {
      if(!identifier.test(name)) refuse(`unsupported resource filename: ${name}`)
      const rel=`${dir}/${name}`,st=fs.lstatSync(path.join(root,rel))
      if(st.isDirectory()&&!st.isSymbolicLink())walk(rel);else add(rel)
    }
  }
  add(app.id)
  const elf=Buffer.from(files[0].data,'base64')
  if(elf.length<64||elf.subarray(0,4).toString('hex')!=='7f454c46'||elf[4]!==2||elf[5]!==1||elf.readUInt16LE(18)!==183||![2,3].includes(elf.readUInt16LE(16))||elf.readBigUInt64LE(24)===0n) refuse('executable must be nonzero-entry AArch64 ELF64')
  walk('resources')
  const manifest=files.map(({data,...entry})=>entry)
  return {app:app.id,release:sha(Buffer.from(JSON.stringify(manifest))),manifest,files}
}
const quote=s=>`'${s.replaceAll("'","'\\''")}'`
export function deployLinux({app,selection,env,dryRun=false,stdout=console.log,transaction=randomUUID(),authorizationFile='',action='deploy',execute=spawnSync}) {
  if(!selection.boardName)refuse('registered board alias required')
  if(!['deploy','inspect','rollback'].includes(action))refuse('invalid transaction action')
  if(env.GEA_LINUX_OUTPUT_DIR)refuse('output override refused for deployment')
  if(!/^[a-f0-9-]{36}$/.test(transaction))refuse('invalid transaction id')
  let authority=validateLinuxBoard(selection.linuxBoard,{transportOnly:action!=='deploy'})
  if(dryRun){stdout(`Linux native ${action} through strict SSH for registered board ${selection.boardName}; no connection opened`);return 0}
  let request={protocol:1,transaction,action,root:authority.deployment.releaseRoot}
  if(action==='deploy') {
    runLinux({app,env,stdout})
    authority=validateLinuxBoard(selection.linuxBoard)
    const executable=path.join(app.root,'dist/raspberry-pi-os',app.id,app.id),inspectedSha=sha(fs.readFileSync(executable))
    const architecture=verifyLinuxExecutable(executable,env),payload=releasePayload(app)
    if(payload.manifest[0].sha256!==inspectedSha)refuse('executable changed during inspection')
    request={...request,architecture,...payload,profile:authority.deployment.profile,hook:authority.hook.toString('base64'),hookSha256:authority.deployment.hookSha256}
  }
  if(authorizationFile) {
    const bytes=regular(authorizationFile);if(bytes.length>1024*1024)refuse('authorization budget')
    const authorization=JSON.parse(bytes)
    if(!['prepare','verify','observe','rollback'].includes(authorization.phase)||authorization.transaction!==transaction||(action==='deploy'&&(authorization.release!==request.release||authorization.hookSha256!==request.hookSha256)))refuse('authorization binding mismatch')
    request.authorization=authorization;request.authorizationSha256=sha(bytes);request.authorizationBytes=bytes.toString('base64')
  }
  if(action==='rollback'&&request.authorization?.phase!=='rollback')refuse('explicit rollback inspection/evidence packet required')
  const program=fs.readFileSync(new URL('./transaction.py',import.meta.url),'utf8')
  const args=[...sshArguments(authority.ssh),`/usr/bin/python3 -I -c ${quote(program)}`]
  // Recovery/inspection use the stored source/profile, whose maximum phase
  // budget is600s. They require neither a rebuild nor a replacement artifact.
  const seconds=action==='deploy'?Object.values(authority.deployment.profile.phaseTimeoutSeconds).reduce((a,b)=>a+b,0)+authority.deployment.profile.transferTimeoutSeconds+30:630
  const result=execute('ssh',args,{input:JSON.stringify(request),encoding:'utf8',maxBuffer:2*1024*1024,timeout:seconds*1000,env:{PATH:env.PATH||'/usr/bin:/bin',LANG:'C'}})
  if(result.error)throw result.error
  if(result.status!==0)refuse(`transaction failed; retain transaction ${transaction} for review: ${(result.stderr||'').slice(-2000)}`)
  let receipt;try{receipt=JSON.parse(result.stdout)}catch{refuse('invalid remote transaction receipt')}
  const allowed=action==='inspect'?['inspection']:action==='rollback'?['rolled_back']:['complete','pending_maintenance','pending_protected_boot','pending_transition_review','pending_candidate']
  if(receipt.transaction!==transaction||receipt.app!==app.id||(request.release&&receipt.release!==request.release)||!allowed.includes(receipt.status))refuse('unbound remote receipt')
  const bytes=JSON.stringify(receipt,null,2)+'\n',directory=path.join(app.root,'dist/raspberry-pi-os',app.id)
  fs.mkdirSync(directory,{recursive:true,mode:0o700})
  const out=path.join(directory,`deployment-${transaction}-${receipt.status}-${receipt.receipts.length}-${sha(Buffer.from(bytes)).slice(0,12)}.json`)
  if(fs.existsSync(out)){if(fs.readFileSync(out,'utf8')!==bytes)refuse('local receipt collision')}else fs.writeFileSync(out,bytes,{mode:0o600,flag:'wx'})
  stdout(`Linux deployment ${transaction}: ${receipt.historical?'historical completion (not a current observation)':receipt.status}; receipt ${out}`)
  return ['complete','inspection','rolled_back'].includes(receipt.status)?0:2
}
