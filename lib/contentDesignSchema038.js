import {inflateSync,deflateSync} from 'node:zlib';
export const DESIGN_FORMATS=Object.freeze({historia:{w:1080,h:1920},feed:{w:1080,h:1350},carrusel:{w:1080,h:1350},torneo_app:{w:1620,h:1080}});
const bad=()=>{throw Object.assign(new Error('Revisá el formato y las capas del diseño.'),{status:400,code:'CONTENT_DESIGN_INVALID'});};
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))bad();};
const text=(v,max,min=0)=>{if(typeof v!=='string'||v.length>max||v.trim().length<min||/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))bad();return v.trim();};
const number=(v,min,max)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)bad();return v;};
export const designUuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function chunk(type,data){const tag=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);tag.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([tag,data])),data.length+8);return out;}
export function normalizeDesignPng(src){
 if(typeof src!=='string'||!src.startsWith('data:image/png;base64,')||src.length>2800000)bad();const encoded=src.slice(22);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))bad();const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded||bytes.length>2000000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))bad();
 let offset=8,header,width,height,bpp,ended=false;const idat=[];
 while(offset<bytes.length){if(offset+12>bytes.length)bad();const len=bytes.readUInt32BE(offset);if(len>2000000||offset+len+12>bytes.length)bad();const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+len);if(crc32(bytes.subarray(offset+4,offset+8+len))!==bytes.readUInt32BE(offset+8+len))bad();
  if(!header&&type!=='IHDR')bad();if(type==='IHDR'){if(header||len!==13)bad();header=Buffer.from(data);width=data.readUInt32BE(0);height=data.readUInt32BE(4);if(!width||!height||width>1200||height>1200||data[8]!==8||![2,6].includes(data[9])||data[10]||data[11]||data[12])bad();bpp=data[9]===6?4:3;}
  else if(type==='IDAT')idat.push(data);
  else if(type==='IEND'){if(len||offset+12!==bytes.length)bad();ended=true;break;}
  else if(['acTL','fcTL','fdAT'].includes(type)||!/^[a-z]/.test(type))bad();
  offset+=len+12;
 }
 if(!ended||!idat.length)bad();let raw;const size=(width*bpp+1)*height;try{raw=inflateSync(Buffer.concat(idat),{maxOutputLength:size});}catch{bad();}if(raw.length!==size)bad();for(let y=0;y<height;y++)if(raw[y*(width*bpp+1)]>4)bad();
 const normalized=Buffer.concat([bytes.subarray(0,8),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);return{src:'data:image/png;base64,'+normalized.toString('base64'),width,height};
}
export function normalizeDesignDocument(input){
 object(input,['schemaVersion','title','baseEntryId','baseSourceVersion','format','layers']);if(input.schemaVersion!==1||!designUuid(input.baseEntryId)||!Number.isSafeInteger(input.baseSourceVersion)||input.baseSourceVersion<1||!Object.hasOwn(DESIGN_FORMATS,input.format)||!Array.isArray(input.layers)||input.layers.length>12)bad();const ids=new Set();
 const layers=input.layers.map(layer=>{object(layer,['id','type','text','x','y','fontFamily','fontWeight','fontSize','color','align','pngDataUrl','size']);if(typeof layer.id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(layer.id)||ids.has(layer.id))bad();ids.add(layer.id);const common={id:layer.id,type:layer.type,x:number(layer.x,0,1),y:number(layer.y,0,1)};
  if(layer.type==='text'){if(Object.keys(layer).some(k=>!['id','type','text','x','y','fontFamily','fontWeight','fontSize','color','align'].includes(k))||layer.fontFamily!=='Outfit'||![500,600,700,800,900].includes(layer.fontWeight)||typeof layer.color!=='string'||!/^#[0-9a-f]{6}$/i.test(layer.color)||!['left','center','right'].includes(layer.align))bad();return{...common,text:text(layer.text,500),fontFamily:'Outfit',fontWeight:layer.fontWeight,fontSize:number(layer.fontSize,28,180),color:layer.color.toLowerCase(),align:layer.align};}
  if(layer.type==='logo'){if(Object.keys(layer).some(k=>!['id','type','x','y','size','pngDataUrl'].includes(k)))bad();const png=normalizeDesignPng(layer.pngDataUrl);return{...common,size:number(layer.size,0.04,0.8),pngDataUrl:png.src};}bad();
 });
 const output={schemaVersion:1,title:text(input.title,160,2),baseEntryId:input.baseEntryId.toLowerCase(),baseSourceVersion:input.baseSourceVersion,format:input.format,layers};if(Buffer.byteLength(JSON.stringify(output))>3500000)bad();return output;
}
