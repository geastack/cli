import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {resolveNativeResources,syncNativeResources} from '../src/native-resources.mjs'
test('real resources copy bytes, remove only owned stale namespaces, preserve unrelated fonts',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gea-resources-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'prepared'),output=path.join(root,'output');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'asset'),'actual source bytes');fs.mkdirSync(path.join(output,'Fonts'),{recursive:true});fs.writeFileSync(path.join(output,'Fonts','user'),'keep');const first=syncNativeResources(root,'macos',{Engine:'prepared'},output);assert.equal(Object.keys(first.files).length,1);assert.equal(fs.readFileSync(path.join(output,'Engine','asset'),'utf8'),'actual source bytes');fs.unlinkSync(path.join(source,'asset'));fs.writeFileSync(path.join(source,'next'),'new');syncNativeResources(root,'macos',{Engine:'prepared'},output);assert.equal(fs.existsSync(path.join(output,'Engine','asset')),false);syncNativeResources(root,'macos',{},output);assert.equal(fs.existsSync(path.join(output,'Engine')),false);assert.equal(fs.readFileSync(path.join(output,'Fonts','user'),'utf8'),'keep')
})
test('resource authority refuses escaping/symlink/special sources and unowned destination collision',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gea-resources-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'source'));fs.symlinkSync('/tmp',path.join(root,'source','foreign'));assert.throws(()=>resolveNativeResources(root,'macos',{Engine:'source'}),/regular/);fs.unlinkSync(path.join(root,'source','foreign'));for(const [name,value]of [['../Engine','source'],['Fonts','source'],['Engine','../outside'],['Engine','']])assert.throws(()=>resolveNativeResources(root,'macos',{[name]:value}));assert.throws(()=>resolveNativeResources(root,'sailfish-os',{Engine:'source'}));const output=path.join(root,'output');fs.mkdirSync(path.join(output,'Engine'),{recursive:true});assert.throws(()=>syncNativeResources(root,'macos',{Engine:'source'},output),/without ownership/)
})

test('source disappearance before copy refuses incomplete replacement and preserves owned output',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gea-resources-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source'),output=path.join(root,'output');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'asset'),'old');syncNativeResources(root,'macos',{Engine:'source'},output);fs.writeFileSync(path.join(source,'asset'),'new');
 const copy=fs.cpSync;fs.cpSync=(from,to,options)=>{fs.unlinkSync(path.join(source,'asset'));return copy(from,to,options)};
 try{assert.throws(()=>syncNativeResources(root,'macos',{Engine:'source'},output),/incomplete/)}finally{fs.cpSync=copy}
 assert.equal(fs.readFileSync(path.join(output,'Engine','asset'),'utf8'),'old');assert.equal(fs.readdirSync(output).some(name=>name.startsWith('.gea-resource-')),false)
})
