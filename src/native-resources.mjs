import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const exists=file=>{try{fs.lstatSync(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
function fileHash(file){const fd=fs.openSync(file,'r'),hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1048576);try{for(;;){const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;hash.update(buffer.subarray(0,count))}return hash.digest('hex')}finally{fs.closeSync(fd)}}
const safeName=value=>typeof value==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !['Fonts','FontLicenses','Frameworks','MacOS'].includes(value)
export function resolveNativeResources(root, target, raw = {}) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('nativeResources must be a destination-to-directory object')
 if(Object.keys(raw).length && !['macos','raspberry-pi-os'].includes(target))throw Error(`nativeResources are not supported by ${target}`)
 const base=fs.realpathSync(root),result={};let count=0,total=0
 for(const [name,value]of Object.entries(raw)){
  if(!safeName(name)||typeof value!=='string'||!value||path.isAbsolute(value)||value.split(/[\\/]/).includes('..')||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid nativeResources destination or source')
  const source=path.resolve(base,value),relative=path.relative(base,fs.realpathSync(source));if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('nativeResources escapes app')
  function walk(dir){if(!fs.lstatSync(dir).isDirectory())throw Error('nativeResources directory must not be a symlink');for(const entry of fs.readdirSync(dir)){const file=path.join(dir,entry),stat=fs.lstatSync(file);if(stat.isDirectory())walk(file);else if(stat.isFile()){if(++count>4096||(total+=stat.size)>1073741824)throw Error('nativeResources exceeds build asset bound')}else throw Error('nativeResources accepts only regular files and directories')}}
  walk(source);result[name]=source
 }
 return result
}
export function syncNativeResources(root,target,raw,output){
 const resources=resolveNativeResources(root,target,raw);fs.mkdirSync(output,{recursive:true});if(!fs.lstatSync(output).isDirectory())throw Error('Resource output must be a directory')
 const ledger=path.join(output,'.gea-native-resources.json');let previous=[]
 if(exists(ledger)){if(!fs.lstatSync(ledger).isFile())throw Error('Invalid resource ledger');previous=JSON.parse(fs.readFileSync(ledger,'utf8')).destinations;if(!Array.isArray(previous)||previous.some(v=>!safeName(v)))throw Error('Invalid resource ledger destinations')}
 const hashes={};const desired={}
 for(const [name,source]of Object.entries(resources)){const scan=dir=>{for(const entry of fs.readdirSync(dir).sort()){const file=path.join(dir,entry),stat=fs.lstatSync(file);if(stat.isDirectory())scan(file);else if(stat.isFile())desired[name+'/'+path.relative(source,file)]=fileHash(file);else throw Error('Resource source changed')}};scan(source)}
 let unchanged=previous.length===Object.keys(resources).length && previous.every(name=>Object.hasOwn(resources,name))
 const actual={};if(unchanged){for(const name of previous){const directory=path.join(output,name);if(!exists(directory)||!fs.lstatSync(directory).isDirectory()){unchanged=false;break}const scan=dir=>{for(const entry of fs.readdirSync(dir).sort()){const file=path.join(dir,entry),stat=fs.lstatSync(file);if(stat.isDirectory())scan(file);else if(stat.isFile())actual[path.relative(output,file)]=fileHash(file);else unchanged=false}};scan(directory)} }
 if(unchanged && JSON.stringify(actual)===JSON.stringify(desired))return {changed:false,destinations:Object.keys(resources),files:desired}
 for(const [name,source]of Object.entries(resources)){
  const destination=path.join(output,name);if(exists(destination)&&!previous.includes(name))throw Error(`Native resource destination already exists without ownership: ${name}`)
  if(exists(destination)&&!fs.lstatSync(destination).isDirectory())throw Error('Invalid owned resource destination')
  const temporary=path.join(output,`.gea-resource-${name}-${crypto.randomUUID()}`)
  try{fs.cpSync(source,temporary,{recursive:true,dereference:false});const verify=dir=>{for(const entry of fs.readdirSync(dir)){const f=path.join(dir,entry),s=fs.lstatSync(f);if(s.isDirectory())verify(f);else if(s.isFile()){const rel=path.relative(temporary,f);const sourceHash=fileHash(path.join(source,rel)),copyHash=fileHash(f);if(sourceHash!==copyHash||sourceHash!==desired[name+'/'+rel])throw Error('Resource copy changed');hashes[name+'/'+rel]=copyHash}else throw Error('Resource changed to nonregular entry')}};verify(temporary);const expectedKeys=Object.keys(desired).filter(key=>key.startsWith(name+'/'));if(expectedKeys.some(key=>!Object.hasOwn(hashes,key)))throw Error('Resource copy is incomplete');fs.rmSync(destination,{recursive:true,force:true});fs.renameSync(temporary,destination)}finally{fs.rmSync(temporary,{recursive:true,force:true})}
 }
 for(const name of previous)if(!(Object.hasOwn(resources,name))){const old=path.join(output,name);if(exists(old)&&!fs.lstatSync(old).isDirectory())throw Error('Invalid removed resource destination');fs.rmSync(old,{recursive:true,force:true})}
 const result={changed:true,destinations:Object.keys(resources),files:hashes};fs.writeFileSync(ledger,JSON.stringify(result,null,2)+'\n');return result
}
