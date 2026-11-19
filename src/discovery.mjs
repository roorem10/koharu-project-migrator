const legacy = name => /\.khrproj$/i.test(name);
const modern = name => /\.khr$/i.test(name) && !/^state-[ab]\.khr$/i.test(name);
const wantedFile = path => /^state-[ab]\.khr$/.test(path) || /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function legacyHeader(file) {
  try { return new TextDecoder().decode(await file.slice(0,8).arrayBuffer()) === 'KHRSTATE'; }
  catch { return false; }
}

export function makeRow(path, kind, get) {
  const name = path.split('/').pop();
  return {path, name, title:name.replace(kind === 'legacy' ? /\.khrproj$/i : /\.khr$/i, '') || name, kind, get};
}

export function sortRows(rows) {
  const order = new Intl.Collator(undefined, {numeric:true, sensitivity:'base'});
  return rows.sort((a,b) => (a.kind === b.kind ? 0 : a.kind === 'legacy' ? -1 : 1) ||
    order.compare(a.title,b.title) || order.compare(a.path,b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function getFile(directory, relative) {
  if (!wantedFile(relative)) return null;
  try {
    const parts = relative.split('/');
    for (const name of parts.slice(0,-1)) directory = await directory.getDirectoryHandle(name);
    return await (await directory.getFileHandle(parts.at(-1))).getFile();
  } catch (error) {
    if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') return null;
    throw error;
  }
}

// Project images are requested only when a chapter is opened. A directly
// selected, renamed backup can still be recognized by its save signature.
export async function discoverHandle(root, update, signal) {
  const rows = [], pending = [{dir:root, path:root.name}];
  let skipped = 0, folders = 0, names = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const {dir,path} = pending.pop();
    folders++;
    if (legacy(dir.name)) {
      rows.push(makeRow(path, 'legacy', name => getFile(dir, name)));
      continue;
    }
    try {
      let isSelectedSave = false;
      for await (const entry of dir.values()) {
        const child = path+'/'+entry.name;
        if (entry.kind === 'directory') pending.push({dir:entry,path:child});
        else if (dir === root && !isSelectedSave && entry.kind === 'file' && /^state-[ab]\.khr$/.test(entry.name)) {
          try { isSelectedSave = await legacyHeader(await entry.getFile()); } catch { /* An unreadable slot may have a readable sibling. */ }
        }
        else if (entry.kind === 'file' && modern(entry.name)) rows.push(makeRow(child,'current'));
        if (++names % 200 === 0) { update(folders,rows.length); await pause(); signal?.throwIfAborted(); }
      }
      if (isSelectedSave) rows.push(makeRow(path,'legacy',name => getFile(dir,name)));
    } catch (error) {
      if (dir === root || signal?.aborted) throw error;
      skipped++;
    }
  }
  return {root:root.name, rows:sortRows(rows), skipped};
}

// Folder-input browsers provide relative filenames. Keep only files with legacy project roles.
export async function discoverFiles(files, update, signal) {
  const rows = new Map();
  let selectedSave = false;
  let root = '', count = 0;
  for (const file of files) {
    if (++count % 400 === 0) { update(null,rows.size); await pause(); signal?.throwIfAborted(); }
    const relative = file.webkitRelativePath;
    if (!relative) continue;
    const parts = relative.split('/');
    root ||= parts[0];
    if (!selectedSave && parts.length === 2 && /^state-[ab]\.khr$/.test(parts[1]) && !legacy(root)) {
      selectedSave = await legacyHeader(file);
    }
    const i = parts.slice(0,-1).findIndex(legacy);
    if (i >= 0) {
      const path = parts.slice(0,i+1).join('/');
      if (!rows.has(path)) {
        const entries = new Map();
        const row = makeRow(path,'legacy',name => entries.get(name));
        rows.set(path,{row,entries});
      }
      const inner = parts.slice(i+1).join('/');
      if (wantedFile(inner)) rows.get(path).entries.set(inner,file);
    } else if (modern(parts.at(-1))) {
      rows.set(relative, {row:makeRow(relative,'current')});
    }
  }
  if (selectedSave) {
    const entries = new Map();
    for (const file of files) {
      const inner = file.webkitRelativePath.slice(root.length+1);
      if (wantedFile(inner)) entries.set(inner,file);
    }
    rows.set(root,{row:makeRow(root,'legacy',name => entries.get(name))});
  }
  return {root, rows:sortRows(Array.from(rows.values(),v => v.row)), skipped:0};
}

export async function rememberFolder(action, handle, key = 'last') {
  if (!globalThis.indexedDB) return null;
  let db;
  try {
    db = await new Promise((resolve,reject) => {
      const open = indexedDB.open('koharu-project-folders',1);
      open.onupgradeneeded = () => open.result.createObjectStore('folders');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(Error('Folder memory unavailable'));
    });
    return await new Promise((resolve,reject) => {
      const transaction = db.transaction('folders',action === 'get' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('folders');
      const request = action === 'get' ? store.get(key) : handle ? store.put(handle,key) : store.delete(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } catch { return null; }
  finally { db?.close(); }
}

export async function nativeScan(request, signal) {
  const response = await request('scan', signal);
  if (!response.ok) throw Error('The Windows scanner could not open Documents. Choose another folder below.');
  const result = await response.json();
  return {root:result.root, skipped:result.skipped, currentFolders:result.currentFolders||[], rows:sortRows(result.rows.map(item => {
    const get = async relative => {
      if (!wantedFile(relative)) return null;
      const file = relative.startsWith('blobs/') ? 'blob/'+relative.split('/').pop() : relative;
      const response = await request('project/'+item.id+'/'+file);
      if (response.status === 404) return null;
      if (!response.ok) throw Error('Windows could not read this project file. If it is stored online, make the project available on this device and retry.');
      return response.blob();
    };
    const row=makeRow(item.path,item.kind,item.kind === 'legacy' ? get : undefined);
    if (/^[a-z]:\/|^\/\//i.test(row.path)) row.displayPath=row.path.replaceAll('/','\\');
    return row;
  }))};
}
