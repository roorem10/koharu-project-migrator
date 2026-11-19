import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const maps={};
const read=p=>fs.readFileSync(p,'utf8');
const put=(n,s)=>{maps[n]='data:text/javascript;base64,'+Buffer.from(s).toString('base64')};
for(const n of ['crypto','utils','_u64','_blake','_md','blake2','blake3']){
  const js=stripTypeScriptTypes(read('vendor/noble/src/'+n+'.ts'),{mode:'transform'})
    .replaceAll(/(['"])\.\/([^'"]+)\.ts\1/g,(_,q,name)=>q+'lib/'+name+q)
    .replaceAll('@noble/hashes/crypto','lib/crypto');
  put('lib/'+n,js);
}
put('lib/fflate',read('vendor/fflate.mjs'));
for(const n of ['legacy','pixels','migrate','discovery','destination','catalog-ui']) put('app/'+n,read('src/'+n+'.mjs'));
const licenses=['vendor/sql-LICENSE','vendor/noble/LICENSE','vendor/fflate-LICENSE','vendor/Koharu-LICENSE-MIT']
  .map(p=>read(p)).join('\n\n').replaceAll('&','&amp;').replaceAll('<','&lt;');
const replacements={__IMPORT_MAP__:JSON.stringify({imports:maps}),__LICENSES__:licenses,
  __SQLJS__:read('vendor/sql-wasm.js').replaceAll(/<\/script/gi,'<\\/script'),
  __WASM__:fs.readFileSync('vendor/sql-wasm.wasm').toString('base64')};
fs.mkdirSync('release',{recursive:true});
const html=read('src/interface.html').replace(/__IMPORT_MAP__|__LICENSES__|__SQLJS__|__WASM__/g,key=>replacements[key]);
fs.writeFileSync('release/Koharu-Project-Migrator.html',html);
if (fs.existsSync('desktop/go.mod')) fs.writeFileSync('desktop/ui.html',html);
