# Recepción IMAP comercial limitada

`CRM_INBOUND_IMAP_COMMERCIAL_REPLIES_ONLY=true` habilita un filtro adicional, únicamente para el lector institucional. Por defecto permanece apagado; el lector de soporte conserva su configuración.

El servidor consulta `crm_commercial_form_is_allowed` y exige un evento entrante original persistido. Usa el correo normalizado del contacto y `identity_used` original solo cuando ambos corresponden a la misma identidad según `normalizeEmail`. No concede alcance a partir de campos arbitrarios del formulario.

IMAP busca por FROM de esas direcciones antes de descargar mensajes, evitando que facturas, avisos y boletines consuman el lote. Tras analizar el MIME, vuelve a comprobar el remitente canónico. Un lector ausente, fallido, vacío o demasiado grande no abre una búsqueda general. Un remitente desconocido no se encola ni se importa. Un remitente elegible conserva el circuito existente de correlación RFC y fallback institucional; conocer el remitente no basta para vincular una respuesta a un lead.

Gmail conserva las reglas ya existentes de identidad (puntos y sufijo +), tanto al comparar la respuesta con el contacto como al reconciliar la cola. `originalFrom` conserva la dirección original en la evidencia privada de la cola. No se modifica el cuerpo original, el RFC Message-ID ni la identidad almacenada del contacto.

Límite intencional: la búsqueda IMAP cubre el correo canónico y los alias originales ya registrados. No garantiza encontrar cualquier variante nueva de puntos/+ nunca utilizada en el formulario. No se amplía la búsqueda a todo Gmail para cubrir variantes hipotéticas.

Publicar y comprobar antes de activar IMAP. Este cambio no activa servicios, no modifica credenciales, no envía correo y no importa un buzón durante las pruebas.
