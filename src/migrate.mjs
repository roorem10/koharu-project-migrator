import { digest } from 'app/legacy';
import { bounds, pngPixels, tick, writeTiles } from 'app/pixels';

const identity = () => [[1,0,0],[0,1,0]];
const namespace = 'org.koharu-migrator';
const points = entity => entity?.c.geometry?.points ?? [];
const clean = value => Object.fromEntries(Object.entries(value).filter(([,v]) => v !== null && v !== undefined));
const pathData = poly => poly.map(([x,y],i)=>(i?'L':'M')+x+' '+y).join(' ')+' Z';
const colors = rgba => rgba?.map(v=>v/255);
function derivedId(owner, tag) {
  const s=digest(new TextEncoder().encode('koharu-legacy-migration/'+owner+'/'+tag));
  // UUIDv8 names derived from stable legacy IDs. Repeating an import gives
  // every new block part and reference layer the same identity.
  const variant=((parseInt(s[16],16)&3)|8).toString(16);
  return s.slice(0,8)+'-'+s.slice(8,12)+'-8'+s.slice(13,16)+'-'+variant+s.slice(17,20)+'-'+s.slice(20,32);
}
const kindOf = e => {
  const reg=e?.c['analysis.region'];
  if (!reg) return '';
  if (/onomatopoeia|sound.effect|\bsfx\b/i.test((reg.label||'')+' '+reg.kind)) return 'sfx';
  return reg.kind.split('.').pop();
};
function makeLayer(kind,name,id,visibility) {
  const container=['block','group','balloon','panel'].includes(kind);
  return {id,name,visible:visibility?.visible??true,locked:false,opacity:visibility?.opacity??1,
    blend:container?'pass_through':'normal',attributes:{},kind,children:[]};
}
function part(owner,mask) {
  // Block parts contain the concrete mask/raster fields, without a "kind" tag.
  const item=makeLayer(mask?'mask':'raster','',derivedId(owner,mask?'mask':'cleanup')); delete item.kind;
  item.offset={x:0,y:0};
  if (mask) item.mode='add';
  return item;
}
function language(tag, notes) {
  if (!tag) return 'und';
  try {
    const formatted=new Intl.Locale(tag).baseName;
    if (formatted.toLowerCase()!==tag.toLowerCase()) notes.add('Some language tags were normalized. Original tags are in the legacy metadata.');
    return formatted;
  } catch {
    notes.add('An unrecognized language tag was stored as und. The original tag is in the legacy metadata.');
    return 'und';
  }
}
function textFrame(poly, layout, fit) {
  if (!poly?.length) return {frame:'point', transform:identity()};
  const b=bounds(poly);
  const angle=layout?.angle ?? (layout && poly.length===4
    ? Math.atan2(poly[1][1]-poly[0][1],poly[1][0]-poly[0][0])*180/Math.PI : 0);
  if (layout && (layout.kind==='point' || poly.length===4 || angle)) {
    // Undo the stored rotation before measuring the local text frame.
    const a=angle*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
    const local=bounds(poly.map(([x,y])=>[c*x+s*y,-s*x+c*y]));
    const x=c*local.x-s*local.y, y=s*local.x+c*local.y;
    const frame=layout.kind==='point'?'point':{box:{bounds:{x:0,y:0,width:Math.max(1,local.width),
      height:Math.max(1,local.height)},fit,anchor:'center'}};
    return {frame,transform:[[c,-s,x],[s,c,y]]};
  }
  if (b.width<=0 || b.height<=0) return {frame:'point',transform:[[1,0,b.x],[0,1,b.y]]};
  return {frame:{path:{path:pathData(poly),fit,anchor:'center',inset:0}},transform:identity()};
}
function makeText(value,style,poly,layout,defaultLanguage,direction,notes) {
  const chars=clean({family:style?.family,weight:style?.weight,italic:style?.fontStyle==null?null:
    style.fontStyle!=='normal',size:style?.size,fill:colors(style?.color),stroke:colors(style?.stroke),
    stroke_width:style?.strokeWidth});
  return {content:value?.text??'',language:language(value?.language||defaultLanguage,notes),
    style:{chars,align:style?.align ?? (layout?.kind==='point'||direction==='vertical'?'start':'center')},
    direction:direction==='vertical'?'vertical':'horizontal',
    ...textFrame(poly,layout,style?.auto===false?'none':'best')};
}
function mediaType(asset) { return /^image\/(png|jpeg|jpg|webp|bmp|gif|tiff)$/i.test(asset.type); }
function imageTransform(poly,w,h,notes) {
  if (poly.length===4 && w && h) {
    const [a,b,c,d]=poly;
    if (Math.abs(a[0]+c[0]-b[0]-d[0])+Math.abs(a[1]+c[1]-b[1]-d[1])<0.05)
      return [[(b[0]-a[0])/w,(d[0]-a[0])/h,a[0]],[(b[1]-a[1])/w,(d[1]-a[1])/h,a[1]]];
  }
  if (!poly.length) return identity();
  if (!w || !h) throw Error('Image dimensions could not be resolved.');
  const b=bounds(poly);
  notes.add('An irregular image frame was fitted to its bounding box.');
  return [[b.width/w,0,b.x],[0,b.height/h,b.y]];
}
async function fileBytes(project,hash) {
  const file=await project.getBlob(hash);
  if (!file) throw Error('An image was removed during conversion. Restore the project and try again.');
  const data=new Uint8Array(await file.arrayBuffer());
  if (digest(data)!==hash) throw Error('An image changed after folder inspection. Choose the project again.');
  return data;
}
async function storeFile(ctx,asset) {
  if (!ctx.stored.has(asset.blob)) {
    const data=await fileBytes(ctx.project,asset.blob);
    ctx.db.run('INSERT OR IGNORE INTO blobs VALUES (?,?)',[asset.blob,data]); ctx.stored.add(asset.blob);
  }
}
function encodedSize(bytes) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const tag=(at,n)=>String.fromCharCode(...bytes.subarray(at,at+n));
  if (bytes.length>=24 && bytes[0]===137 && tag(1,3)==='PNG') return [v.getUint32(16),v.getUint32(20)];
  if (bytes.length>=10 && tag(0,3)==='GIF') return [v.getUint16(6,true),v.getUint16(8,true)];
  if (bytes.length>=26 && tag(0,2)==='BM') return [v.getInt32(18,true),Math.abs(v.getInt32(22,true))];
  if (bytes.length>=30 && tag(0,4)==='RIFF' && tag(8,4)==='WEBP') {
    if (tag(12,4)==='VP8X') return [1+(v.getUint32(24,true)&0xffffff),1+(bytes[27]|bytes[28]<<8|bytes[29]<<16)];
    if (tag(12,4)==='VP8L') {const d=v.getUint32(21,true);return [1+(d&16383),1+((d>>>14)&16383)];}
    if (tag(12,4)==='VP8 ') return [v.getUint16(26,true)&16383,v.getUint16(28,true)&16383];
  }
  if (bytes[0]===255 && bytes[1]===216) {
    for (let at=2;at+4<bytes.length;) {
      if (bytes[at++]!==255) break;
      while (bytes[at]===255) at++;
      const marker=bytes[at++]; if (marker===217||marker===218) break;
      if ((marker>=208&&marker<=215)||marker===1) continue;
      if (at+2>bytes.length) break;
      const n=v.getUint16(at);if(n<2||at+n>bytes.length) break;
      if ((marker>=192 && marker<=207 && ![196,200,204].includes(marker)) && n>=7)
        return [v.getUint16(at+5),v.getUint16(at+3)];
      at+=n;
    }
  }
  return null;
}
async function dimensions(ctx,asset) {
  if (asset.width && asset.height) return [asset.width,asset.height];
  const file=await ctx.project.getBlob(asset.blob);
  if (!file) throw Error('An image was removed during conversion. Restore the project and try again.');
  const size=encodedSize(new Uint8Array(await file.arrayBuffer()));
  if(size?.every(n=>n>0)) return size;
  if(typeof createImageBitmap!=='function') throw Error('This image has no recorded size. Use the browser interface to read its dimensions.');
  const bitmap=await createImageBitmap(file);
  try {return [bitmap.width,bitmap.height];} finally {bitmap.close();}
}
function relationships(relations) {
  const lookup=new Map();
  for (const r of relations) {
    if (!lookup.has(r.from)) lookup.set(r.from,new Map());
    const map=lookup.get(r.from), kind=r.kind.replace('dev.koharu.relation.','');
    if (!map.has(kind)) map.set(kind,[]);
    map.get(kind).push(r.to);
  }
  return (entity,kind)=>lookup.get(entity?.id)?.get(kind)??[];
}
function describeBlock(state,layer,content,reg) {
  const {page,ctx,related,notes}=state;
  const layout=layer?.c['layer.text'], style=layer?.c['text.typography'];
  const src=content?.c['text.source'], translation=content?.c['text.translation'];
  const role=content?.c['text.role']?.role||'';
  const sfx=kindOf(reg)==='sfx'||/onomatopoeia|sound.effect|\bsfx\b/i.test(role);
  const b=makeLayer('block',sfx?'Sound effect':'Text',layer?.id??content?.id??reg?.id,layer?.c.visibility);
  const recognized=points(reg), authored=points(layer);
  const balloon=page.byId.get(related(layer,'flows-in')[0]) ??
    related(reg,'inside').map(id=>page.byId.get(id)).find(e=>kindOf(e)==='bubble');
  const fitTarget=page.byId.get(related(layer,'fits-to')[0]);
  let target=authored;
  if (!target.length) {
    if (balloon && (state.flowCount.get(balloon.id)??0) <= 1) target=points(balloon);
    if (!target.length) target=points(fitTarget).length?points(fitTarget):recognized;
  }
  const sourcePoints=recognized.length?recognized:target;
  if (!target.length && (src?.text || translation?.text)) notes.add('A text had no saved frame. Its wording is editable at the page origin.');
  let writing=style?.direction;
  const analysis=reg?.c['analysis.ocr'];
  // Koharu's old renderer also chose horizontal for non-CJK translation text
  // unless the user had authored an explicit writing mode.
  if (!(style?.origin==='user' && writing) && translation?.text) {
    const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(translation.text);
    if (!cjk) writing='horizontal';
    else if (!writing) {
      const rect=bounds(target);
      writing=analysis?.direction==='vertical'||(analysis?.direction!=='horizontal' && rect && rect.height>rect.width)?'vertical':'horizontal';
    }
  }
  b.role=sfx?'sfx':'text';
  b.source=makeText(src,null,sourcePoints,null,ctx.locales.source,analysis?.direction??style?.direction,notes);
  b.translation=translation ? makeText(translation,style,target,authored.length?layout:null,ctx.locales.targets?.[0],writing,notes) : null;
  b.mask=part(b.id,true); b.cleanup=part(b.id,false);
  b.attributes[namespace]=clean({content_id:content?.id,region_id:reg?.id,role:role||null,
    source_language:src?.language,target_language:translation?.language,typography:style,ocr:analysis,
    detection:reg?.c['analysis.detection'],source_origin:src?.origin,translation_origin:translation?.origin});
  if (content) state.used.add(content.id);
  if (reg) state.used.add(reg.id);
  if (recognized.length && !sfx) state.maskTargets.push([b.mask.id,recognized]);
  ctx.stats.blocks++; if (translation?.text) ctx.stats.translations++;
  return {block:b,region:reg,balloon};
}
function putBlock(state,list,item) {
  // Maintain original paint order. If an earlier balloon is no longer the last
  // sibling, leave the new block at its original position and record the link.
  const {block,balloon,region}=item;
  const parents=[];
  const panel=state.related(balloon||region,'inside').map(x=>state.page.byId.get(x)).find(e=>kindOf(e)==='panel');
  if (panel) parents.push(panel);
  if (balloon) parents.push(balloon);
  for (const e of parents) {
    if (points(e).length<3) continue;
    let container=state.containers.get(e.id);
    if (container) {
      if (list.at(-1)!==container) {
        block.attributes[namespace].legacy_container=e.id;
        state.notes.add('An interleaved text kept its original stacking position. Its balloon or panel ID is in the block metadata.');
        break;
      }
    } else {
      container=makeLayer(kindOf(e)==='panel'?'panel':'balloon',kindOf(e)==='panel'?'Panel':'Balloon',e.id,e.c.visibility);
      container.outline=pathData(points(e)); list.push(container); state.containers.set(e.id,container);
      state.used.add(e.id);
    }
    list=container.children;
  }
  list.push(block);
}
function base64(bytes) {
  let s=''; for (let i=0;i<bytes.length;i+=24576) s+=String.fromCharCode(...bytes.subarray(i,i+24576));
  return btoa(s);
}
async function buildPage(ctx,page) {
  const {root,entities,byId}=page, {notes}=ctx;
  const size={width:Math.ceil(root.c.page.width),height:Math.ceil(root.c.page.height)};
  for (const n of Object.values(size)) if (!Number.isInteger(n) || n<1 || n>0xffffffff)
    throw Error('The saved page dimensions cannot be represented by Koharu 0.85.');
  const allAssets=root.c.assets??{}, source=allAssets.source;
  const out={id:page.id,size,background:source?{file:source.blob,visible:true}:null,layers:[]};
  if (source) {await storeFile(ctx,source);ctx.stats.backgrounds++;}
  const state={ctx,page,notes,related:ctx.related,flowCount:new Map(),containers:new Map(),maskTargets:[],used:new Set()};
  const appearance=e=>e.c.visibility;
  for (const e of entities) {
    const flow=ctx.related(e,'flows-in')[0];
    if (flow) state.flowCount.set(flow,(state.flowCount.get(flow)??0)+1);
  }
  let textGroupList=null;
  async function append(e,list) {
    const c=e.c;
    const asset=c.assets?.source;
    if (c.group) {
      const group=makeLayer('group',c.group.name||'Group',e.id,appearance(e));
      list.push(group);
      if (c['text.group']) textGroupList=group.children;
      for (const child of e.children) await append(child,group.children);
    } else if (c['layer.text']) {
      const content=byId.get(ctx.related(e,'presents')[0]);
      if (!content) throw Error('A legacy text layer has no content link.');
      const region=byId.get(ctx.related(content,'recognized-from')[0]);
      putBlock(state,list,describeBlock(state,e,content,region));
    } else if (c['layer.raster']) {
      const layer=makeLayer('raster',c['layer.raster'].name,e.id,appearance(e));
      if (asset) {
        const data=await fileBytes(ctx.project,asset.blob), png=pngPixels(data);
        if (png && png.width===size.width && png.height===size.height) {
          ctx.stats.tiles+=await writeTiles(ctx.db,e.id,png);
        } else {
          if (!mediaType(asset)) throw Error('Unknown raster asset type '+asset.type+'.');
          layer.kind='image'; layer.file=asset.blob; await storeFile(ctx,asset);
          const [w,h]=png ? [png.width,png.height] : await dimensions(ctx,asset);
          layer.transform=[[size.width/w,0,0],[0,size.height/h,0]];
          notes.add('A raster with nonstandard dimensions or encoding was kept as an image layer with its original bytes and page placement.');
        }
      }
      layer.attributes[namespace]={legacy_raster_kind:c['layer.raster'].kind};
      if (layer.kind==='raster') ctx.stats.rasters++;
      list.push(layer);
    } else if (asset && c.geometry && !c['analysis.region']) {
      await storeFile(ctx,asset);
      const [w,h]=await dimensions(ctx,asset);
      const layer=makeLayer('image','Image',e.id,appearance(e));
      layer.file=asset.blob; layer.transform=imageTransform(points(e),w,h,notes); list.push(layer);
    }
  }
  for (const child of root.children) await append(child,out.layers);
  const fallbackList=textGroupList??out.layers;
  // OCR may have finished even if the page has never been typeset.
  for (const e of entities) if (e.c['text.content'] && !state.used.has(e.id)) {
    const reg=byId.get(ctx.related(e,'recognized-from')[0]);
    putBlock(state,fallbackList,describeBlock(state,null,e,reg));
  }
  for (const e of entities) {
    const kind=kindOf(e);
    if (state.used.has(e.id)) continue;
    if (kind==='text'||kind==='sfx') putBlock(state,fallbackList,describeBlock(state,null,null,e));
  }
  // Keep empty detected containers editable, including panels with no dialogue.
  for (const wanted of ['panel','bubble']) for (const e of entities) {
    if (state.used.has(e.id)||kindOf(e)!==wanted||points(e).length<3) continue;
    const panel=ctx.related(e,'inside').map(id=>state.containers.get(id)).find(layer=>layer?.kind==='panel');
    const layer=makeLayer(wanted==='panel'?'panel':'balloon',wanted==='panel'?'Panel':'Balloon',e.id,appearance(e));
    layer.outline=pathData(points(e)); (panel?.children??fallbackList).push(layer);
    state.containers.set(e.id,layer); state.used.add(e.id);
  }
  // Keep the full-page legacy masks as original files. The old format did not
  // assign glyph pixels to individual text blocks; split only identifiable areas.
  const metadata=makeLayer('group','Legacy data · '+(root.c.page.label||'Page'),derivedId(page.id,'legacy'));
  metadata.visible=false;
  const extra=[];
  const unsupported=[];
  
  for (const e of entities) {
    for (const entry of e.unknown) extra.push({owner:e.id,key:entry.key,schema:entry.schema,
      payload:base64(entry.payload),record_refs:entry.ids,blob_refs:entry.blobs});
    for (const [role,asset] of Object.entries(e.c.assets??{})) {
      if (role==='source' && (e===root||e.c['layer.raster']||(!e.c['analysis.region'] && e.c.geometry))) continue;
      if (!mediaType(asset)) {unsupported.push({entity:e.id,role,hash:asset.blob});continue;}
      await storeFile(ctx,asset);
      const keep=makeLayer('image',role,derivedId(e.id,'asset/'+role));keep.file=asset.blob;keep.attributes[namespace]={entity:e.id,role};
      metadata.children.push(keep);
    }
    if (e.c['analysis.region'] && !state.used.has(e.id))
      extra.push({owner:e.id,region:e.c['analysis.region'],points:points(e),analysis:e.c['analysis.detection']});
  }
  const mask=allAssets['text-mask'];
  if (mask) {
    const img=pngPixels(await fileBytes(ctx.project,mask.blob));
    if (img && img.width===size.width && img.height===size.height) {
      for (const [layer,poly] of state.maskTargets) ctx.stats.tiles+=await writeTiles(ctx.db,layer,img,poly);
    } else notes.add('An unusual page mask was kept as a hidden original image. Individual block masks could not be derived.');
  }
  if (unsupported.length) notes.add(unsupported.length+' non-image asset reference(s) on '+root.c.page.label+' are listed in Legacy data. Their bytes stay in the original folder.');
  if (extra.length) notes.add('Additional legacy analysis or extension data was preserved as metadata on '+root.c.page.label+'.');
  metadata.attributes[namespace]={page_label:root.c.page.label,old_project:ctx.project.id,old_revision:ctx.project.revision,
    locales:ctx.locales,additional_components:extra,unmapped_assets:unsupported};
  out.layers.unshift(metadata);
  return out;
}
const schema=`
 PRAGMA page_size=16384;
 PRAGMA auto_vacuum=INCREMENTAL;
 PRAGMA application_id=0x4B485255;
 CREATE TABLE project(id TEXT PRIMARY KEY,version TEXT NOT NULL,pages TEXT NOT NULL) STRICT;
 CREATE TABLE pages(id TEXT PRIMARY KEY,page TEXT NOT NULL) STRICT;
 CREATE TABLE tiles(layer TEXT NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL,hash TEXT NOT NULL,
   PRIMARY KEY(layer,x,y)) STRICT, WITHOUT ROWID;
 CREATE TABLE blobs(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL) STRICT;`;

export function checkDatabase(db) {
  const scalar=query=>db.exec(query)[0]?.values?.[0]?.[0];
  if (scalar('PRAGMA application_id')!==0x4B485255 || scalar('PRAGMA integrity_check')!=='ok' ||
      scalar('SELECT count(*) FROM project')!==1) throw Error('Output database integrity check failed.');
  const [version,ordered]=db.exec('SELECT version,pages FROM project')[0].values[0], order=JSON.parse(ordered);
  const known=new Set(db.exec('SELECT hash FROM blobs')[0]?.values.map(r=>r[0])??[]);
  const owners=new Set(), layerIDs=new Set(), pageIDs=new Set();
  function visit(layer) {
    if (layerIDs.has(layer.id)) throw Error('A layer ID occurs twice in the output.');
    layerIDs.add(layer.id);
    if (layer.kind==='image' && !known.has(layer.file)) throw Error('Missing output image.');
    if (layer.kind==='raster' || layer.kind==='mask' || layer.kind===undefined) owners.add(layer.id);
    if (layer.kind==='block') {visit(layer.mask);visit(layer.cleanup);}
    for (const child of layer.children??[]) visit(child);
  }
  for (const [id,json] of db.exec('SELECT id,page FROM pages')[0]?.values??[]) {
    const p=JSON.parse(json);
    if (p.id!==id || (p.background && !known.has(p.background.file))) throw Error('Output page or scan is missing.');
    pageIDs.add(id); p.layers.forEach(visit);
  }
  if (version!=='1.0.0' || pageIDs.size!==order.length || new Set(order).size!==order.length ||
      order.some(id=>!pageIDs.has(id))) throw Error('Output page order is inconsistent.');
  for (const [id] of db.exec('SELECT DISTINCT layer FROM tiles')[0]?.values??[])
    if (!owners.has(id)) throw Error('A tile has no editable layer.');
  if (scalar('SELECT count(*) FROM tiles LEFT JOIN blobs USING(hash) WHERE blobs.hash IS NULL')!==0)
    throw Error('Output tile bytes are missing.');
}
export async function migrate(SQL,project,progress) {
  const db=new SQL.Database();
  const stats={pages:0,backgrounds:0,blocks:0,translations:0,rasters:0,tiles:0};
  const notes=new Set(project.notes);
  const ctx={db,project,stats,notes,stored:new Set(),related:relationships(project.relations),
    locales:project.rootComponents.values.project??{source:null,targets:[]}};
  const otherRelations=project.relations.filter(r=>!['presents','recognized-from','fits-to','flows-in','inside']
    .includes(r.kind.replace('dev.koharu.relation.','')) || r.entry.unknown.length || Object.keys(r.entry.values).length);
  if (otherRelations.length || project.rootComponents.unknown.length)
    notes.add('Project-level extensions or custom relationships have no native equivalent. They remain in the original project.');
  let bytes;
  try {
    db.run(schema);db.run('BEGIN');
    db.run('INSERT INTO project VALUES (?,?,?)',[project.id,'1.0.0',JSON.stringify(project.pages.map(p=>p.id))]);
    for (const [index,page] of project.pages.entries()) {
      progress('Converting page '+(index+1)+' of '+project.pages.length+' · '+(page.root.c.page.label||'Untitled'));
      await tick();
      const out=await buildPage(ctx,page);
      db.run('INSERT INTO pages VALUES (?,?)',[out.id,JSON.stringify(out)]);
      stats.pages++;
    }
    db.run('COMMIT');progress('Verifying the new project…');await tick();
    bytes=db.export();
  } finally {db.close();}
  const reopened=new SQL.Database(bytes);
  try {checkDatabase(reopened);} finally {reopened.close();}
  return {bytes, stats, notes:[...notes]};
}
