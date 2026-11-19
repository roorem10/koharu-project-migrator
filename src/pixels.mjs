import { unzlibSync, zlibSync } from 'lib/fflate';
import { digest } from 'app/legacy';

const signature = [137,80,78,71,13,10,26,10];
const big = (v, i) => new DataView(v.buffer,v.byteOffset+i,4).getUint32(0);
function paeth(a,b,c) {
  const p = a+b-c, x = Math.abs(p-a), y = Math.abs(p-b), z = Math.abs(p-c);
  return x <= y && x <= z ? a : y <= z ? b : c;
}

// Legacy Koharu writes non-interlaced 8-bit PNGs for paint, cleanup, and masks.
// Reading PNG samples directly avoids canvas premultiplication and colour conversion.
export function pngPixels(bytes) {
  if (!signature.every((x,i) => bytes[i] === x)) return null;
  let at = 8, width, height, channels, type, palette, transparent, finished = false, encoded = 0;
  const blocks = [];
  while (at+12 <= bytes.length) {
    const size = big(bytes,at), end = at+8+size;
    if (end+4 > bytes.length) throw Error('Truncated PNG chunk.');
    const name = String.fromCharCode(...bytes.subarray(at+4,at+8));
    const data = bytes.subarray(at+8,end);
    if (name === 'IHDR') {
      if (size !== 13 || at !== 8) throw Error('Invalid PNG header.');
      width = big(data,0); height = big(data,4); type = data[9];
      channels = {0:1,2:3,3:1,4:2,6:4}[type];
      if (!channels || data[8] !== 8 || data[10] || data[11] || data[12]) return null;
    } else if (name === 'IDAT') { blocks.push(data); encoded += data.length; }
    else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') transparent = data;
    else if (name === 'IEND') { finished = true; break; }
    at = end+4;
  }
  if (!finished || !width || !height || !encoded) throw Error('Incomplete PNG image.');
  const stride = width*channels, length = (stride+1)*height;
  if (length > 512*1024*1024) throw Error('This PNG exceeds the browser decoder’s 512 MiB working limit.');
  const zipped = new Uint8Array(encoded);
  let pos = 0;
  for (const block of blocks) { zipped.set(block,pos); pos += block.length; }
  // An extra output byte lets us reject a stream bigger than its declared dimensions.
  const raw = unzlibSync(zipped, {out:new Uint8Array(length+1)});
  if (raw.length !== length) throw Error('PNG pixels disagree with the header dimensions.');
  for (let y=0; y<height; y++) {
    const start = y*(stride+1)+1, filter = raw[start-1];
    if (filter > 4) throw Error('Unknown PNG row filter.');
    for (let x=0; filter && x<stride; x++) {
      const index = start+x, a = x < channels ? 0 : raw[index-channels];
      const b = y ? raw[index-stride-1] : 0;
      const c = y && x >= channels ? raw[index-stride-1-channels] : 0;
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a+b)>>>1 : paeth(a,b,c);
      raw[index] += add;
    }
  }
  if (type === 3 && (!palette || palette.length % 3)) throw Error('Invalid PNG palette.');
  const sample16 = i => transparent && (transparent[i]*256+transparent[i+1]);
  const clear = [sample16(0),sample16(2),sample16(4)];
  return {
    width,height,
    rgba(x,y,out,at) {
      const i = y*(stride+1)+1+x*channels;
      let r=raw[i],g=r,b=r,a=255;
      if (type === 6 || type === 2) {
        g=raw[i+1]; b=raw[i+2];
        a=type===6 ? raw[i+3] : (r===clear[0] && g===clear[1] && b===clear[2] ? 0 : 255);
      } else if (type === 3) {
        const p=r*3;
        if (p+2>=palette.length) throw Error('Invalid PNG palette entry.');
        a=transparent?.[r] ?? 255; r=palette[p]; g=palette[p+1]; b=palette[p+2];
      } else a=type === 4 ? raw[i+1] : (r===clear[0] ? 0 : 255);
      out[at]=r; out[at+1]=g; out[at+2]=b; out[at+3]=a;
      return a;
    },
    gray(x,y) {
      const i=y*(stride+1)+1+x*channels;
      if (type===0 || type===4) return raw[i];
      if (type===3) return palette[raw[i]*3];
      return raw[i]; // Koharu's mask is greyscale.
    }
  };
}
export const tick = () => new Promise(resolve => setTimeout(resolve,0));
function scanline(points,y) {
  const crossings=[];
  for (let i=0,j=points.length-1;i<points.length;j=i++) {
    const [x1,y1]=points[j],[x2,y2]=points[i];
    if ((y1>y)!==(y2>y)) crossings.push(x1+(y-y1)*(x2-x1)/(y2-y1));
  }
  crossings.sort((a,b)=>a-b);
  const ranges=[];
  for(let i=0;i+1<crossings.length;i+=2)
    ranges.push([Math.ceil(crossings[i]-.5),Math.ceil(crossings[i+1]-.5)]);
  return ranges;
}
export function bounds(points) {
  if (!points?.length) return null;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const [x,y] of points) {
    minX=Math.min(x,minX); maxX=Math.max(x,maxX); minY=Math.min(y,minY); maxY=Math.max(y,maxY);
  }
  return {x:minX,y:minY,width:maxX-minX,height:maxY-minY};
}
export async function writeTiles(db, layer, image, polygon = null) {
  const region=polygon ? bounds(polygon) : {x:0,y:0,width:image.width,height:image.height};
  if (!region || region.width<=0 || region.height<=0) return 0;
  const left=Math.max(0,Math.floor(region.x)), top=Math.max(0,Math.floor(region.y));
  const right=Math.min(image.width,Math.ceil(region.x+region.width));
  const bottom=Math.min(image.height,Math.ceil(region.y+region.height));
  const bpp=polygon ? 1 : 4;
  const tile=new Uint8Array(64*64*bpp), repeated=new Map();
  let count=0, visited=0;
  for (let ty=Math.floor(top/64);ty*64<bottom;ty++) {
    const rowStart=Math.max(top,ty*64), rowEnd=Math.min(bottom,(ty+1)*64);
    const spans=polygon ? Array.from({length:rowEnd-rowStart},(_,i)=>scanline(polygon,rowStart+i+.5)) : null;
    for (let tx=Math.floor(left/64);tx*64<right;tx++) {
      tile.fill(0);
      let occupied=false;
      const x0=Math.max(left,tx*64), x1=Math.min(right,(tx+1)*64);
      for (let y=rowStart;y<rowEnd;y++) {
        const offset=(y-ty*64)*64-tx*64;
        if (spans) {
          for(const [a,b] of spans[y-rowStart]) for(let x=Math.max(x0,a);x<Math.min(x1,b);x++){
            const value=image.gray(x,y);
            if(value){tile[offset+x]=value;occupied=true;}
          }
        } else {
          for(let x=x0;x<x1;x++) if(image.rgba(x,y,tile,(offset+x)*4)) occupied=true;
        }
      }
      if (occupied) {
        const key=digest(tile);
        let hash=repeated.get(key);
        if (!hash) {
          const data=zlibSync(tile,{level:3});
          hash=digest(data);
          db.run('INSERT OR IGNORE INTO blobs VALUES (?,?)',[hash,data]);
          repeated.set(key,hash);
        }
        db.run('INSERT INTO tiles VALUES (?,?,?,?)',[layer,tx,ty,hash]);
        count++;
      }
      if (++visited%96===0) await tick();
    }
  }
  return count;
}
