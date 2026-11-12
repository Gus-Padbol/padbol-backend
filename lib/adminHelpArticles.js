// Server-only reviewed administrative corpus. Do not bundle or publish as static assets.
export const ADMIN_HELP_ARTICLES = [
  {
    "id": "admin-panel-by-role",
    "module": "administracion",
    "slug": "panel-por-rol",
    "allowedRoles": [
      "admin_club",
      "admin_nacional",
      "admin_cadena",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/utils/adminVisibleTabs.js:9-72",
      "WEB798:padbol-match-frontend/src/App.js:475"
    ],
    "translations": {
      "es": {
        "title": "Reconocer el panel de tu rol",
        "requirements": [
          "Sesión válida con rol administrativo asignado por el servidor."
        ],
        "steps": [
          "Entra a /admin.",
          "Revisa las pestañas disponibles: Resumen, Torneos, Reservas, Jugadores y las secciones propias de tu rol.",
          "Abre solo una pestaña visible. Si el servidor deniega una operación, vuelve al panel y no cambies la URL para forzarla."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance; consulta con soporte."
      },
      "en": {
        "title": "Identify your role panel",
        "requirements": [
          "A valid session with an administrative role assigned by the server."
        ],
        "steps": [
          "Open /admin.",
          "Review the available tabs: Overview, Tournaments, Bookings, Players and the sections for your role.",
          "Open only a visible tab. If the server denies an operation, return to the panel and do not change the URL to force it."
        ],
        "limit": "These instructions were reviewed against the panel. If an option is not shown or the server denies it, do not change the URL or scope; ask support."
      },
      "pt": {
        "title": "Reconhecer o painel do seu papel",
        "requirements": [
          "Sessão válida com papel administrativo atribuído pelo servidor."
        ],
        "steps": [
          "Abra /admin.",
          "Revise as abas disponíveis: Resumo, Torneios, Reservas, Jogadores e as seções do seu papel.",
          "Abra apenas uma aba visível. Se o servidor negar uma operação, volte ao painel e não altere a URL para forçá-la."
        ],
        "limit": "Estas instruções foram revisadas no painel. Se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo; consulte o suporte. Tradução PT não verificada na interface."
      }
    }
  },
  {
    "id": "admin-sede-canchas-horarios",
    "module": "sedes",
    "slug": "sede-canchas-horarios",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/AdminSedeConfiguracionGuiada.jsx:1-220",
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:19024",
      "backend42:routes/sedesProfile.js:273,411",
      "backend42:routes/sedesDuraciones.js:80,211,264,334",
      "backend42:lib/authAccess.js:211"
    ],
    "translations": {
      "es": {
        "title": "Configurar sede, canchas y horarios",
        "requirements": [
          "Rol admin_club o super_admin.",
          "Sede asignada en el servidor."
        ],
        "steps": [
          "Entra a /admin y abre Mi Sede.",
          "Pulsa Empezar configuración guiada. En Sede completa Nombre de la sede, Ciudad, País y Moneda; pulsa Continuar.",
          "En Cancha, si no hay canchas cargadas, escribe Nombre de la cancha y elige Deporte (Padbol, Pádel, Pickleball o Tenis). Si ya hay canchas, el paso muestra cuántas hay y no crea otra.",
          "En Operación define Apertura, Cierre y Precio base de 60 min (obligatorio). Los precios de 90 y 120 min son opcionales.",
          "En Confirmar revisa el resumen y pulsa Confirmar y guardar. Si el guardado falla, actualiza y revisa la sede antes de reintentar; la operación pudo haberse guardado.",
          "Si falta un dato obligatorio, el asistente no avanza y muestra el faltante. Si el guardado falla, actualiza y revisa la sede antes de reintentar; pudo haberse guardado. Cerrar o Cancelar no confirma el resumen."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance; consulta con soporte. Un error no confirma que la operación no se guardó o envió: actualiza y revisa la lista, el historial o los valores antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Set up venue, courts and hours",
        "requirements": [
          "admin_club or super_admin role.",
          "Venue assigned by the server."
        ],
        "steps": [
          "Open /admin and select Mi Sede.",
          "Select Start guided setup. In Venue, complete Venue name, City, Country and Currency; select Continue.",
          "In Court, if no courts exist, enter Court name and choose Sport (Padbol, Padel, Pickleball or Tennis). If courts already exist, the step shows their count and does not create another.",
          "In Operation set Opening, Closing and the required 60-min base price. 90- and 120-min prices are optional.",
          "In Confirm review the summary and select Confirm and save. If saving fails, refresh and review the venue before retrying; it may have been saved.",
          "If a required field is missing, the assistant does not advance and shows it. If saving fails, refresh and review the venue before retrying; it may have been saved. Close or Cancel does not confirm the summary."
        ],
        "limit": "These instructions were reviewed against the panel. If an option is not shown or the server denies it, do not change the URL or scope; ask support. An error does not confirm the operation was not saved or sent: refresh and review the list, history or values before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Configurar sede, quadras e horários",
        "requirements": [
          "Papel admin_club ou super_admin.",
          "Sede atribuída pelo servidor."
        ],
        "steps": [
          "Abra /admin e selecione Mi Sede.",
          "Selecione Empezar configuración guiada. Em Sede preencha Nome da sede, Cidade, País e Moeda; selecione Continuar.",
          "Em Cancha, se não houver quadras, informe Nome da quadra e escolha Esporte (Padbol, Pádel, Pickleball ou Tênis). Se já houver quadras, a etapa mostra a quantidade e não cria outra.",
          "Em Operação defina Abertura, Fechamento e Preço base de 60 min (obrigatório). Preços de 90 e 120 min são opcionais.",
          "Em Confirmar revise o resumo e selecione Confirmar e guardar. Se falhar, atualize e revise a sede antes de tentar novamente; a operação pode ter sido guardada.",
          "Se faltar um dado obrigatório, o assistente não avança e mostra o campo. Se falhar ao guardar, atualize e revise a sede antes de tentar novamente; pode ter sido guardada. Cerrar ou Cancelar não confirma o resumo."
        ],
        "limit": "Estas instruções foram revisadas no painel. Se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo; consulte o suporte. Tradução PT não verificada na interface. Um erro não confirma que a operação não foi guardada ou enviada: atualize e revise a lista, histórico ou valores antes de tentar novamente para evitar duplicados."
      }
    }
  },
  {
    "id": "admin-canchas-agregar-editar",
    "module": "sedes",
    "slug": "agregar-editar-cancha",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:9543-9635,19376-19670,20540-20860",
      "WEB798:padbol-match-frontend/src/utils/canchaDeporteCustom.js:134-165",
      "backend42:routes/canchas.js:133-183,189-262",
      "backend42:lib/authAccess.js:211"
    ],
    "translations": {
      "es": {
        "title": "Agregar o editar una cancha",
        "requirements": [
          "Rol admin_club o super_admin y una sede dentro de tu alcance."
        ],
        "steps": [
          "Entra a /admin, abre Mi Sede y selecciona Canchas; verás Mis Canchas.",
          "Pulsa + Agregar cancha para crear otra cancha. Completa Nombre, Estado (Activa o Inactiva) y Deporte. Una cancha inactiva no aparece como opción en reservas públicas.",
          "Si eliges un deporte personalizado, completa nombre de la disciplina, cantidad de jugadores (1 a 40) y modalidad (individual, parejas o equipos). La duración sugerida es opcional; si la indicas, usa de 15 a 240 minutos. Puedes añadir observación y descripción opcionales.",
          "Pulsa Guardar. Si falta un dato obligatorio, corrígelo según el mensaje. Al guardar correctamente se cierra el formulario y se actualiza la lista.",
          "Para editar, busca la cancha en la lista y pulsa Editar; revisa los campos y pulsa Guardar. Cancelar cierra el formulario sin confirmar los cambios.",
          "Si aparece un error, actualiza y revisa la lista antes de reintentar: la cancha o sus cambios podrían haberse guardado."
        ],
        "limit": "Administra solo las canchas de tu sede autorizada. Este formulario permite agregar y editar canchas; es distinto de la configuración guiada inicial. Revisa el resultado antes de repetir un guardado."
      },
      "en": {
        "title": "Add or edit a court",
        "requirements": [
          "admin_club or super_admin role and a venue within your scope."
        ],
        "steps": [
          "Open /admin, select Mi Sede and Canchas; the Mis Canchas section lists your courts.",
          "Select + Agregar cancha to add a court. Complete Name, Status (Active or Inactive) and Sport. An inactive court is not offered in public bookings.",
          "For a custom sport, enter the discipline name, player count (1 to 40) and format (individual, pairs or teams). Suggested duration is optional; if entered, use 15 to 240 minutes. Observation and description are optional.",
          "Select Save. Correct any required field identified by the message. A successful save closes the form and updates the list.",
          "To edit a court, find its row and select Edit; review the fields and select Save. Cancel closes the form without confirming changes.",
          "If an error appears, refresh and check the list before retrying: the court or its changes may already have been saved."
        ],
        "limit": "Manage only courts at your authorized venue. This form adds and edits courts separately from initial guided setup. Check the result before repeating a save."
      },
      "pt": {
        "title": "Adicionar ou editar uma quadra",
        "requirements": [
          "Papel admin_club ou super_admin e uma sede dentro do seu escopo."
        ],
        "steps": [
          "Abra /admin, selecione Mi Sede e Canchas; a seção Mis Canchas mostra suas quadras.",
          "Selecione + Agregar cancha para adicionar uma quadra. Preencha Nome, Estado (Ativa ou Inativa) e Esporte. Uma quadra inativa não aparece como opção nas reservas públicas.",
          "Para um esporte personalizado, informe nome da modalidade esportiva, quantidade de jogadores (1 a 40) e formato (individual, duplas ou equipes). A duração sugerida é opcional; se informada, use de 15 a 240 minutos. Observação e descrição são opcionais.",
          "Selecione Guardar. Corrija qualquer campo obrigatório indicado pela mensagem. Ao guardar com sucesso, o formulário fecha e a lista é atualizada.",
          "Para editar uma quadra, encontre sua linha e selecione Editar; revise os campos e selecione Guardar. Cancelar fecha o formulário sem confirmar alterações.",
          "Se aparecer um erro, atualize e confira a lista antes de tentar novamente: a quadra ou suas alterações podem ter sido salvas."
        ],
        "limit": "Administre apenas as quadras da sede autorizada. Este formulário adiciona e edita quadras separadamente da configuração guiada inicial. Confira o resultado antes de repetir o salvamento."
      }
    }
  },
  {
    "id": "admin-reservas",
    "module": "reservas",
    "slug": "reservas",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:12806-13070",
      "WEB798:padbol-match-frontend/src/utils/adminReservaManual.js:101-160",
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:7697-7770",
      "backend42:server.js:1557",
      "backend42:lib/authAccess.js:122",
      "backend42:server.js:1697,1776"
    ],
    "translations": {
      "es": {
        "title": "Crear una reserva manual",
        "requirements": [
          "Rol con acceso a Reservas.",
          "Sede y cancha activas dentro de tu alcance."
        ],
        "steps": [
          "Entra a /admin, abre Reservas y pulsa Crear reserva manual.",
          "Completa Sede si corresponde, Cancha (solo activas), Fecha, Hora inicio y Duración (60, 90 o 120 min; por defecto 90).",
          "Busca y selecciona el Jugador. El Teléfono es opcional. Elige Estado: Confirmada o Reservada.",
          "Pulsa Crear reserva. Si falta algún obligatorio verás Completa sede, cancha, fecha, hora y nombre del jugador. Si el horario se ocupa, verás Sin horarios disponibles o el mensaje de conflicto.",
          "Con datos válidos y horario libre, el panel confirma la creación, cierra el formulario y actualiza la lista.",
          "Cancelar cierra el formulario sin confirmar. Si falla la sesión o el permiso, actualiza y revisa la lista antes de reintentar; la reserva pudo haberse creado."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance; consulta con soporte. Un error no confirma que la operación no se guardó o envió: actualiza y revisa la lista, el historial o los valores antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Create a manual booking",
        "requirements": [
          "Role with Bookings access.",
          "Active venue and court within your scope."
        ],
        "steps": [
          "Open /admin, select Reservas and choose Create manual booking.",
          "Complete Venue if applicable, Court (active only), Date, Start time and Duration (60, 90 or 120 min; default 90).",
          "Search and select the Player. Phone is optional. Choose Status: Confirmed or Reserved.",
          "Select Create booking. If a required field is missing you will see Complete venue, court, date, time and player name. If the slot is taken you will see No slots available or the conflict message.",
          "With valid data and a free slot, the panel confirms creation, closes the form and refreshes the list.",
          "Cancel closes the form without confirming. If session or permission fails, refresh and review the list before retrying; the booking may have been created."
        ],
        "limit": "These instructions were reviewed against the panel. If an option is not shown or the server denies it, do not change the URL or scope; ask support. An error does not confirm the operation was not saved or sent: refresh and review the list, history or values before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Criar uma reserva manual",
        "requirements": [
          "Papel com acesso a Reservas.",
          "Sede e quadra ativas dentro do seu escopo."
        ],
        "steps": [
          "Abra /admin, selecione Reservas e escolha Crear reserva manual.",
          "Preencha Sede se aplicável, Cancha (somente ativas), Fecha, Hora inicio e Duração (60, 90 ou 120 min; padrão 90).",
          "Busque e selecione o Jugador. O Teléfono é opcional. Escolha Estado: Confirmada ou Reservada.",
          "Selecione Crear reserva. Se faltar um campo obrigatório verá Completa sede, cancha, fecha, hora y nombre del jugador. Se o horário estiver ocupado verá Sin horarios disponibles ou a mensagem de conflito.",
          "Com dados válidos e horário livre, o painel confirma a criação, fecha o formulário e atualiza a lista.",
          "Cancelar fecha sem confirmar. Se falhar a sessão ou a permissão, atualize e revise a lista antes de tentar novamente; a reserva pode ter sido criada."
        ],
        "limit": "Estas instruções foram revisadas no painel. Se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo; consulte o suporte. Tradução PT não verificada na interface. Um erro não confirma que a operação não foi guardada ou enviada: atualize e revise a lista, histórico ou valores antes de tentar novamente para evitar duplicados."
      }
    }
  },
  {
    "id": "admin-validaciones-aprobar",
    "module": "validaciones",
    "slug": "validaciones",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "e2a3493cd306dfcf06a4c1aae4c7e135bb0ba2db",
      "backend": "706f515a4473dab226fcc11be0b0964fbe3b687a"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:12620-12730",
      "backend42:routes/adminValidationAndChannels.js:51,84,90,109,139",
      "WEB553ce658:padbol-match-frontend/src/components/PendingValidationBulkActions.jsx:1-17",
      "WEB553ce658:padbol-match-frontend/src/hooks/useBulkPendingValidation.js:1-63",
      "backend706f515a:routes/adminValidationAndChannels.js:82-105"
    ],
    "translations": {
      "es": {
        "title": "Aprobar jugadores pendientes",
        "requirements": [
          "Rol admin_club o super_admin.",
          "Jugadores pendientes de tu sede."
        ],
        "steps": [
          "Entra a /admin y abre Validaciones.",
          "Busca al jugador y revisa nombre, email, género y categoría.",
          "Abre Ver perfil si necesitas contexto.",
          "Usa Aprobar o Cambiar categoría. Si cambias categoría, elige la nueva y pulsa Guardar.",
          "Para aprobar varias solicitudes, marca las casillas o usa Seleccionar todos los visibles. Revisa el contador, pulsa Aprobar seleccionados y confirma la cantidad. Se procesan una por una; el resumen muestra las confirmadas. Si el proceso se detiene, pulsa Actualizar lista y comprueba el último resultado antes de volver a seleccionar o reintentar.",
          "Si aparece un error, actualiza la lista y revisa el resultado antes de reintentar; el cambio podría haberse guardado."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Solo tu sede asignada; si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance. Un error no confirma que la operación no se guardó o envió: actualiza y revisa la lista, el historial o los valores antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Approve pending players",
        "requirements": [
          "admin_club or super_admin role.",
          "Pending players for your venue."
        ],
        "steps": [
          "Open /admin and select Validaciones.",
          "Search for the player and review name, email, gender and category.",
          "Open View profile if you need context.",
          "Use Approve or Change category. If changing category, choose the new one and select Save.",
          "To approve several requests, select their checkboxes or use Select all visible. Review the count, choose Approve selected and confirm the number. Requests are processed one at a time; the summary shows confirmed results. If processing stops, choose Refresh list and check the last result before selecting or retrying.",
          "If an error appears, refresh the list and check the result before retrying; the change may already have been saved."
        ],
        "limit": "These instructions were reviewed against the panel. Only your assigned venue; if an option is not shown or the server denies it, do not change the URL or scope. An error does not confirm the operation was not saved or sent: refresh and review the list, history or values before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Aprovar jogadores pendentes",
        "requirements": [
          "Papel admin_club ou super_admin.",
          "Jogadores pendentes da sua sede."
        ],
        "steps": [
          "Abra /admin e selecione Validaciones.",
          "Busque o jogador e revise nome, email, gênero e categoria.",
          "Abra Ver perfil se precisar de contexto.",
          "Use Aprobar ou Cambiar categoría. Se mudar a categoria, escolha a nova e selecione Guardar.",
          "Para aprovar várias solicitações, marque as caixas ou use Selecionar todos os visíveis. Revise a quantidade, selecione Aprovar selecionados e confirme. As solicitações são processadas uma por vez; o resumo mostra as confirmadas. Se o processamento parar, selecione Atualizar lista e confira o último resultado antes de selecionar ou tentar novamente.",
          "Se aparecer um erro, atualize a lista e confira o resultado antes de tentar novamente; a alteração pode ter sido salva."
        ],
        "limit": "Estas instruções foram revisadas no painel. Apenas sua sede atribuída; se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo. Tradução PT não verificada. Um erro não confirma que a operação não foi guardada ou enviada: atualize e revise a lista, histórico ou valores antes de tentar novamente para evitar duplicados."
      }
    }
  },
  {
    "id": "admin-validaciones-rechazar",
    "module": "validaciones",
    "slug": "rechazar",
    "allowedRoles": [
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "e2a3493cd306dfcf06a4c1aae4c7e135bb0ba2db",
      "backend": "706f515a4473dab226fcc11be0b0964fbe3b687a"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:12620-12730",
      "backend42:routes/adminValidationAndChannels.js:84,90,109,139",
      "WEB553ce658:padbol-match-frontend/src/components/PendingValidationBulkActions.jsx:1-17",
      "WEB553ce658:padbol-match-frontend/src/hooks/useBulkPendingValidation.js:1-63",
      "backend706f515a:routes/adminValidationAndChannels.js:82-105"
    ],
    "translations": {
      "es": {
        "title": "Rechazar una solicitud de validación pendiente",
        "requirements": [
          "Rol super_admin confirmado por el servidor."
        ],
        "steps": [
          "Entra a /admin y abre Validaciones.",
          "Busca al jugador y abre su solicitud pendiente.",
          "Selecciona Rechazar y confirma el aviso.",
          "El rechazo cierra la solicitud pendiente; no elimina el perfil, no cambia la categoría y no promete una reapertura automática.",
          "Para rechazar varias solicitudes, marca sus casillas o usa Seleccionar todos los visibles, pulsa Rechazar seleccionados y confirma la cantidad. Esta acción sigue siendo exclusiva de super_admin. Revisa el resumen de confirmadas; si el proceso se detiene, pulsa Actualizar lista y comprueba el último resultado antes de reintentar.",
          "Actualiza la lista y revisa el estado. Si hubo error, comprueba si la solicitud ya quedó cerrada antes de reintentar."
        ],
        "limit": "Rechazar solo cierra la solicitud pendiente. No borra el perfil ni cambia la categoría ni reabre automáticamente. Un error no confirma que no se guardó: actualiza y revisa antes de reintentar."
      },
      "en": {
        "title": "Reject a pending validation request",
        "requirements": [
          "super_admin role confirmed by the server."
        ],
        "steps": [
          "Open /admin and select Validaciones.",
          "Search for the player and open the pending request.",
          "Select Reject and confirm the dialog.",
          "Rejection closes the pending request; it does not delete the profile, change the category or promise automatic reopening.",
          "To reject several requests, select their checkboxes or use Select all visible, choose Reject selected and confirm the count. This action remains super_admin-only. Review confirmed results; if processing stops, choose Refresh list and check the last result before retrying.",
          "Refresh the list and review status. If there was an error, check whether the request is already closed before retrying."
        ],
        "limit": "Rejection only closes the pending request. It does not delete the profile, change category or reopen automatically. An error does not confirm it was not saved: refresh and review before retrying."
      },
      "pt": {
        "title": "Rejeitar uma solicitação de validação pendente",
        "requirements": [
          "Papel super_admin confirmado pelo servidor."
        ],
        "steps": [
          "Abra /admin e selecione Validaciones.",
          "Busque o jogador e abra a solicitação pendente.",
          "Selecione Rechazar e confirme o aviso.",
          "A rejeição fecha a solicitação pendente; não exclui o perfil, não altera a categoria e não promete reabertura automática.",
          "Para rejeitar várias solicitações, marque as caixas ou use Selecionar todos os visíveis, selecione Rejeitar selecionados e confirme a quantidade. A ação continua exclusiva de super_admin. Revise as confirmadas; se o processamento parar, selecione Atualizar lista e confira o último resultado antes de tentar novamente.",
          "Atualize a lista e revise o status. Se houve erro, verifique se a solicitação já foi fechada antes de tentar novamente."
        ],
        "limit": "Rejeitar apenas fecha a solicitação pendente. Não exclui o perfil, não altera a categoria e não reabre automaticamente. Um erro não confirma que não foi guardado: atualize e revise antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-torneos-crear",
    "module": "torneos",
    "slug": "crear-configurar",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:11414-11530",
      "WEB798:padbol-match-frontend/src/pages/TorneoCrear.jsx:84-400",
      "backend42:server.js:1923,1940,2054",
      "backend42:lib/torneos/torneoAdminAccessService.js:31"
    ],
    "translations": {
      "es": {
        "title": "Crear y configurar un torneo",
        "requirements": [
          "Rol con acceso a Torneos.",
          "Sede y política de puntos disponibles."
        ],
        "steps": [
          "Entra a /admin, abre Torneos y pulsa + Nuevo Torneo.",
          "Completa nombre, deporte, formato de equipos, modalidad de plantel, nivel y sede.",
          "Elige tipo de competencia, categoría de edad, fecha de corte si corresponde, categoría y formato de fixture.",
          "Define estado inicial, equipos por grupo, clasificados y fechas de inicio/fin. Revisa inscripción y premios si aplican.",
          "Pulsa Crear torneo. Si falta un campo obligatorio, el formulario lo indica y no crea nada. Si la política de puntos no está disponible, se muestra el error y puedes reintentar."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance; consulta con soporte. Un error no confirma que la operación no se guardó o envió: actualiza y revisa la lista, el historial o los valores antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Create and configure a tournament",
        "requirements": [
          "Role with Tournament access.",
          "Venue and points policy available."
        ],
        "steps": [
          "Open /admin, select Torneos and choose + Nuevo Torneo.",
          "Complete name, sport, team format, roster mode, level and venue.",
          "Choose competition type, age category, cutoff date if applicable, category and fixture format.",
          "Set initial status, teams per group, qualifiers and start/end dates. Review registration fee and prizes if applicable.",
          "Select Create tournament. If a required field is missing the form marks it and creates nothing. If the points policy is unavailable, an error and retry are shown."
        ],
        "limit": "These instructions were reviewed against the panel. If an option is not shown or the server denies it, do not change the URL or scope; ask support. An error does not confirm the operation was not saved or sent: refresh and review the list, history or values before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Criar e configurar um torneio",
        "requirements": [
          "Papel com acesso a Torneios.",
          "Sede e politica de pontos disponíveis."
        ],
        "steps": [
          "Abra /admin, selecione Torneios e escolha + Nuevo Torneo.",
          "Preencha nome, esporte, formato de equipes, modalidade de plantel, nível e sede.",
          "Escolha tipo de competição, categoria de idade, data de corte se aplicável, categoria e formato de fixture.",
          "Defina status inicial, equipes por grupo, classificados e datas de início/fim. Revise inscrição e prêmios se aplicável.",
          "Selecione Crear torneo. Se faltar um campo obrigatório, o formulário indica e nada é criado. Se a politica de pontos não estiver disponível, um erro e a opção de tentar novamente são exibidos."
        ],
        "limit": "Estas instruções foram revisadas no painel. Se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo; consulte o suporte. Tradução PT não verificada na interface. Um erro não confirma que a operação não foi guardada ou enviada: atualize e revise a lista, histórico ou valores antes de tentar novamente para evitar duplicados."
      }
    }
  },
  {
    "id": "admin-torneos-plantel",
    "module": "torneos",
    "slug": "plantel",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/torneo/TorneoTabbedView.jsx:201-205",
      "WEB798:padbol-match-frontend/src/i18n/locales/es.json:torneos.vista.tabEquipos",
      "backend42:server.js:1923,1940,2054",
      "backend42:lib/torneos/torneoAdminAccessService.js:31"
    ],
    "translations": {
      "es": {
        "title": "Gestionar el plantel del torneo",
        "requirements": [
          "Torneo existente con equipos o solicitudes.",
          "Rol admin_club o super_admin."
        ],
        "steps": [
          "Abre /admin → Torneos y entra al torneo.",
          "Selecciona la pestaña EQUIPOS. Si hay solicitudes, usa Ver planteles y solicitudes.",
          "En un equipo pulsa Gestionar para abrir su plantel; revisa o agrega jugadores y guarda desde el editor del equipo.",
          "Para inscribir un equipo nuevo usa Crear equipo y completa el formulario visible; confirma la creación.",
          "Actualiza la pestaña y revisa que el equipo y sus jugadores aparezcan. Si hubo error, actualiza y revisa antes de reintentar para no duplicar el equipo."
        ],
        "limit": "Solo equipos/planteles existentes; Un error no confirma que no se guardó: actualiza y revisa la pestaña antes de reintentar."
      },
      "en": {
        "title": "Manage the tournament roster",
        "requirements": [
          "Existing tournament with teams or requests.",
          "admin_club or super_admin role."
        ],
        "steps": [
          "Open /admin → Torneos and enter the tournament.",
          "Select the EQUIPOS tab. If there are requests, use View rosters and requests.",
          "On a team select Gestionar to open its roster; review or add players and save in the team editor.",
          "To register a new team use Create team and complete the visible form; confirm creation.",
          "Refresh the tab and verify the team and players appear. If there was an error, refresh and review before retrying to avoid duplicate teams."
        ],
        "limit": "Existing teams/rosters only; the unpublished bulk button is not documented. An error does not confirm it was not saved: refresh and review the tab before retrying."
      },
      "pt": {
        "title": "Gerenciar o plantel do torneio",
        "requirements": [
          "Torneio existente com equipes ou solicitações.",
          "Papel admin_club ou super_admin."
        ],
        "steps": [
          "Abra /admin → Torneos e entre no torneio.",
          "Selecione a aba EQUIPOS. Se houver solicitações, use Ver planteles y solicitudes.",
          "Em uma equipe selecione Gestionar para abrir o plantel; revise ou adicione jogadores e guarde no editor da equipe.",
          "Para inscrever uma equipe nova use Crear equipo e preencha o formulário visível; confirme a criação.",
          "Atualize a aba e verifique equipe e jogadores. Se houve erro, atualize e revise antes de tentar novamente para evitar equipes duplicadas."
        ],
        "limit": "Somente equipes/plantéis existentes; o botão massivo não publicado não é documentado. Um erro não confirma que não foi guardado: atualize e revise a aba antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-torneos-fixture",
    "module": "torneos",
    "slug": "fixture",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/torneo/TorneoTabbedView.jsx:201-205",
      "WEB798:padbol-match-frontend/src/components/torneo/TournamentFixturePlanner.jsx",
      "backend42:server.js:1923,1940,2054",
      "backend42:lib/torneos/torneoAdminAccessService.js:31"
    ],
    "translations": {
      "es": {
        "title": "Generar y guardar el fixture",
        "requirements": [
          "Torneo con equipos suficientes.",
          "Rol admin_club o super_admin."
        ],
        "steps": [
          "Abre el torneo y entra a FIXTURE (o LLAVE en knockout).",
          "En Preparar y revisar fixture elige Origen del sorteo: Generar en la aplicación o, si el torneo es knockout, Ya hice el sorteo: cargar cruces.",
          "Si cargas cruces manuales, completa cada Cruce N con Equipo A y Equipo B sin repetir equipos.",
          "Pulsa Revisar fixture antes de guardar. Revisa el aviso: se guardará el cuadro y el torneo seguirá abierto; no se reemplazan partidos existentes.",
          "Pulsa Confirmar y guardar fixture. Actualiza y revisa los partidos; si hubo error, comprueba si el cuadro ya se guardó antes de reintentar."
        ],
        "limit": "Guardar el fixture no inicia el torneo. Un error no confirma que no se guardó: actualiza y revisa los partidos antes de reintentar."
      },
      "en": {
        "title": "Generate and save the fixture",
        "requirements": [
          "Tournament with enough teams.",
          "admin_club or super_admin role."
        ],
        "steps": [
          "Open the tournament and select FIXTURE (or LLAVE for knockout).",
          "In Prepare and review fixture choose Draw origin: Generate in the app or, for knockout, I already drew it: load matchups.",
          "For manual matchups, complete each Matchup N with Team A and Team B without repeating teams.",
          "Select Review fixture before saving. Read the notice: the bracket will be saved and the tournament stays open; existing matches are not replaced.",
          "Select Confirm and save fixture. Refresh and review matches; if there was an error, check whether the bracket was already saved before retrying."
        ],
        "limit": "Saving the fixture does not start the tournament. An error does not confirm it was not saved: refresh and review matches before retrying."
      },
      "pt": {
        "title": "Gerar e guardar o fixture",
        "requirements": [
          "Torneio com equipes suficientes.",
          "Papel admin_club ou super_admin."
        ],
        "steps": [
          "Abra o torneio e selecione FIXTURE (ou LLAVE no knockout).",
          "Em Preparar y revisar fixture escolha Origen del sorteo: Generar en la aplicación ou, no knockout, Ya hice el sorteo: cargar cruces.",
          "Para cruces manuais, preencha cada Cruce N com Equipo A e Equipo B sem repetir equipes.",
          "Selecione Revisar fixture antes de guardar. Leia o aviso: o quadro será guardado e o torneio continuará aberto; partidas existentes não são substituídas.",
          "Selecione Confirmar y guardar fixture. Atualize e revise as partidas; se houve erro, verifique se o quadro já foi guardado antes de tentar novamente."
        ],
        "limit": "Guardar o fixture não inicia o torneio. Um erro não confirma que não foi guardado: atualize e revise as partidas antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-torneos-resultados",
    "module": "torneos",
    "slug": "resultados",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/torneo/TorneoTabbedView.jsx:201-205",
      "WEB798:padbol-match-frontend/src/i18n/locales/es.json:torneos.vista.tabResultados",
      "backend42:server.js:1923,1940,2054",
      "backend42:lib/torneos/torneoAdminAccessService.js:31"
    ],
    "translations": {
      "es": {
        "title": "Cargar resultados del torneo",
        "requirements": [
          "Torneo iniciado y fixture generado.",
          "Rol admin_club o super_admin."
        ],
        "steps": [
          "Abre el torneo y entra a RESULTADOS.",
          "Selecciona un partido y pulsa Cargar resultado.",
          "Completa set 1, set 2 y, si hace falta, set 3. En modalidad de selecciones confirma los cuatro presentados y las alineaciones antes de guardar.",
          "Pulsa Guardar resultado. Revisa el partido y la tabla/podio; si hubo error, actualiza y comprueba si el resultado ya se registró antes de reintentar.",
          "Si el torneo no está iniciado o falta el fixture, el panel pide iniciar/completar primero; no fuerces el estado."
        ],
        "limit": "Un error no confirma que el resultado no se guardó: actualiza y revisa el partido antes de reintentar."
      },
      "en": {
        "title": "Enter tournament results",
        "requirements": [
          "Started tournament with a generated fixture.",
          "admin_club or super_admin role."
        ],
        "steps": [
          "Open the tournament and select RESULTADOS.",
          "Select a match and choose Enter result.",
          "Complete set 1, set 2 and set 3 if needed. In selection mode confirm the four presented players and lineups before saving.",
          "Select Save result. Review the match and table/podium; if there was an error, refresh and check whether the result was already recorded before retrying.",
          "If the tournament is not started or the fixture is missing, the panel asks to start/complete it first; do not force the state."
        ],
        "limit": "An error does not confirm the result was not saved: refresh and review the match before retrying."
      },
      "pt": {
        "title": "Inserir resultados do torneio",
        "requirements": [
          "Torneio iniciado com fixture gerado.",
          "Papel admin_club ou super_admin."
        ],
        "steps": [
          "Abra o torneio e selecione RESULTADOS.",
          "Selecione uma partida e use Cargar resultado.",
          "Preencha set 1, set 2 e, se necessário, set 3. Na modalidade de seleções confirme os quatro apresentados e as escalações antes de guardar.",
          "Selecione Guardar resultado. Revise a partida e a tabela/pódio; se houve erro, atualize e verifique se o resultado já foi registrado antes de tentar novamente.",
          "Se o torneio não estiver iniciado ou faltar o fixture, o painel pede iniciar/completar primeiro; não force o estado."
        ],
        "limit": "Um erro não confirma que o resultado não foi guardado: atualize e revise a partida antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-marcador",
    "module": "marcador",
    "slug": "marcador",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:14202",
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:522-609",
      "backend42:routes/scoreboard.js:58,562,589"
    ],
    "translations": {
      "es": {
        "title": "Usar el marcador",
        "requirements": [
          "Rol con acceso a Marcador.",
          "Partido o cancha dentro de tu sede."
        ],
        "steps": [
          "Entra a /admin, abre Marcador y elige el partido del listado para abrir su control.",
          "Comprueba que el partido, los equipos y la cancha sean los correctos antes de operar. En el panel clásico, usa Editar para cargar el marcador y Copiar link árbitro, Copiar link vista pública, Copiar link TV o QR para compartir el enlace adecuado. Confirma que corresponda al mismo partido/cancha; si no tienes permiso, el servidor deniega la acción.",
          "Nations Cup — con el seguimiento habilitado, usa Crear enlace del árbitro y abre el panel del árbitro. Ese enlace es privado: compártelo sólo con el árbitro responsable, nunca como vista pública o TV.",
          "El enlace abre el control del mismo partido sin pedir al árbitro una cuenta de administrador. Revisa los nombres de los jugadores que figuran En cancha y en el banco antes de comenzar.",
          "Confirma los dos titulares y los suplentes disponibles; usa Iniciar partido cuando corresponda. Si el partido está pausado, usa Reanudar para continuar sin reiniciarlo.",
          "Sustituye al finalizar un game impar del set actual (1, 3, 5, 7 y siguientes), en la ventana de cambio de lado; nunca a mitad de game, durante un tie-break ni con el marcador pausado. En cada nuevo set, cuenta desde su primer game.",
          "Puedes sustituir uno o ambos jugadores del mismo equipo si hay suplentes disponibles. Selecciona por nombre quién sale y quién entra; para ambos, completa los dos pares y pulsa Registrar cambio una sola vez. Se guardan juntos o no se aplica ninguno.",
          "Pausar y Reanudar conservan el tiempo y el marcador. No reinicies el partido ni borres el historial para continuar.",
          "Si la respuesta es incierta, revisa el estado y usa Reintentar el mismo intento: conserva la misma intención y los mismos jugadores mientras se confirma.",
          "Marca los puntos reales hasta el último punto: gana quien obtiene dos sets y el resultado se guarda al terminar naturalmente. Comprueba que el partido figure terminado y el resultado esté guardado; después usa Cerrar seguimiento del partido terminado. No cierres anticipadamente ni inventes un resultado."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance; consulta con soporte. Un error no confirma que la operación no se guardó o envió: actualiza y revisa la lista, el historial o los valores antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Use the scoreboard",
        "requirements": [
          "Role with Scoreboard access.",
          "Match or court within your venue."
        ],
        "steps": [
          "Open /admin, select Marcador and choose the match from the list to open its controls.",
          "Check the match, teams and court are correct before operating the scoreboard. When using the classic panel, use Editar to update the score and Copiar link árbitro, Copiar link vista pública, Copiar link TV or QR to share the appropriate link. Confirm it belongs to the same match/court; if you lack permission, the server denies the action.",
          "Nations Cup — when tracking is enabled, select Crear enlace del árbitro (create referee link) and open the referee panel. This link is private: share it only with the responsible referee, never as the public or TV view.",
          "The link opens controls for the same match without requiring an administrator account for the referee. Check the player names shown on court and on the bench before starting.",
          "Confirm the two starters and available substitutes; select Iniciar partido (start match) when appropriate. If paused, select Reanudar (resume) to continue without resetting.",
          "Substitute after an odd game in the current set ends (1, 3, 5, 7 and later odd games), during the change-of-ends window; never mid-game, during a tie-break or while paused. Count again from the first game of each new set.",
          "You may replace one or both players on the same team when substitutes are available. Select by name who leaves and enters; for both, complete both pairs and select Registrar cambio (record substitution) once. Both changes are saved together or neither is applied.",
          "Pause and Resume preserve elapsed time and the score. Do not reset the match or delete its history to continue.",
          "If the response is uncertain, review the state and use Reintentar el mismo intento (retry the same attempt): preserve the same intention and players while the outcome is confirmed.",
          "Record real points through the final point: the first team to win two sets wins and the result is saved when the match ends naturally. Check that the match is finished and its result is saved; then select Cerrar seguimiento del partido terminado (close tracking for the finished match). Do not close early or invent a result."
        ],
        "limit": "These instructions were reviewed against the panel. If an option is not shown or the server denies it, do not change the URL or scope; ask support. An error does not confirm the operation was not saved or sent: refresh and review the list, history or values before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Usar o placar",
        "requirements": [
          "Papel com acesso a Marcador.",
          "Partida ou quadra dentro da sua sede."
        ],
        "steps": [
          "Abra /admin, selecione Marcador e escolha a partida na lista para abrir seu controle.",
          "Confira se a partida, as equipes e a quadra estão corretas antes de operar o placar. No painel clássico, use Editar para atualizar o placar e Copiar link árbitro, Copiar link vista pública, Copiar link TV ou QR para compartilhar o link adequado. Confirme que pertence à mesma partida/quadra; se não tiver permissão, o servidor nega a ação.",
          "Nations Cup — com o acompanhamento habilitado, selecione Crear enlace del árbitro (criar link do árbitro) e abra o painel do árbitro. O link é privado: compartilhe apenas com o árbitro responsável, nunca como visualização pública ou TV.",
          "O link abre o controle da mesma partida sem exigir uma conta de administrador para o árbitro. Confira os nomes dos jogadores em quadra e no banco antes de começar.",
          "Confirme os dois titulares e os reservas disponíveis; selecione Iniciar partido (iniciar partida) quando necessário. Se estiver pausado, selecione Reanudar (retomar) para continuar sem reiniciar.",
          "Faça substituições após terminar um game ímpar do set atual (1, 3, 5, 7 e os próximos ímpares), na janela de troca de lado; nunca no meio de um game, durante um tie-break ou com o placar pausado. Em cada novo set, conte a partir do primeiro game.",
          "É possível substituir um ou ambos os jogadores da mesma equipe quando houver reservas disponíveis. Selecione por nome quem sai e quem entra; para ambos, preencha os dois pares e selecione Registrar cambio (registrar substituição) uma única vez. As duas mudanças são salvas juntas ou nenhuma é aplicada.",
          "Pausar e Retomar preservam o tempo e o placar. Não reinicie a partida nem apague o histórico para continuar.",
          "Se a resposta for incerta, confira o estado e use Reintentar el mismo intento (tentar novamente a mesma tentativa): preserve a mesma intenção e os mesmos jogadores enquanto o resultado é confirmado.",
          "Registre os pontos reais até o último ponto: vence quem ganhar dois sets, e o resultado é salvo quando a partida termina naturalmente. Confira se a partida terminou e o resultado está salvo; depois selecione Cerrar seguimiento del partido terminado (fechar acompanhamento da partida encerrada). Não encerre antes da hora nem invente um resultado."
        ],
        "limit": "Estas instruções foram revisadas no painel. Se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo; consulte o suporte. Tradução PT não verificada na interface. Um erro não confirma que a operação não foi guardada ou enviada: atualize e revise a lista, histórico ou valores antes de tentar novamente para evitar duplicados."
      }
    }
  },
  {
    "id": "admin-jugadores",
    "module": "jugadores",
    "slug": "jugadores",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "e2a3493cd306dfcf06a4c1aae4c7e135bb0ba2db",
      "backend": "706f515a4473dab226fcc11be0b0964fbe3b687a"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:12557",
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:12608",
      "backend42:routes/adminJugadores.js:41,76",
      "backend42:lib/authAccess.js:1,39",
      "backend706f515a:routes/adminJugadores.js:72-130",
      "backend706f515a:lib/adminJugadoresService.js:598-752"
    ],
    "translations": {
      "es": {
        "title": "Buscar y revisar jugadores",
        "requirements": [
          "Rol admin_club o super_admin; para admin_club, sede asignada en el servidor."
        ],
        "steps": [
          "Entra a /admin y abre Jugadores.",
          "Usa el buscador por nombre o apellido.",
          "Abre la ficha del jugador y revisa los datos disponibles.",
          "Si no encuentras un jugador, prueba con otro término. No cambies la sede ni el alcance para ver datos de otra organización; el servidor lo impide."
        ],
        "limit": "Esta guía cubre la consulta de jugadores de una sede autorizada. El listado global está reservado a super_admin; admin_club permanece limitado a su sede. Si el servidor deniega el acceso, no cambies parámetros para forzarlo."
      },
      "en": {
        "title": "Search and review players",
        "requirements": [
          "admin_club or super_admin role; admin_club requires a server-assigned venue."
        ],
        "steps": [
          "Open /admin and select Jugadores.",
          "Use the search by name or surname.",
          "Open the player record and review the available data.",
          "If you cannot find a player, try another term. Do not change venue or scope to view another organization; the server prevents it."
        ],
        "limit": "This guide covers players at an authorized venue. The global roster is reserved for super_admin; admin_club remains limited to its venue. If access is denied, do not change parameters to bypass it."
      },
      "pt": {
        "title": "Buscar e revisar jogadores",
        "requirements": [
          "Papel admin_club ou super_admin; admin_club exige uma sede atribuída pelo servidor."
        ],
        "steps": [
          "Abra /admin e selecione Jugadores.",
          "Use a busca por nome ou sobrenome.",
          "Abra a ficha do jogador e revise os dados disponíveis.",
          "Se não encontrar, tente outro termo. Não altere a sede nem o escopo para ver outra organização; o servidor impede."
        ],
        "limit": "Este guia cobre jogadores de uma sede autorizada. A lista global é exclusiva de super_admin; admin_club continua limitado à sua sede. Se o acesso for negado, não altere parâmetros para forçá-lo."
      }
    }
  },
  {
    "id": "admin-membresias-planes",
    "module": "membresias",
    "slug": "planes",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/AdminMembresiasSection.jsx:665-900",
      "WEB798:padbol-match-frontend/src/utils/membresiasAdminApi.js:100-230"
    ],
    "translations": {
      "es": {
        "title": "Crear o editar un plan de membresía",
        "requirements": [
          "Rol admin_club o super_admin.",
          "Sede propia seleccionada."
        ],
        "steps": [
          "Entra a /admin, abre Membresías y quédate en la pestaña Planes.",
          "Pulsa Nuevo plan o Editar en un plan existente.",
          "Completa Sede, Nombre, Descripción, Precio, Moneda, Duración (Mensual, Trimestral, Semestral, Anual o Personalizada en días), Activo, Cupo y Vigencia desde/hasta.",
          "Revisa Renovación automática: es informativa y aún no hay cobro recurrente. Ajusta Beneficios: descuento %, reservas incluidas por período, prioridad de reserva y flexibilidad de cancelación.",
          "Pulsa Guardar. Si falta un obligatorio verás el mensaje del campo; si el guardado falla, actualiza y revisa la lista de planes antes de reintentar para no duplicar.",
          "Para retirar un plan, usa Activar/Desactivar con la confirmación; un plan inactivo no se puede asignar."
        ],
        "limit": "Planes y membresías de jugadores son distintos del plan comercial de la sede y de PadCoins. Un error no confirma que el plan no se guardó: actualiza y revisa la lista/valores antes de reintentar."
      },
      "en": {
        "title": "Create or edit a membership plan",
        "requirements": [
          "admin_club or super_admin role.",
          "Your own venue selected."
        ],
        "steps": [
          "Open /admin, select Membresías and stay on Planes.",
          "Select New plan or Edit on an existing plan.",
          "Complete Venue, Name, Description, Price, Currency, Duration (Monthly, Quarterly, Semiannual, Annual or Custom days), Active, Capacity and Valid from/to.",
          "Review Automatic renewal: it is informational and recurring billing is not active. Adjust Benefits: discount %, included bookings per period, booking priority and cancellation flexibility.",
          "Select Save. If a required field is missing you will see its message; if saving fails, refresh and review the plan list before retrying to avoid duplicates.",
          "To retire a plan, use Activate/Deactivate with confirmation; an inactive plan cannot be assigned."
        ],
        "limit": "Player plans and memberships are separate from the venue commercial plan and PadCoins. An error does not confirm the plan was not saved: refresh and review the list/values before retrying."
      },
      "pt": {
        "title": "Criar ou editar um plano de membresia",
        "requirements": [
          "Papel admin_club ou super_admin.",
          "Sua sede selecionada."
        ],
        "steps": [
          "Abra /admin, selecione Membresías e fique em Planes.",
          "Selecione Nuevo plan ou Editar em um plano existente.",
          "Preencha Sede, Nombre, Descripción, Precio, Moneda, Duración (Mensual, Trimestral, Semestral, Anual ou Personalizada em dias), Activo, Cupo e Vigencia desde/hasta.",
          "Revise Renovación automática: é informativa e ainda não há cobrança recorrente. Ajuste Beneficios: desconto %, reservas incluídas, prioridade e flexibilidade de cancelamento.",
          "Selecione Guardar. Se faltar um obrigatório verá a mensagem; se falhar, atualize e revise a lista de planos antes de tentar novamente para evitar duplicados.",
          "Para retirar um plano, use Activar/Desactivar com confirmação; um plano inativo não pode ser atribuído."
        ],
        "limit": "Planos e membresias de jogadores são diferentes do plano comercial da sede e de PadCoins. Um erro não confirma que o plano não foi guardado: atualize e revise a lista/valores antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-membresias-asignadas",
    "module": "membresias",
    "slug": "asignadas",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/AdminMembresiasSection.jsx:900-1060",
      "WEB798:padbol-match-frontend/src/utils/membresiasAdminApi.js:560-640"
    ],
    "translations": {
      "es": {
        "title": "Asignar, renovar, suspender o cancelar una membresía",
        "requirements": [
          "Rol admin_club o super_admin.",
          "Sede propia y un plan activo."
        ],
        "steps": [
          "Abre Membresías y entra a Membresías asignadas.",
          "Pulsa Asignar membresía. Elige Jugador, Plan y Fecha de inicio; completa Origen y Notas si corresponde.",
          "Pulsa Asignar; revisa el aviso Confirmar asignación. Si el jugador ya tiene una membresía activa en la sede, el aviso indica que se cancelará la existente.",
          "En la fila de una membresía usa Renovar, Suspender o Cancelar. Cada acción pide confirmación: Renovar crea una nueva activa con el mismo plan; Suspender deja de dar beneficios; Cancelar es estado final y para reactivar hay que asignar otra.",
          "Después de confirmar, actualiza la lista y revisa estado, plan, inicio y vencimiento. Si hubo error, no reintentes a ciegas: actualiza y comprueba si la acción ya quedó registrada para evitar duplicados."
        ],
        "limit": "Asignar o renovar no promete cobro automático. Un error no confirma que la acción no se guardó: actualiza y revisa la lista/historial antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Assign, renew, suspend or cancel a membership",
        "requirements": [
          "admin_club or super_admin role.",
          "Your own venue and an active plan."
        ],
        "steps": [
          "Open Membresías and select Assigned memberships.",
          "Select Assign membership. Choose Player, Plan and Start date; complete Origin and Notes if applicable.",
          "Select Assign; review the Confirm assignment dialog. If the player already has an active membership at the venue, the dialog warns that it will be cancelled.",
          "On a membership row use Renew, Suspend or Cancel. Each asks for confirmation: Renew creates a new active one with the same plan; Suspend stops benefits; Cancel is final and reactivation requires a new assignment.",
          "After confirming, refresh the list and review status, plan, start and expiration. If there was an error, do not retry blindly: refresh and check whether the action was already recorded to avoid duplicates."
        ],
        "limit": "Assigning or renewing does not promise automatic billing. An error does not confirm the action was not saved: refresh and review the list/history before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Atribuir, renovar, suspender ou cancelar uma membresia",
        "requirements": [
          "Papel admin_club ou super_admin.",
          "Sua sede e um plano ativo."
        ],
        "steps": [
          "Abra Membresías e selecione Membresías asignadas.",
          "Selecione Asignar membresía. Escolha Jugador, Plan e Fecha de inicio; preencha Origen e Notas se aplicável.",
          "Selecione Asignar; revise o aviso Confirmar asignación. Se o jogador já tiver uma membresia ativa na sede, o aviso indica que ela será cancelada.",
          "Na linha use Renovar, Suspender ou Cancelar. Cada ação pede confirmação: Renovar cria uma nova ativa com o mesmo plano; Suspender interrompe benefícios; Cancelar é estado final e reativar exige nova atribuição.",
          "Depois de confirmar, atualize a lista e revise estado, plano, início e vencimento. Se houve erro, não tente novamente às cegas: atualize e verifique se a ação já foi registrada para evitar duplicados."
        ],
        "limit": "Atribuir ou renovar não promete cobrança automática. Um erro não confirma que a ação não foi guardada: atualize e revise a lista/histórico antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-padcoins",
    "module": "membresias",
    "slug": "padcoins",
    "allowedRoles": [
      "admin_club",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/AdminPadcoinsReportesSection.jsx:19-22,239-260,520-570",
      "WEB798:padbol-match-frontend/src/utils/padcoinsReportesApi.js:144-210",
      "backend42:src/routes/padcoinsReportes.js:32-135"
    ],
    "translations": {
      "es": {
        "title": "Consultar reportes de PadCoins",
        "requirements": [
          "Rol admin_club o super_admin.",
          "Sede propia en el alcance."
        ],
        "steps": [
          "Entra a /admin y abre PadCoins.",
          "Elige la pestaña Resumen, Movimientos, Canjes o Jugadores.",
          "Usa los filtros visibles: Sede, Desde, Hasta, Tipo, Campaña, Estado, Beneficio, Nivel y Jugador; pulsa Aplicar filtros.",
          "Revisa los totales o la tabla de la pestaña. No hay formulario de movimiento en esta sección: solo consulta y exportación.",
          "Si necesitas el detalle, pulsa Exportar movimientos, Exportar canjes o Exportar jugadores según la pestaña y espera la descarga CSV."
        ],
        "limit": "Esta sección es de solo consulta; no crea, acredita ni modifica PadCoins. Un error de descarga no modifica los datos; actualiza y revisa la tabla o el archivo antes de reintentar."
      },
      "en": {
        "title": "Review PadCoins reports",
        "requirements": [
          "admin_club or super_admin role.",
          "Your own venue in scope."
        ],
        "steps": [
          "Open /admin and select PadCoins.",
          "Choose Summary, Movements, Redemptions or Players.",
          "Use the visible filters: Venue, From, To, Type, Campaign, Status, Benefit, Level and Player; select Apply filters.",
          "Review the totals or table. This section has no movement form: it is read-only reports and export.",
          "For detail, select Export movements, Export redemptions or Export players for the tab and wait for the CSV download."
        ],
        "limit": "This section is read-only; it does not create, credit or change PadCoins. A download error does not change data; refresh and review the table or file before retrying."
      },
      "pt": {
        "title": "Consultar relatórios de PadCoins",
        "requirements": [
          "Papel admin_club ou super_admin.",
          "Sua sede no escopo."
        ],
        "steps": [
          "Abra /admin e selecione PadCoins.",
          "Escolha a aba Resumen, Movimientos, Canjes ou Jugadores.",
          "Use os filtros visíveis: Sede, Desde, Hasta, Tipo, Campaña, Estado, Beneficio, Nivel e Jugador; selecione Aplicar filtros.",
          "Revise os totais ou a tabela. Esta seção não tem formulário de movimento: é somente consulta e exportação.",
          "Para detalhe, selecione Exportar movimientos, Exportar canjes ou Exportar jugadores e aguarde o CSV."
        ],
        "limit": "Esta seção é somente consulta; não cria, credita nem altera PadCoins. Um erro de download não altera os dados; atualize e revise a tabela ou o arquivo antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-incentivos-consulta",
    "module": "incentivos",
    "slug": "consulta",
    "allowedRoles": [
      "admin_club",
      "admin_nacional",
      "admin_cadena",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/AdminIncentivosSection.jsx",
      "backend42:lib/sedeIncentivesV4.js:21,43-73,576-605,744-765",
      "backend42:lib/releaseServices.js:33"
    ],
    "translations": {
      "es": {
        "title": "Consultar el informe de incentivos",
        "requirements": [
          "Rol administrativo con alcance de sede vigente."
        ],
        "steps": [
          "Entra a /admin y abre Incentivos.",
          "Elige Sede y Mes del informe; el mes no puede ser futuro. Pulsa Actualizar informe.",
          "Revisa los cuatro objetivos fijos: torneo integral, resultados más marcador digital al 50%, reservas verificadas y jugadores activos.",
          "Lee el estado de cada objetivo: Cumplido, Pendiente o Dato no disponible. El resultado es un informe/preview y no otorga créditos ni confirma un descuento.",
          "Si ves Actualización de objetivos pendiente, el informe de cuatro objetivos aún no está disponible para esa sede; no uses registros anteriores como cumplimiento."
        ],
        "limit": "Solo consulta. No activa cobros, Stripe ni créditos. Un error de consulta no modifica datos; actualiza y revisa el informe antes de reintentar."
      },
      "en": {
        "title": "Review the incentives report",
        "requirements": [
          "Administrative role with current venue scope."
        ],
        "steps": [
          "Open /admin and select Incentivos.",
          "Choose Sede and Mes del informe; the month cannot be in the future. Select Actualizar informe.",
          "Review the four fixed goals: complete tournament, results plus digital scoreboard at 50%, verified bookings and active players.",
          "Read each goal status: Cumplido, Pendiente or Dato no disponible. The result is a report/preview and does not grant credits or confirm a discount.",
          "If Actualización de objetivos pendiente appears, the four-goal report is not available for that venue yet; do not treat older records as compliance."
        ],
        "limit": "Review only. It does not activate billing, Stripe or credits. A review error does not change data; refresh and review the report before retrying."
      },
      "pt": {
        "title": "Consultar o relatório de incentivos",
        "requirements": [
          "Papel administrativo com escopo de sede vigente."
        ],
        "steps": [
          "Abra /admin e selecione Incentivos.",
          "Escolha Sede e Mes del informe; o mês não pode ser futuro. Selecione Actualizar informe.",
          "Revise os quatro objetivos fixos: torneio integral, resultados mais placar digital em 50%, reservas verificadas e jogadores ativos.",
          "Leia o status de cada objetivo: Cumplido, Pendiente ou Dato no disponible. O resultado é um relatório/prévia e não concede créditos nem confirma desconto.",
          "Se aparecer Actualización de objetivos pendiente, o relatório de quatro objetivos ainda não está disponível para essa sede; não use registros antigos como cumprimento."
        ],
        "limit": "Somente consulta. Não ativa cobrança, Stripe nem créditos. Um erro de consulta não altera dados; atualize e revise o relatório antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-incentivos-configuracion",
    "module": "incentivos",
    "slug": "configuracion",
    "allowedRoles": [
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "backend42:lib/sedeIncentivesV4.js:21,43-73,666-745",
      "backend42:routes/commercialRelease.js:71"
    ],
    "translations": {
      "es": {
        "title": "Preparar objetivos del borrador de incentivos",
        "requirements": [
          "Rol super_admin confirmado por el servidor.",
          "Sede sin suscripción Stripe activa."
        ],
        "steps": [
          "Entra a /admin y abre Incentivos.",
          "Selecciona la sede y abre el bloque Crear un borrador del programa o Configurar los objetivos del borrador.",
          "Revisa los cuatro objetivos fijos que muestra el panel y la confirmación de que se cumplen juntos; no hay un editor libre de metas.",
          "Marca Confirmo estos cuatro objetivos mensuales para el borrador.",
          "Pulsa Crear borrador sin activar cobros o Guardar objetivos del borrador según corresponda. Revisa el aviso y actualiza el informe; si hubo error, comprueba el estado antes de reintentar."
        ],
        "limit": "Solo se prepara un borrador; no activa cobros, Stripe ni créditos. Un error no confirma que no se guardó: actualiza y revisa el borrador antes de reintentar."
      },
      "en": {
        "title": "Prepare the incentive draft goals",
        "requirements": [
          "super_admin role confirmed by the server.",
          "Venue without an active Stripe subscription."
        ],
        "steps": [
          "Open /admin and select Incentivos.",
          "Choose the venue and open Crear un borrador del programa or Configurar los objetivos del borrador.",
          "Review the four fixed goals shown by the panel and the confirmation that they are met together; there is no free-form goal editor.",
          "Check Confirmo estos cuatro objetivos mensuales para el borrador.",
          "Select Crear borrador sin activar cobros or Guardar objetivos del borrador as applicable. Review the notice and refresh the report; if there was an error, check the status before retrying."
        ],
        "limit": "Only a draft is prepared; it does not activate billing, Stripe or credits. An error does not confirm it was not saved: refresh and review the draft before retrying."
      },
      "pt": {
        "title": "Preparar objetivos do rascunho de incentivos",
        "requirements": [
          "Papel super_admin confirmado pelo servidor.",
          "Sede sem assinatura Stripe ativa."
        ],
        "steps": [
          "Abra /admin e selecione Incentivos.",
          "Escolha a sede e abra Crear un borrador del programa ou Configurar los objetivos del borrador.",
          "Revise os quatro objetivos fixos exibidos e a confirmação de que são cumpridos juntos; não há editor livre de metas.",
          "Marque Confirmo estos cuatro objetivos mensuales para el borrador.",
          "Selecione Crear borrador sin activar cobros ou Guardar objetivos del borrador conforme o caso. Revise o aviso e atualize o relatório; se houve erro, verifique o status antes de tentar novamente."
        ],
        "limit": "Somente rascunho; não ativa cobrança, Stripe nem créditos. Um erro não confirma que não foi guardado: atualize e revise o rascunho antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-notificaciones",
    "module": "notificaciones",
    "slug": "notificaciones",
    "allowedRoles": [
      "admin_club",
      "admin_cadena",
      "admin_nacional",
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/components/AdminNotificacionesSection.jsx:16-17,63-83,331-341,378-606",
      "backend42:lib/adminPushNotifications.js:11,17,141-260,312-414,483-495"
    ],
    "translations": {
      "es": {
        "title": "Preparar una notificación push",
        "requirements": [
          "Rol admin_club, admin_cadena, admin_nacional o super_admin con alcance persistido.",
          "admin_cadena: notificaciones habilitadas para su organización."
        ],
        "steps": [
          "Entra a /admin y abre Notificaciones.",
          "Escribe el título (máximo 50 caracteres) y el cuerpo (máximo 150). El contador muestra el límite.",
          "Elige el destino y solo un segmento permitido para tu rol: club, su sede o un jugador de su alcance; cadena, sus sedes o un jugador de su alcance; nacional, país completo solo si su alcance lo permite, ciudades o sedes de su territorio, o un jugador de su alcance; super_admin, los segmentos globales disponibles.",
          "Revisa el alcance y la cuota semanal que muestra el panel. admin_cadena necesita la habilitación de su organización; si no está, el servidor deniega.",
          "Pulsa Enviar. La solicitud aceptada solo confirma que el envío fue aceptado, no que el dispositivo la haya recibido.",
          "Actualiza el historial y revisa el estado. Si hubo error, actualiza antes de reintentar para no duplicar envíos."
        ],
        "limit": "Título 50 y cuerpo 150. La aceptación no demuestra entrega al dispositivo; confirma en el historial. Un error no confirma que no se envió: actualiza y revisa antes de reintentar."
      },
      "en": {
        "title": "Prepare a push notification",
        "requirements": [
          "admin_club, admin_cadena, admin_nacional or super_admin role with persisted scope.",
          "admin_cadena: notifications enabled for the organization."
        ],
        "steps": [
          "Open /admin and select Notificaciones.",
          "Write the title (max 50 characters) and body (max 150). The counter shows the limit.",
          "Choose the destination and only a segment permitted for your role: club, its venue or a player within its scope; chain, its venues or a player within its scope; national, the whole country only when its scope permits, cities or venues in its territory, or a player within its scope; super_admin, the available global segments.",
          "Review the scope and weekly quota shown by the panel. admin_cadena needs organization enablement; otherwise the server denies it.",
          "Select Send. An accepted request only confirms the send was accepted, not that the device received it.",
          "Refresh the history and review status. If there was an error, refresh before retrying to avoid duplicate sends."
        ],
        "limit": "Title 50 and body 150. Acceptance does not prove device delivery; confirm in the history. An error does not confirm it was not sent: refresh and review before retrying."
      },
      "pt": {
        "title": "Preparar uma notificação push",
        "requirements": [
          "Papel admin_club, admin_cadena, admin_nacional ou super_admin com escopo persistido.",
          "admin_cadena: notificações habilitadas para a organização."
        ],
        "steps": [
          "Abra /admin e selecione Notificaciones.",
          "Escreva o título (máx. 50 caracteres) e o corpo (máx. 150). O contador mostra o limite.",
          "Escolha o destino e apenas um segmento permitido para seu papel: clube, sua sede ou um jogador do seu escopo; rede, suas sedes ou um jogador do seu escopo; nacional, o país inteiro somente se seu escopo permitir, cidades ou sedes do seu território, ou um jogador do seu escopo; super_admin, os segmentos globais disponíveis.",
          "Revise o escopo e a cota semanal exibida. admin_cadena precisa da habilitação da organização; se não houver, o servidor nega.",
          "Selecione Enviar. A solicitação aceita confirma apenas que o envio foi aceito, não que o dispositivo recebeu.",
          "Atualize o histórico e revise o status. Se houve erro, atualize antes de tentar novamente para evitar duplicados."
        ],
        "limit": "Título 50 e corpo 150. A aceitação não prova entrega ao dispositivo; confirme no histórico. Um erro não confirma que não foi enviado: atualize e revise antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-configuracion",
    "module": "configuracion",
    "slug": "configuracion",
    "allowedRoles": [
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/AdminDashboard.jsx:17789-17980",
      "backend42:routes/pointsConfig.js:7"
    ],
    "translations": {
      "es": {
        "title": "Configurar puntos y posiciones",
        "requirements": [
          "Rol super_admin confirmado por el servidor."
        ],
        "steps": [
          "Entra a /admin y abre Configuración.",
          "Selecciona Puntos y posiciones.",
          "Revisa los Puntos base por nivel de torneo y edita el valor que corresponda; usa Guardar en la fila.",
          "Puedes agregar tipos personalizados con nombre y puntos, o eliminarlos con la confirmación. Revisa la Distribución de puntos por posición con el nivel de vista previa.",
          "Guarda la configuración y actualiza la pantalla. Si hubo error, revisa los valores actuales antes de reintentar para no duplicar tipos."
        ],
        "limit": "Esta guía cubre Puntos y posiciones. Un error no confirma que los cambios no se guardaron: actualiza y revisa los valores antes de reintentar."
      },
      "en": {
        "title": "Configure points and positions",
        "requirements": [
          "super_admin role confirmed by the server."
        ],
        "steps": [
          "Open /admin and select Configuración.",
          "Choose Points and positions.",
          "Review Base points by tournament level and edit the relevant value; use Save in the row.",
          "You can add custom types with name and points, or delete them with confirmation. Review Points distribution by position with the preview level.",
          "Save the configuration and refresh. If there was an error, review current values before retrying to avoid duplicate types."
        ],
        "limit": "This guide covers Points and positions. An error does not confirm that changes were not saved: refresh and check the values before retrying."
      },
      "pt": {
        "title": "Configurar pontos e posições",
        "requirements": [
          "Papel super_admin confirmado pelo servidor."
        ],
        "steps": [
          "Abra /admin e selecione Configuración.",
          "Escolha Puntos y posiciones.",
          "Revise os Pontos base por nível e edite o valor correspondente; use Guardar na linha.",
          "Você pode adicionar tipos personalizados com nome e pontos, ou excluí-los com confirmação. Revise a Distribuição por posição com o nível de prévia.",
          "Guarde e atualize a tela. Se houve erro, revise os valores atuais antes de tentar novamente para evitar tipos duplicados."
        ],
        "limit": "Este guia cobre Pontos e posições. Um erro não confirma que as alterações não foram salvas: atualize e confira os valores antes de tentar novamente."
      }
    }
  },
  {
    "id": "admin-support-manage-tickets",
    "module": "soporte",
    "slug": "gestionar-tickets",
    "allowedRoles": [
      "super_admin"
    ],
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "798c844e",
      "backend": "42f4a804"
    },
    "sourceRefs": [
      "WEB798:padbol-match-frontend/src/pages/SupportTicketsPage.jsx:20-95",
      "backend42:routes/supportTickets.js:77-127",
      "backend42:lib/authAccess.js:60-79"
    ],
    "translations": {
      "es": {
        "title": "Revisar y responder tickets de soporte",
        "requirements": [
          "Sesión válida con rol super_admin confirmado por el servidor."
        ],
        "steps": [
          "Abre /admin/soporte.",
          "Filtra por estado si lo necesitas y selecciona un ticket.",
          "Revisa el historial. Distingue una respuesta al solicitante de una nota interna.",
          "Escribe la respuesta y usa Enviar respuesta, o marca Nota interna si no debe verla el solicitante.",
          "Cambia estado o prioridad solo cuando corresponda. Actualiza el historial y revisa el ticket si hubo error antes de reintentar; la respuesta pudo haberse enviado."
        ],
        "limit": "Estas instrucciones se revisaron contra el panel. Si una opción no aparece o el servidor la deniega, no cambies la URL ni el alcance; consulta con soporte. Un error no confirma que la operación no se guardó o envió: actualiza y revisa la lista, el historial o los valores antes de reintentar para evitar duplicados."
      },
      "en": {
        "title": "Review and reply to support tickets",
        "requirements": [
          "A valid session with the super_admin role confirmed by the server."
        ],
        "steps": [
          "Open /admin/soporte.",
          "Filter by status if needed and select a ticket.",
          "Review the history. Distinguish a reply to the requester from an internal note.",
          "Write the reply and use Send reply, or mark Internal note if the requester must not see it.",
          "Change status or priority only as appropriate. Refresh the history and review the ticket if there was an error before retrying; the reply may have been sent."
        ],
        "limit": "These instructions were reviewed against the panel. If an option is not shown or the server denies it, do not change the URL or scope; ask support. An error does not confirm the operation was not saved or sent: refresh and review the list, history or values before retrying to avoid duplicates."
      },
      "pt": {
        "title": "Revisar e responder tickets de suporte",
        "requirements": [
          "Sessão válida com papel super_admin confirmado pelo servidor."
        ],
        "steps": [
          "Abra /admin/soporte.",
          "Filtre por estado se necessário e selecione um ticket.",
          "Revise o histórico. Diferencie uma resposta ao solicitante de uma nota interna.",
          "Escreva a resposta e use Enviar respuesta, ou marque Nota interna se o solicitante não deve vê-la.",
          "Altere estado ou prioridade apenas quando corresponder. Atualize o histórico e revise o ticket se houve erro antes de tentar novamente; a resposta pode ter sido enviada."
        ],
        "limit": "Estas instruções foram revisadas no painel. Se uma opção não aparecer ou o servidor negar, não altere a URL nem o escopo; consulte o suporte. Tradução PT não verificada na interface. Um erro não confirma que a operação não foi guardada ou enviada: atualize e revise a lista, histórico ou valores antes de tentar novamente para evitar duplicados."
      }
    }
  }
];
