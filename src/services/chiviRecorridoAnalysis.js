const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

function parseAnalysisJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  return {
    datos_reconocidos: parsed?.datos_reconocidos && typeof parsed.datos_reconocidos === 'object' ? parsed.datos_reconocidos : {},
    dudas: Array.isArray(parsed?.dudas) ? parsed.dudas.map(String).slice(0, 12) : [],
    resumen: String(parsed?.resumen || '').trim().slice(0, 800),
    confianza: ['alta', 'media', 'baja'].includes(parsed?.confianza) ? parsed.confianza : 'baja',
  };
}

export async function analyzeRecorridoWithChivi({ supabaseAdmin, row }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Chivi no tiene configurado el acceso de análisis');
  const blocks = [];
  let totalBytes = 0;
  for (const path of row.capturas_paths || []) {
    const { data, error } = await supabaseAdmin.storage.from('recorridos-externos').download(path);
    if (error || !data) throw error || new Error('No se pudo leer una evidencia');
    const bytes = Buffer.from(await data.arrayBuffer());
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Las evidencias superan el tamaño permitido para análisis automático');
    const mediaType = MIME_BY_EXT[String(path).split('.').pop()?.toLowerCase()];
    if (!mediaType) continue;
    blocks.push(mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
  }
  if (!blocks.length) throw new Error('No hay evidencias compatibles para analizar');

  blocks.push({ type: 'text', text: `Actuás como Chivi, asistente de Padbol Match. Analizá evidencia de recorrido deportivo externo.
No inventes, no infieras identidad ni conviertas categorías entre plataformas. Extraé únicamente datos legibles.
Origen declarado: ${row.origen}. Categorías solicitadas: ${(row.categorias || []).join(', ')}.
Comentario: ${row.comentario || 'sin comentario'}.
Respondé exclusivamente JSON válido con esta forma:
{"datos_reconocidos":{"categoria_nivel":"valor","ranking":"valor","puntos":"valor","partidos":"valor","torneos_posiciones":"valor","estadisticas":"valor","logros":"valor"},"dudas":["dato que requiere revisión"],"resumen":"explicación breve","confianza":"alta|media|baja"}
Omití cualquier clave no demostrada. La decisión final siempre será humana.` });

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: blocks }] }),
  });
  if (!response.ok) throw new Error(`Chivi no pudo analizar la evidencia (${response.status})`);
  const payload = await response.json();
  const answer = payload?.content?.find((block) => block.type === 'text')?.text;
  if (!answer) throw new Error('Chivi devolvió un análisis vacío');
  return parseAnalysisJson(answer);
}

export { parseAnalysisJson };
