// Server-only corpus. Never import into a public frontend or export bundle.
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
    "translations": {
      "es": {
        "title": "Reconocer el panel correspondiente a tu rol",
        "requirements": [
          "Sesión válida y rol administrativo asignado por el servidor."
        ],
        "steps": [
          "Abre el panel /admin.",
          "Consulta las secciones disponibles para tu rol. Si una sección no aparece o el servidor deniega el acceso, no cambies parámetros para forzarla."
        ],
        "limit": "La visibilidad de una pestaña no concede permiso. No se verificaron operaciones administrativas en runtime."
      },
      "en": {
        "title": "Identify the panel for your role",
        "requirements": [
          "A valid session and an administrative role assigned by the server."
        ],
        "steps": [
          "Open the /admin panel.",
          "Review the sections available for your role. If a section is absent or the server denies access, do not change parameters to force it."
        ],
        "limit": "A visible tab does not grant permission. Administrative operations have not been verified at runtime."
      }
    },
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "bdad0c70329ace73f19c7309337826e8051c5e51",
      "backend": "dcb34ab7426cc00826dda0fcd7c77d2171f1d953"
    }
  },
  {
    "id": "admin-support-manage-tickets",
    "module": "soporte",
    "slug": "gestionar-tickets",
    "allowedRoles": [
      "super_admin"
    ],
    "translations": {
      "es": {
        "title": "Revisar y responder tickets de soporte",
        "requirements": [
          "Sesión válida con rol super_admin confirmado por servidor.",
          "Usa casos ficticios en QA para verificar esta guía."
        ],
        "steps": [
          "Abre /admin/soporte y filtra por estado si corresponde.",
          "Selecciona un ticket para revisar su historial.",
          "Distingue una respuesta al solicitante de una nota interna antes de enviar.",
          "Cambia estado o prioridad solo cuando corresponda al caso."
        ],
        "limit": "Pasos acreditados por código, sin envío ni recorrido runtime verificado. No se acredita asignación personal ni plazo de respuesta."
      },
      "en": {
        "title": "Review and reply to support tickets",
        "requirements": [
          "A valid session with the super_admin role confirmed by the server.",
          "Use fictional QA cases to verify this guide."
        ],
        "steps": [
          "Open /admin/soporte and filter by status if needed.",
          "Select a ticket to review its history.",
          "Distinguish a reply to the requester from an internal note before sending.",
          "Change status or priority only as appropriate for the case."
        ],
        "limit": "Steps supported by source code, without sending or a verified runtime walkthrough. Personal assignment and response times are not established."
      }
    },
    "status": "reviewed",
    "verification": "source-reviewed",
    "sourceVersion": {
      "frontend": "bdad0c70329ace73f19c7309337826e8051c5e51",
      "backend": "dcb34ab7426cc00826dda0fcd7c77d2171f1d953"
    }
  }
];
