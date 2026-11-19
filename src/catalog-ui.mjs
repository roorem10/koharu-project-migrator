import {outputControl} from 'app/destination';
import {discoverFiles, discoverHandle, nativeScan, rememberFolder} from 'app/discovery';
import {readProjectSource} from 'app/legacy';
import {migrate} from 'app/migrate';

const el = id => document.getElementById(id);
const plural = (n,one,many=one+'s') => n+' '+(n===1 ? one : many);
const friendly = error => error?.message || String(error);
function message(id,text,error=false) {
  const node=el(id);
  node.textContent=text;
  node.classList.toggle('error',error);
}
function notice(id,text) {
  el(id).textContent=text;
  el(id).hidden=!text;
}
function filename(name) {
  const clean=name.replace(/\.khrproj$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').toWellFormed();
  const encoder=new TextEncoder();
  let stem='', bytes=0;
  for (const character of clean) {
    const n=encoder.encode(character).length;
    if (stem.length+character.length>120 || bytes+n>220) break;
    stem+=character;bytes+=n;
  }
  stem=stem.replace(/[. ]+$/,'') || 'Project';
  return (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)?'_':'')+stem+' (migrated)';
}

export async function start() {
  const native = document.querySelector('meta[name="koharu-edition"]').content === 'windows';
  const request = (leaf,signal,options={}) => fetch(new URL(leaf,window.location.href),{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',...options,signal});
  const urls = new Set();
  let active = false, locationKind = '', handle = null, catalog = null, selected = null, engine = null;
  let userAction = false, pendingScan = null, finished = null;
  const output=outputControl(native,request,updateSaveButton);
  function updateSaveButton() {
    const retry=el('retrySave');
    retry.hidden=!finished || finished.saved || !output.canSave();
    retry.disabled=active;
  }

  function controls() {
    el('scan').disabled=el('other').disabled=el('manual').disabled=active;
    for (const button of el('rows').querySelectorAll('button')) button.disabled=active;
    el('scan').textContent = native ? (locationKind === 'native' ? 'Rescan project folders' : 'Scan project folders') :
      locationKind === 'handle' ? 'Rescan '+handle.name :
      locationKind === 'reconnect' ? 'Reconnect to '+handle.name :
      locationKind === 'files' && !native ? 'Choose folder again' : 'Scan Documents';
  }
  function setBusy(value) {
    active=value;
    controls();output.busy(value);updateSaveButton();
  }
  function clearResult() {
    finished=null;el('result').hidden=true;
    message('transfer',''); el('save').textContent='Download .khr';
    el('ready').hidden=true;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    for (const id of ['save','report','detailReport']) el(id).removeAttribute('href');
    notice('warnings','');
  }
  function link(id,data,mime,name) {
    const previous=el(id).href;
    if(urls.has(previous)){URL.revokeObjectURL(previous);urls.delete(previous);}
    const blob=data instanceof Blob?data:new Blob([data],{type:mime});
    const url=URL.createObjectURL(blob);
    urls.add(url); el(id).href=url; el(id).download=name;return blob;
  }
  function goTo(id) { el(id).focus(); }
  function renderRows() {
    const term=el('filter').value.trim().replaceAll('\\','/').toLocaleLowerCase();
    const list=el('rows');
    list.replaceChildren();
    if (!catalog) return;
    const matching=catalog.rows.filter(row => row.path.toLocaleLowerCase().includes(term));
    for (const row of matching) {
      const item=document.createElement('li'), info=document.createElement('div');
      item.className='row';
      const title=document.createElement('strong'), path=document.createElement('span');
      title.textContent=row.title; path.textContent=row.displayPath || row.path; path.className='path';
      info.append(title,path); item.append(info);
      if (row.kind==='legacy') {
        const button=document.createElement('button');
        button.type='button';
        button.textContent=row.converted ? 'Convert again' : 'Convert';
        button.setAttribute('aria-label',button.textContent+' '+row.path);
        button.disabled=active;
        button.addEventListener('click',()=>convert(row));
        item.append(button);
      } else {
        const tag=document.createElement('span');
        tag.className='tag'; tag.textContent='Already .khr'; item.append(tag);
      }
      list.append(item);
    }
    el('empty').hidden=matching.length>0;
    el('empty').textContent=catalog.rows.length ? 'No projects match this search.' :
      'No Koharu projects found. Try Documents → Koharu, or choose the folder where you keep your chapters or backups.';
  }
  async function scan(kind, directory, files) {
    if (active) return;
    setBusy(true);
    pendingScan=new AbortController();
    const signal=pendingScan.signal;
    el('cancel').hidden=false;
    const label=kind==='native' ? 'your project folders' : directory?.name || 'the selected folder';
    const progress=(folders,count)=>message('scanStatus',folders==null ? 'Searching… '+plural(count,'project')+' found.' :
      'Searching '+label+'… '+plural(folders,'folder')+' checked · '+plural(count,'project')+' found.');
    message('scanStatus','Searching '+label+' and its subfolders…');
    try {
      let found;
      if (kind==='native') found=await nativeScan(request,signal);
      else if (kind==='handle') found=await discoverHandle(directory,progress,signal);
      else found=await discoverFiles(files,progress,signal);
      signal.throwIfAborted();
      catalog=found; clearResult(); selected=null;
      el('filter').value=''; notice('skip','');
      locationKind=kind;
      if(kind==='native') output.known(found.currentFolders);
      handle=kind==='handle' ? directory : null;
      if (!native) await rememberFolder('put',handle);
      el('rootName').textContent=catalog.root || 'Selected folder';
      const legacy=catalog.rows.filter(row => row.kind==='legacy').length;
      el('count').textContent=plural(catalog.rows.length,'project')+' · '+legacy+' to convert · '+(catalog.rows.length-legacy)+' already .khr';
      el('searchBox').hidden=catalog.rows.length<2;
      el('catalog').hidden=false; message('scanStatus','');
      if (catalog.skipped) notice('skip',plural(catalog.skipped,'folder or entry','folders or entries')+' could not be scanned. You can choose an accessible project folder directly.');
      renderRows();
    } catch (error) {
      if (signal.aborted) {
        message('scanStatus','Scan cancelled. You can choose a smaller folder.');
      } else if (kind==='handle' && ['NotAllowedError','SecurityError'].includes(error.name)) {
        handle=directory; locationKind='reconnect';
        message('scanStatus','Folder access is needed. Reconnect to this folder or choose another one.',true);
      } else {
        message('scanStatus',kind==='native' ? 'Windows could not find an accessible project folder. Reopen the Windows launcher to retry, or choose another folder.' : 'Scan stopped. '+friendly(error),true);
      }
    } finally { pendingScan=null; el('cancel').hidden=true; setBusy(false); }
  }
  function standardPicker() {
    el('folder').value='';
    el('folder').click();
  }
  async function pick(documents) {
    if (typeof window.showDirectoryPicker!=='function') { standardPicker(); return; }
    try {
      const chosen=await window.showDirectoryPicker({mode:'read',id:documents?'koharu-documents':'koharu-other',startIn:'documents'});
      await scan('handle',chosen);
    } catch (error) {
      if (error.name!=='AbortError') message('scanStatus','Use “Browse folders” to select Documents or a Koharu folder in this browser.',true);
      else message('scanStatus','You can select a folder when you’re ready. If the browser blocked Documents, use “Browse folders” or select Documents → Koharu.');
      el('manual').hidden=false;
    }
  }
  async function saveFinished() {
    if (!finished || !output.canSave()) return;
    message('transfer','Saving the verified project…');
    try {
      const saved=await output.save(finished.blob,finished.name);
      finished.saved=true;
      el('save').download=saved.name;
      el('resultName').textContent=saved.name+' · '+(finished.blob.size/1048576).toFixed(2)+' MiB';
      const location=saved.folder+'/'+saved.name;
      link('detailReport',finished.detailReport+'\n\nSaved to: '+location,'text/plain;charset=utf-8',saved.name.slice(0,-4)+'-report.txt');
      el('resultTitle').textContent=finished.title+' is saved';
      message('transfer','Saved to '+location);
      el('save').textContent='Download another copy';
      el('openHint').textContent=saved.koharu || saved.folder.toLowerCase()==='projects'
        ? 'Open Koharu and select '+saved.name.slice(0,-4)+' on the start screen. If Koharu is already open, reopen it to refresh the list.'
        : 'This copy is in your chosen folder. Place it in the projects folder used by Koharu to see it on the start screen.';
    } catch(error) {
      message('transfer','Conversion succeeded. Automatic saving could not finish. '+friendly(error)+' Your download is ready below.',true);
    }
    updateSaveButton();
  }
  async function convert(row) {
    if (active) return;
    setBusy(true); clearResult(); selected=row;
    el('result').hidden=false;
    el('resultTitle').textContent='Converting '+row.title;
    el('resultName').textContent=row.path;
    message('status','Checking the saved project…'); goTo('resultTitle');
    const progress=text=>message('status',text);
    try {
      await output.beforeConvert();
      const project=await readProjectSource({folder:row.name,get:row.get},progress);
      progress('Starting the project writer…');
      if (!engine) {
        const wasm=Uint8Array.from(atob(el('wasm').textContent.trim()),c=>c.charCodeAt(0));
        engine=await window.initSqlJs({wasmBinary:wasm});
      }
      const {bytes,stats,notes}=await migrate(engine,project,progress);
      const stem=filename(project.folder), name=stem+'.khr';
      const fields={Pages:stats.pages,'Original scans':stats.backgrounds,'Text blocks':stats.blocks,Translations:stats.translations,'Raster layers':stats.rasters};
      el('counts').replaceChildren();
      for (const [key,value] of Object.entries(fields)) {
        const group=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
        dt.textContent=key; dd.textContent=value; group.append(dt,dd); el('counts').append(group);
      }
      const fileInfo=name+' · '+(bytes.length/1048576).toFixed(2)+' MiB';
      const counts=Object.entries(fields).map(([key,value])=>key+': '+value);
      const summary=['Koharu conversion summary','Target format: 1.0.0',...counts,'Pixel tiles: '+stats.tiles,
        'Review notes: '+notes.length].join('\n');
      const detailReport=['Koharu project migration',row.path,'Legacy save: '+project.slot+' · revision '+project.revision,
        'Document ID: '+project.id,'Suggested output: '+fileInfo,'Target: Koharu SQLite project format 1.0.0','',
        ...counts,'Pixel tiles: '+stats.tiles,'',
        'Page order',...project.pages.map((p,i)=>(i+1)+'. '+p.root.c.page.label+' · '+p.id),'',
        'Review notes',...notes,'Legacy cleanup is a page layer. Text fitting can change in the newer editor.',
        'Provider settings are configured separately in Koharu.'].join('\n');
      const blob=link('save',bytes,'application/octet-stream',name);
      finished={blob,name,title:row.title,detailReport,saved:false};
      link('report',summary,'text/plain;charset=utf-8','Koharu-conversion-summary.txt');
      link('detailReport',detailReport,'text/plain;charset=utf-8',stem+'-report.txt');
      el('resultTitle').textContent=row.title+' is ready';
      el('resultName').textContent=fileInfo;
      message('status','Recovered revision '+project.revision+' from '+project.slot+'.');
      notice('warnings',notes.join('\n')); el('ready').hidden=false; row.converted=true;
      el('openHint').textContent='For a manual download, close Koharu, copy the .khr into its projects folder, and reopen Koharu.';
      if (output.canSave()) await saveFinished();
      else message('transfer','Your .khr is ready to download. You can also choose a save folder above.');
      renderRows(); goTo(finished.saved?'resultTitle':'save');
    } catch (error) {
      el('resultTitle').textContent='Couldn’t convert '+row.title;
      message('status',friendly(error),true);
    } finally { setBusy(false); }
  }
  el('retrySave').addEventListener('click',async()=>{
    if(active||!finished) return;
    setBusy(true);try {await saveFinished();} finally {setBusy(false);}
  });
  output.setup();
  el('scan').addEventListener('click',async()=>{
    userAction=true;
    if (active) return;
    if (native) { await scan('native'); return; }
    if (locationKind==='reconnect' || locationKind==='handle') {
      try {
        const permission=await handle.requestPermission({mode:'read'});
        if (permission==='granted') { await scan('handle',handle); return; }
      } catch { /* The saved handle may no longer exist. */ }
      locationKind='reconnect'; controls();
      message('scanStatus','The browser needs folder access. Choose another folder to select it again.'); return;
    }
    if (locationKind==='files') { standardPicker(); return; }
    await pick(true);
  });
  el('other').addEventListener('click',()=>{userAction=true; return pick(false);});
  el('manual').addEventListener('click',()=>{userAction=true; standardPicker();});
  el('cancel').addEventListener('click',()=>pendingScan?.abort());
  el('folder').addEventListener('change',async()=>{
    userAction=true;
    const files=el('folder').files;
    if (!files.length) {
      message('scanStatus','This folder is empty or no files were selected. Choose a folder containing your chapters.');
      return;
    }
    try { await scan('files',null,files); }
    finally { el('folder').value=''; }
  });
  el('filter').addEventListener('input',renderRows);
  el('back').addEventListener('click',()=>{
    const name=selected?.path;
    const buttons=el('rows').querySelectorAll('button');
    const match=Array.from(buttons).find(button=>button.getAttribute('aria-label')?.endsWith(' '+name));
    (match||el('libraryTitle')).focus();
  });
  if (native) {
    el('intro').textContent='Choose Convert beside a chapter. When you finish, close the last migrator tab to exit the launcher.';
    await scan('native'); return;
  }
  const [previous]=await Promise.all([rememberFolder('get'),output.restore()]);
  if (!previous || userAction) return;
  let granted=false;
  try { granted=(await previous.queryPermission({mode:'read'}))==='granted'; } catch { return; }
  if (userAction) return;
  if (granted) await scan('handle',previous);
  else {
    handle=previous; locationKind='reconnect'; controls();
    message('scanStatus','Reconnect to '+handle.name+' to scan the folder you used last time.');
  }
}
