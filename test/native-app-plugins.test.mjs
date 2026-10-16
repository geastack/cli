import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import test from 'node:test'
import {runGea} from '../src/gea.mjs'
import {capture,createFixture,writeJson} from './helpers/fixture.mjs'
import {appCompilerPlugins} from '../../apple/packages/geastack-apple/targets/macos/app-compiler-plugins.mjs'
const apple=fileURLToPath(new URL('../../apple/packages/geastack-apple',import.meta.url)),cli=fileURLToPath(new URL('../bin/gea.mjs',import.meta.url))
test('actual apps-inspect declared host plugins feed actual Mac extraArgs once and fingerprint bytes',async t=>{
 const f=createFixture(t),app=path.join(f.root,'apps/watch'),manifest=path.join(app,'package.json'),plugin=path.join(app,'native/host.mjs')
 fs.mkdirSync(path.dirname(plugin));fs.writeFileSync(plugin,'// authored app host mapping\n')
 const m=JSON.parse(fs.readFileSync(manifest));m.gea.compilerPlugins=['native/host.mjs'];writeJson(manifest,m)
 const out=capture();assert.equal(await runGea(['apps','inspect','watch','--json'],{...out.io,cwd:app,env:process.env}),0)
 const meta=JSON.parse(out.out.join('\n')),selected=appCompilerPlugins(meta);assert.deepEqual(selected.paths,[fs.realpathSync(plugin)])
 const source=fs.readFileSync(path.join(apple,'targets/macos/build-macos.sh'),'utf8'),first=source.indexOf('  # Explicit app-owned host mappings'),last=source.indexOf('  if [[ "$appRuntime" == "apple-native" ]]',first),block=source.slice(first,last)
 assert(first>=0&&last>first)
 const child=spawnSync('bash',['-c',`set -eu\nextraArgs=(--extra-geatsc-plugin "$EXPECTED_PLUGIN"); forward(){\n${block}\n}\nforward\nprintf '<%s>\\n' "\${extraArgs[@]}"`],{cwd:app,env:{...process.env,GEA_CLI:cli,ROOT_DIR:apple,id:'watch',EXPECTED_PLUGIN:plugin},encoding:'utf8',timeout:15000})
 assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,`<--extra-geatsc-plugin>\n<${plugin}>\n`)
 fs.appendFileSync(plugin,'// changed generation input\n');assert.notEqual(appCompilerPlugins(meta).fingerprint,selected.fingerprint)
 fs.unlinkSync(plugin);assert.throws(()=>appCompilerPlugins(meta),/ENOENT/)
})
test('declared plugin helper refuses path ambiguity and malformed registry',()=>{
 for(const entry of ['../foreign.mjs','/absolute.mjs','native/line\nbreak.mjs'])assert.throws(()=>appCompilerPlugins({root:apple,compilerPlugins:[entry]}),/Invalid/)
 assert.throws(()=>appCompilerPlugins({root:'relative',compilerPlugins:[]}),/absolute/)
 assert.throws(()=>appCompilerPlugins({root:apple,compilerPlugins:'host.mjs'}),/Invalid/)
})
