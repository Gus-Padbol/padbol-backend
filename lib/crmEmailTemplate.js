// Plantilla de correo comercial. Tablas e estilos inline para compatibilidad con
// Gmail, Outlook y clientes moviles. El contenido del asesor no se modifica.
const ESC = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// LOGO FULL A del paquete oficial PADBOL LOGOS.zip (fondo oscuro del encabezado).
const LOGO = 'https://www.padbolmatch.com/brand/oficial-2026/padbol-internacional-dark.png';
const SITE = 'https://padbol.com';

export function renderCrmEmailHtml({ body, siteName = 'Padbol Internacional' } = {}) {
  const texto = ESC(String(body || '').trim()).replace(/\r\n|\r|\n/g, '<br>');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ESC(siteName)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="background:#0b1324;padding:20px 24px;text-align:center;">
      <img src="${LOGO}" alt="${ESC(siteName)}" width="260" style="display:block;margin:0 auto;max-width:80%;height:auto;border:0;">
    </td></tr>
    <tr><td style="height:4px;background:#e50511;line-height:4px;font-size:0;">&nbsp;</td></tr>
    <tr><td style="padding:28px 24px;color:#1f2937;font-size:16px;line-height:1.6;">
      ${texto}
    </td></tr>
    <tr><td style="padding:0 24px 24px;color:#1f2937;font-size:16px;line-height:1.6;">
      <p style="margin:0 0 4px;font-weight:600;">Equipo Comercial — Padbol Internacional</p>
      <p style="margin:0;font-size:14px;color:#6b7280;">
        <a href="${SITE}" style="color:#e50511;text-decoration:none;">padbol.com</a> · Plataforma tecnológica: Padbol Match
      </p>
    </td></tr>
    <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.5;">
      Recibís este correo porque hiciste una consulta comercial sobre Padbol.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}
