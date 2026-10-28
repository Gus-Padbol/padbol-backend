export function commercialSourceFields(conversation) {
  const sourceOrigin=typeof conversation?.origin==='string'?conversation.origin:null;
  const sourceLabel=conversation?.source_channel==='whatsapp'?'WhatsApp':conversation?.source_channel==='email'
    ?sourceOrigin?.startsWith('web_form:')?'Formulario web':'Correo electrónico':'Consulta comercial';
  return {sourceOrigin,sourceLabel};
}

// Metadata only. The caller must already hold an authorized case projection.
export async function commercialSourceMap(db,ids) {
  const allowed=[...new Set(ids.filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')).map(id=>id.toLowerCase()))];
  if(!allowed.length||typeof db?.from!=='function')return new Map();
  try{
    const sources=new Map();
    for(let offset=0;offset<allowed.length;offset+=100){
      const batch=allowed.slice(offset,offset+100);
      const result=await db.from('crm_conversations').select('id,source_channel,origin').in('id',batch);
      if(result.error||!Array.isArray(result.data))return new Map();
      for(const row of result.data)if(batch.includes(row.id))sources.set(row.id,commercialSourceFields(row));
    }
    return sources;
  }catch{return new Map();}
}
