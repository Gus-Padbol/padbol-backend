// Auditoría focal: identificadores libres del handler extraído.
import fs from 'node:fs';
const archivo = 'lib/crearReservaHandler.js';
const src = fs.readFileSync(archivo, 'utf8');
const jsBuiltins = new Set(['Array','Object','String','Number','Boolean','JSON','Math','Date','Error','Promise','Set','Map','parseInt','parseFloat','isNaN','console','undefined','null','true','false','this','let','const','var','function','return','if','else','try','catch','finally','throw','new','await','async','typeof','in','of','for','while','switch','case','break','continue','delete','instanceof','void','yield','class','extends','super','import','export','default','from','as']);
const ids = new Set([...src.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]));
const imported = new Set();
for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
  m[1].split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => imported.add(x));
}
const declared = new Set([...src.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
const params = new Set([...src.matchAll(/createReservaHandler\(\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean)));
const locales = new Set(['req','res','e','err','data','error','rows','row','value','i','k','v']);
const libres = [...ids].filter((id) => !imported.has(id) && !declared.has(id) && !params.has(id) && !locales.has(id) && !jsBuiltins.has(id));
const exportados = (f) => new Set([...fs.readFileSync(f, 'utf8').matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}/g)].flatMap((m) => m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim()).filter(Boolean)));
const P = exportados('routes/partidos.js'), R = exportados('routes/reputacion.js'), DD = exportados('lib/dto/reservaDto.js');
const sinImportar = libres.filter((id) => P.has(id) || R.has(id) || DD.has(id));
console.log(JSON.stringify({importados: imported.size, declarados: declared.size, deps: [...params].length,
  libresConOrigen: sinImportar.sort(), libresSinOrigen: libres.filter((id) => !sinImportar.includes(id)).sort()}, null, 1));
