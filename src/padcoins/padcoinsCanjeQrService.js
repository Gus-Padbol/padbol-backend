import {
  PADCOINS_CANJE_QR_PAYLOAD_TYPE,
  PADCOINS_CANJE_QR_PAYLOAD_VERSION,
} from './padcoinsCanjesConfig.js';

export function buildCanjeQrPayload({
  canje,
  premioNombre = null,
} = {}) {
  if (!canje?.id || !canje?.codigo) {
    return null;
  }

  return {
    version: PADCOINS_CANJE_QR_PAYLOAD_VERSION,
    type: PADCOINS_CANJE_QR_PAYLOAD_TYPE,
    canje_id: String(canje.id),
    codigo: String(canje.codigo),
    sede_id: canje.sede_id != null ? Number(canje.sede_id) : null,
    premio_id: canje.premio_id ?? null,
    premio_nombre: premioNombre ?? canje.premio_nombre ?? null,
    user_id: canje.user_id ?? null,
  };
}

export function encodeCanjeQrData(payload) {
  if (!payload) return null;
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function buildCanjeVerifyAdminPath(codigo) {
  const normalized = String(codigo ?? '').trim();
  if (!normalized) return null;
  return `/api/admin/padcoins-canjes/validar?codigo=${encodeURIComponent(normalized)}`;
}

export function buildCanjeQrResponse(canje, { premioNombre = null } = {}) {
  const qr_payload = buildCanjeQrPayload({ canje, premioNombre });
  if (!qr_payload) {
    return {
      qr_payload: null,
      qr_data: null,
      verify_path: null,
    };
  }

  return {
    qr_payload,
    qr_data: encodeCanjeQrData(qr_payload),
    verify_path: buildCanjeVerifyAdminPath(canje.codigo),
  };
}
