import { blake3 } from 'lib/blake3';
import { bytesToHex } from 'lib/utils';

export const hex = bytesToHex;
export const digest = bytes => hex(blake3(bytes));
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_STATE = 512 * 1024 * 1024;

function requireValue(value, message) {
  if (!value) throw new Error(message);
}
class Unsupported extends Error {}

// The revision crate writes a revision prefix for derived structs and enums.
// SourceText, Translation and Authored are hand-written exceptions in Koharu.
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  take(length) {
    requireValue(Number.isSafeInteger(length) && length >= 0 && length <= this.bytes.length - this.at,
      'A legacy record ends unexpectedly.');
    const result = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return result;
  }
  byte() { return this.take(1)[0]; }
  num() {
    const tag = this.byte();
    if (tag < 251) return tag;
    requireValue(tag <= 253, 'Invalid integer in the legacy save.');
    const length = 1 << (tag - 250);
    const at = this.at;
    this.take(length);
    if (length === 2) return this.view.getUint16(at, true);
    if (length === 4) return this.view.getUint32(at, true);
    const n = Number(this.view.getBigUint64(at, true));
    requireValue(Number.isSafeInteger(n), 'The legacy integer exceeds the supported range.');
    return n;
  }
  float(size) {
    const at = this.at;
    this.take(size);
    const n = size === 4 ? this.view.getFloat32(at, true) : this.view.getFloat64(at, true);
    requireValue(Number.isFinite(n), 'Invalid coordinate or style number.');
    return n;
  }
  rev(type, max = 1) {
    const n = this.num();
    if (n < 1 || n > max) throw new Unsupported('Unsupported ' + type + ' revision ' + n + '.');
    return n;
  }
  flag() {
    const byte = this.byte();
    requireValue(byte <= 1, 'Invalid true/false value.');
    return byte === 1;
  }
  option(read) { return this.flag() ? read() : null; }
  vector(read) {
    const length = this.num();
    requireValue(length <= this.bytes.length - this.at, 'Invalid collection length.');
    const items = [];
    for (let i = 0; i < length; i++) items.push(read());
    return items;
  }
  buffer() { return this.take(this.num()); }
  string() { return utf8.decode(this.buffer()); }
  named(type) { this.rev(type); return this.string(); }
  uuid() {
    this.rev('UUID wrapper');
    const s = hex(this.take(16));
    return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');
  }
  hash() { this.rev('blob ID'); return hex(this.take(32)); }
  choice(name, values) {
    this.rev(name);
    const at = this.num();
    requireValue(at < values.length, 'Unknown ' + name + ' value ' + at + '.');
    return values[at];
  }
  origin() {
    if (this.choice('authorship', ['user', 'generated']) === 'user') return 'user';
    this.rev('generation');
    return {producer:this.named('producer'), model:this.option(() => this.string()),
      confidence:this.option(() => this.float(4))};
  }
  point() { this.rev('point'); return [this.float(8), this.float(8)]; }
  done() { requireValue(this.at === this.bytes.length, 'Unexpected extra bytes in a legacy record.'); }
}

function textValue(r) {
  return {text:r.string(), origin:r.origin(), language:r.option(() => r.named('language'))};
}
function asset(r) {
  const role = r.named('asset role');
  r.rev('asset');
  const origin = r.origin(), blob = r.hash(), type = r.string();
  r.rev('asset metadata');
  const width = r.option(() => r.num()), height = r.option(() => r.num());
  const attributes = Object.fromEntries(r.vector(() => [r.string(), r.string()]));
  return [role, {origin, blob, type, width, height, attributes}];
}
const componentReaders = {
  'project': r => ({source:r.option(() => r.named('language')), targets:r.vector(() => r.named('language'))}),
  'page': r => ({label:r.string(), width:r.float(8), height:r.float(8)}),
  'assets': r => Object.fromEntries(r.vector(() => asset(r))),
  'group': r => ({origin:r.origin(), name:r.string()}),
  'text.group': () => true,
  'geometry': r => ({origin:r.origin(), points:r.vector(() => r.point())}),
  'visibility': r => ({origin:r.origin(), visible:r.flag(), opacity:r.float(4)}),
  'entity.origin': r => r.origin(),
  'text.content': r => ({origin:r.origin()}),
  'text.source': textValue,
  'text.translation': textValue,
  'text.role': r => ({origin:r.origin(), role:r.string()}),
  'analysis.region': r => ({origin:r.origin(), kind:r.named('region kind'), label:r.option(() => r.string())}),
  'analysis.detection': r => ({origin:r.origin(), labels:r.vector(() => {
    r.rev('detection label'); return {kind:r.named('region kind'), confidence:r.float(4)};
  })}),
  'analysis.ocr': r => ({origin:r.origin(), direction:r.choice('OCR direction',['auto','horizontal','vertical']),
    confidence:r.option(() => r.float(4)), lines:r.vector(() => Array.from({length:4}, () => r.point()))}),
  'layer.raster': r => ({origin:r.origin(), name:r.string(), kind:r.choice('raster kind',['cleanup','paint'])}),
  'layer.text': (r,rev) => ({origin:r.origin(), kind:r.choice('text layout',['point','paragraph']),
    angle:rev >= 2 ? r.option(() => r.float(4)) : null}),
  'text.typography': r => ({origin:r.origin(), family:r.option(() => r.string()),
    weight:r.option(() => r.num()), fontStyle:r.option(() => r.choice('font style',['normal','italic','oblique'])),
    size:r.option(() => r.float(4)), auto:r.flag(), color:r.option(() => [...r.take(4)]),
    stroke:r.option(() => [...r.take(4)]), strokeWidth:r.option(() => r.float(4)),
    align:r.option(() => r.choice('alignment',['start','center','end','justify'])),
    direction:r.option(() => r.choice('writing mode',['horizontal','vertical'])),
    extensions:Object.fromEntries(r.vector(() => [r.string(),r.string()]))})
};
function components(r) {
  const result = Object.create(null), references = new Set(), records = new Set();
  const unknown = [];
  for (const entry of r.vector(() => {
    r.rev('component entry'); const key = r.named('component key');
    r.rev('component record');
    const schema = r.num(), payload = r.buffer();
    const ids = r.vector(() => r.uuid()), blobs = r.vector(() => r.hash());
    return {key, schema, payload, ids, blobs};
  })) {
    const {key, schema, payload, ids, blobs} = entry;
    for (const hash of blobs) references.add(hash);
    for (const id of ids) records.add(id);
    const name = key.startsWith('dev.koharu.') ? key.slice(11) : key;
    requireValue(!Object.hasOwn(result, name), 'Duplicate component ' + key + '.');
    const read = Object.hasOwn(componentReaders, name) && key.startsWith('dev.koharu.') && componentReaders[name];
    if (!read) { unknown.push(entry); continue; }
    const max = name === 'layer.text' ? 2 : 1;
    if (!schema || schema > max) throw new Unsupported('Unsupported ' + key + ' schema ' + schema + '.');
    const field = new Reader(payload);
    try {
      const revision = name === 'text.source' || name === 'text.translation' ? 1 : field.rev(name, max);
      requireValue(revision === schema, 'Component revision mismatch.');
      result[name] = read(field, revision);
      field.done();
      if (name === 'assets') {
        const actual = new Set(Object.values(result[name]).map(a => a.blob));
        requireValue(actual.size === blobs.length && blobs.every(h => actual.has(h)), 'Asset references disagree with their record.');
      }
    } catch (error) {
      error.message = key + ': ' + error.message;
      throw error;
    }
  }
  return {values:result, references, records, unknown};
}
function scene(bytes, listedBlobs) {
  const r = new Reader(bytes);
  r.rev('scene'); r.num(); // page order epoch
  const ids = new Set(), rootComponents = components(r), containers = [rootComponents];
  function register(id) {
    requireValue(!ids.has(id), 'Duplicate entity ID ' + id + '.');
    ids.add(id);
  }
  const pages = r.vector(() => {
    r.rev('stored page');
    const id = r.uuid(); r.num(); // page epoch
    const byId = new Map();
    const entities = r.vector(() => {
      r.rev('stored entity');
      const entityId = r.uuid(), parent = r.option(() => r.uuid()), entry = components(r);
      register(entityId);
      containers.push(entry);
      requireValue(Object.hasOwn(entry.values,'entity.origin'), 'Legacy entity is missing its origin record.');
      const entity = {id:entityId, parent, c:entry.values, unknown:entry.unknown, children:[]};
      byId.set(entityId, entity);
      return entity;
    });
    const root = byId.get(id);
    requireValue(entities[0] === root, 'The stored page root is out of order.');
    requireValue(root && root.parent === null && root.c.page, 'Page information is missing.');
    for (const e of entities) {
      if (e === root) continue;
      requireValue(byId.has(e.parent), 'A layer has a missing parent.');
      byId.get(e.parent).children.push(e);
    }
    const visited = new Set(), stack = [[root,0]];
    while (stack.length) {
      const [e,depth] = stack.pop();
      requireValue(!visited.has(e.id) && depth <= 256, 'The legacy layer tree is invalid.');
      visited.add(e.id);
      for (const child of e.children) stack.push([child,depth+1]);
    }
    requireValue(visited.size === entities.length, 'A layer is detached from its page.');
    return {id, root, byId, entities};
  });
  const relations = r.vector(() => {
    r.rev('stored relation');
    const id = r.uuid(); r.rev('relation');
    const origin = r.origin(), kind = r.named('relation kind'), from = r.uuid(), to = r.uuid();
    const entry = components(r); containers.push(entry);
    requireValue(ids.has(from) && ids.has(to), 'A relationship points to a missing layer.');
    return {id, origin, kind, from, to, entry};
  });
  r.done();
  const named = new Set();
  for (const c of containers) {
    for (const hash of c.references) named.add(hash);
    for (const id of c.records) requireValue(ids.has(id), 'A component points to a missing entity.');
  }
  requireValue(named.size === listedBlobs.size && [...named].every(h => listedBlobs.has(h)),
    'The image list disagrees with the references in the scene.');
  return {pages, relations, rootComponents};
}
function parseSlot(data) {
  requireValue(data.length >= 52 && utf8.decode(data.subarray(0,8)) === 'KHRSTATE', 'Missing KHRSTATE header.');
  const header = new DataView(data.buffer,data.byteOffset,data.byteLength);
  const format = header.getUint32(8,true);
  if (format !== 1) throw new Unsupported('Unsupported legacy storage version ' + format + '.');
  requireValue(header.getBigUint64(12,true) === BigInt(data.length - 52), 'State file length is wrong.');
  const body = data.subarray(52);
  requireValue(digest(body) === hex(data.subarray(20,52)), 'State checksum mismatch.');
  const r = new Reader(body); r.rev('stored state');
  const id = r.uuid(); r.rev('revision');
  const revision = r.num(), hashes = r.vector(() => r.hash());
  requireValue(hashes.every((h,i) => !i || hashes[i-1] < h), 'Invalid legacy image list.');
  const payload = r.buffer(); r.done();
  return {id, revision, hashes, payload};
}
async function verifyFile(file, expected) {
  const h = blake3.create();
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      h.update(value);
    }
    requireValue(hex(h.digest()) === expected, 'Image checksum mismatch for ' + expected + '.');
  } finally { reader.releaseLock(); }
}
export async function readProject(files, progress) {
  const entries = Array.from(files);
  const paths = new Map(entries.map(file => {
    const path = file.webkitRelativePath || file.name;
    return [path.slice(path.indexOf('/')+1), file];
  }));
  const folder = entries[0]?.webkitRelativePath?.split('/')[0] || 'Project';
  return readProjectSource({folder, get: path => paths.get(path)}, progress);
}
export async function readProjectSource({folder, get}, progress) {
  const notes = [], candidates = [];
  for (const name of ['state-a.khr','state-b.khr']) {
    try {
      const file = await get(name);
      if (!file) continue;
      requireValue(file.size <= MAX_STATE + 52, 'State exceeds the 0.83 format limit.');
      progress('Reading ' + name + '…');
      candidates.push({...parseSlot(new Uint8Array(await file.arrayBuffer())),name});
    } catch (error) {
      if (error instanceof Unsupported) throw error;
      notes.push(name + ' skipped. ' + error.message);
    }
  }
  if (!candidates.length) throw Error(notes.join('\n') || 'Neither save file is present. Look for another copy of this chapter that contains state-a.khr or state-b.khr.');
  requireValue(new Set(candidates.map(c => c.id)).size === 1, 'The two saves belong to different projects. Select the original project directory.');
  candidates.sort((a,b) => b.revision-a.revision);
  const verified = new Set();
  const getBlob = hash => get('blobs/' + hash.slice(0,2) + '/' + hash);
  for (const c of candidates) {
    try {
      const document = scene(c.payload, new Set(c.hashes));
      for (const [i,hash] of c.hashes.entries()) {
        if (verified.has(hash)) continue;
        const f = await getBlob(hash);
        requireValue(f,'Missing image file blobs/' + hash.slice(0,2) + '/' + hash + '.');
        progress('Checking image files · ' + (i+1) + ' of ' + c.hashes.length);
        await verifyFile(f,hash); verified.add(hash);
      }
      return {...document,id:c.id,revision:c.revision,slot:c.name,folder,notes,getBlob,hashes:c.hashes};
    } catch (error) {
      if (error instanceof Unsupported) throw error;
      notes.push(c.name + ' (revision ' + c.revision + ') skipped. ' + error.message);
    }
  }
  throw Error('No complete legacy save could be read.\n' + notes.join('\n'));
}
