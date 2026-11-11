# NO ROLLBACK automático

Este candidato agrega columnas y auditoría de verificación de edad. No se aplicó.

- No ejecutar `DROP` de columnas ni borrar referencias/auditoría: son evidencia histórica.
- Retirar la feature = deshabilitar endpoint/UI y conservar datos.
- Cualquier limpieza destructiva requiere backup verificado, ventana y aprobación específica.
- No se llama “rollback” a este documento: es una política de recuperación no destructiva.
