# Supervisión externa de Padbol

GitHub Actions, ejecutor estándar Linux en repositorio público: no requiere Mac encendida, credenciales ni contratación de otro proveedor. Comprueba padbol.com, Padbol Match y la salud del backend cada treinta minutos (el planificador puede demorarse; no es una garantía de tiempo real).

Una comprobación exige respuesta correcta, no solo HTTP200, y reintenta hasta tres veces. Un fallo persistente deja una ejecución roja y una anotación de error con servicio y motivo. Las notificaciones de GitHub dependen de las preferencias del titular: comprobar su recepción antes de prometer un aviso por correo. También se puede consultar la sección Actions del repositorio.

Ejecutar manualmente «Supervisión externa de Padbol» permite verificar ahora. El parámetro test_alert crea un simulacro claramente rotulado que falla a propósito, sin afectar los servicios. La ejecución siguiente comprueba la recuperación. No se repara ni reinicia producción automáticamente.

Alcance: disponibilidad pública. No certifica reservas, cobros, recepción de correo o WhatsApp ni reemplaza sus pruebas funcionales. Solo se registran estados públicos, sin datos de clientes, secretos ni facturas.
