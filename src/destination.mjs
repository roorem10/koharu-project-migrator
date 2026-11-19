import {rememberFolder} from 'app/discovery';

const el=id=>document.getElementById(id);
const numbered=(name,i)=>i===1 ? name : name.slice(0,-4)+' ('+i+').khr';

async function writeNewFile(directory,blob,name) {
  for (let n=1;;n++) {
    const next=numbered(name,n);
    try { await directory.getFileHandle(next); continue; }
    catch (error) {
      if (error.name==='TypeMismatchError') continue;
      if (error.name!=='NotFoundError') throw error;
    }
    const file=await directory.getFileHandle(next,{create:true});
    let writable, initial;
    try {
      initial=await file.getFile();
      if (initial.size) continue;
      writable=await file.createWritable({mode:'exclusive'});
      initial=await file.getFile();
      if (initial.size) { await writable.abort(); continue; }
      await writable.write(blob);
      const unchanged=await file.getFile();
      if (unchanged.size || unchanged.lastModified!==initial.lastModified) { await writable.abort(); continue; }
      await writable.close();
      return {name:next,folder:directory.name};
    } catch (error) {
      if (writable) { try { await writable.abort(); } catch {} }
      if (error.name==='NoModificationAllowedError') throw Error('The destination is locked. Close the other writer or use Download .khr.');
      // Remove only this attempt's unchanged, empty reservation after a failed write.
      if (initial && !initial.size) {
        try {
          const existing=await directory.getFileHandle(next), current=await existing.getFile();
          if (await file.isSameEntry(existing) && !current.size && current.lastModified===initial.lastModified) await directory.removeEntry(next);
        } catch {}
      }
      throw error;
    }
  }
}

export function automaticDestination(known) {
  const running=known.filter(item=>item.running);
  return running.length===1 ? running[0].id : known.length===1 ? known[0].id : '';
}

export function outputControl(native,request,changed) {
  const select=el('output');
  let known=[], handle=null, granted=false, choice='', explicit=false, busy=false, serial=0;
  const picker=()=>typeof window.showDirectoryPicker==='function';
  function option(value,label) {
    const node=document.createElement('option'); node.value=value; node.textContent=label; select.append(node);
  }
  function render() {
    select.replaceChildren();
    for (const item of known) option(item.id,item.label+(item.running?' · running Koharu':''));
    if (handle) option('folder','Selected folder · '+handle.name);
    if (picker()) option('ask','Choose a save folder when I convert');
    option('download','Download manually');
    if (!choice || !(known.some(x=>x.id===choice)||choice==='download'||(choice==='folder'&&handle)||(choice==='ask'&&picker()))) {
      choice=automaticDestination(known)||(picker()?'ask':'download');
    }
    select.value=choice;
    const selected=known.find(item=>item.id===choice);
    el('chooseOutput').hidden=!picker();
    el('allowOutput').hidden=choice!=='folder'||granted;
    el('copyOutput').hidden=!selected;
    select.disabled=el('chooseOutput').disabled=el('allowOutput').disabled=el('copyOutput').disabled=busy;
    el('outputHint').textContent=selected ? 'Convert saves each finished .khr directly into this folder.' :
      choice==='folder' ? (granted?'Convert saves each finished .khr in your selected folder.':'Click Allow saving to reconnect to this folder.') :
      choice==='ask' ? (known.length>1?'Choose the Koharu installation you use, or pick a destination when you convert.':'On your first conversion, select the projects folder next to koharu.exe. On Windows, try %LOCALAPPDATA%\\Koharu\\projects.') :
      'Use Download .khr after conversion to save a copy.';
    changed();
  }
  function note(text) { el('outputNote').textContent=text; }
  async function choose() {
    if (!picker()) return false;
    serial++;
    try {
      const options={id:'koharu-output',mode:'readwrite'};
      if (handle) options.startIn=handle;
      const picked=await window.showDirectoryPicker(options);
      if (/\.khrproj$/i.test(picked.name)) { note('Choose the newer Koharu projects folder. This is a legacy chapter folder.');return false; }
      const permission=await picked.queryPermission({mode:'readwrite'});
      handle=picked;granted=permission==='granted';choice='folder';explicit=true;
      if (!native) await rememberFolder('put',handle,'output');
      note(picked.name.toLowerCase()==='projects'?'':'This folder is named “'+picked.name+'”. Koharu lists chapters from the projects folder in its installation.');render();return granted;
    } catch (error) {
      note(error.name==='AbortError'?'No new destination selected.':'The browser could not open this folder for writing. You can use the Windows launcher or Download .khr.');
      return false;
    }
  }
  select.addEventListener('change',()=>{
    serial++;explicit=true;choice=select.value;note('');render();
    if (!native) void rememberFolder('put',choice==='folder'?handle:null,'output');
  });
  el('chooseOutput').addEventListener('click',choose);
  async function authorize() {
    if (!handle) return;
    try {granted=(await handle.requestPermission({mode:'readwrite'}))==='granted';} catch {granted=false;}
    note(granted?'':'Write access is still unavailable. Choose another folder or download manually.');render();
  }
  el('allowOutput').addEventListener('click',authorize);
  el('copyOutput').addEventListener('click',async()=>{
    const item=known.find(x=>x.id===choice);
    if (!item) return;
    try {await navigator.clipboard.writeText(item.path);note('Projects folder path copied.');}
    catch {note(item.path);}
  });
  return {
    setup(){render();},
    async restore(){
      if (native || !picker()) return;
      const checkpoint=serial;
      const previous=await rememberFolder('get',null,'output');
      if (!previous || checkpoint!==serial) return;
      let permission;
      try {permission=await previous.queryPermission({mode:'readwrite'});} catch{return;}
      if(checkpoint!==serial) return;
      handle=previous;granted=permission==='granted';choice='folder';render();
    },
    known(folders){
      known=folders||[];
      if (!explicit) choice=automaticDestination(known)||'';
      else if (!known.some(item=>item.id===choice) && !['download','ask','folder'].includes(choice)) choice='download';
      render();
    },
    busy(value){busy=value;select.disabled=el('chooseOutput').disabled=el('allowOutput').disabled=el('copyOutput').disabled=value;},
    canSave(){return known.some(x=>x.id===choice)||(choice==='folder'&&granted);},
    async beforeConvert(){
      if(choice==='folder' && !granted) {await authorize();return;}
      if(choice==='ask') {
        const ok=await choose();
        if (!ok && choice==='ask') {choice='download';render();}
      }
    },
    async save(blob,name){
      const dest=known.find(x=>x.id===choice);
      if (dest) {
        const resp=await request('save/'+dest.id,undefined,{method:'POST',mode:'same-origin',referrerPolicy:'origin',headers:{'Content-Type':'application/octet-stream','X-Koharu-Save':'1','X-Koharu-Name':encodeURIComponent(name)},body:blob});
        if (!resp.ok) throw Error((await resp.text()).trim() || 'Windows could not save the project.');
        const saved=await resp.json();
        return {name:saved.name, folder:dest.label, koharu:true};
      }
      if (!handle||choice!=='folder'||!granted) throw Error('Select a projects folder and allow saving first.');
      const directory=handle;
      if (await directory.queryPermission({mode:'readwrite'})!=='granted') {
        granted=false;render();throw Error('Folder permission expired. Click Allow saving, then Save to selected folder.');
      }
      const job=()=>writeNewFile(directory,blob,name);
      if(globalThis.navigator?.locks) return navigator.locks.request('koharu-new-project-file',job);
      return job();
    }
  };
}
