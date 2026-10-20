import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {runGea} from '../src/gea.mjs'
import {capture, createFixture, writeJson} from './helpers/fixture.mjs'

test('Linux native target dispatches only the declared SDL target without board or web fallback', async t => {
  const f=createFixture(t), app=path.join(f.root,'apps/watch'), pkg=path.join(app,'package.json')
  const m=JSON.parse(fs.readFileSync(pkg));m.gea.targets['raspberry-pi-os']=true;writeJson(pkg,m)
  const linux=path.join(f.root,'node_modules/@geastack/linux')
  writeJson(path.join(linux,'package.json'),{name:'@geastack/linux',version:'0.0.0'})
  const script=path.join(linux,'targets/raspberry-pi-os/build-raspberry-pi-os.sh')
  fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,'exit 0\n')
  const out=capture()
  assert.equal(await runGea(['build','--target','raspberry-pi-os','--dry-run'],{...out.io,cwd:app,env:process.env}),0)
  // The script path is shell-quoted where it needs it, as a Windows path with its backslashes does.
  assert.match(out.out.join('\n'),/^bash '?.*build-raspberry-pi-os\.sh'? watch$/m)
  assert.doesNotMatch(out.out.join('\n'),/vite|build-web|flash/)
})
test('Linux native target refuses undeclared target', async t => {
  const f=createFixture(t),out=capture()
  await assert.rejects(runGea(['build','--target','raspberry-pi-os','--dry-run'],{...out.io,cwd:path.join(f.root,'apps/watch'),env:process.env}),/does not declare/)
})

test('Linux adapter executes the native script once and propagates build failure', async t => {
  const f=createFixture(t),app=path.join(f.root,'apps/watch'),pkg=path.join(app,'package.json')
  const m=JSON.parse(fs.readFileSync(pkg));m.gea.targets['raspberry-pi-os']=true;writeJson(pkg,m)
  const linux=path.join(f.root,'linux'),script=path.join(linux,'targets/raspberry-pi-os/build-raspberry-pi-os.sh'),log=path.join(f.root,'calls')
  fs.mkdirSync(path.dirname(script),{recursive:true})
  fs.writeFileSync(script,'test "$1" = watch || exit 90\ntest -f "$GEA_BUILD_CONFIG_JSON" || exit 91\ntest -f "$GEA_CLI_BIN" || exit 92\nprintf "native-build\\n" >> "$GEA_TEST_LOG"\nexit 7\n')
  const out=capture()
  await assert.rejects(runGea(['build','--target','raspberry-pi-os'],{...out.io,cwd:app,env:{...process.env,GEA_LINUX_ROOT:linux,GEA_TEST_LOG:log}}),/Linux native build failed \(7\)/)
  assert.equal(fs.readFileSync(log,'utf8'),'native-build\n')
})

test('native SDL producer requests renderer replacement and reaps the whole failed compile batch', async () => {
  const {fileURLToPath}=await import('node:url'),{spawnSync}=await import('node:child_process')
  const script=fileURLToPath(new URL('../../linux/targets/raspberry-pi-os/build-raspberry-pi-os.sh',import.meta.url))
  const source=fs.readFileSync(script,'utf8')
  assert.match(source,/--gea-replace-renderers/)
  assert.doesNotMatch(source,/CXX_SOURCES\+=\("\$TARGET_DIR\/main\/rpios_storage_bridge\.cpp"\)/)
  const wait=source.slice(source.indexOf('wait_slot() {'),source.indexOf('\ncompile_one()'))
  const child=spawnSync('bash',['-c',`J=2; running=2; PIDS=(); (exit 7) & PIDS+=($!); (sleep .05; echo sibling-reaped) & PIDS+=($!); ${wait}
wait_slot; echo unexpected-success`],{encoding:'utf8',timeout:3000})
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,1)
  assert.match(child.stdout,/sibling-reaped/);assert.doesNotMatch(child.stdout,/unexpected-success/)
})
