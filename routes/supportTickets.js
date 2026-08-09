import { requireAuthenticatedUser, requireSuperAdminUser, resolveAuthRoleForUser } from '../lib/authAccess.js';

const STATUS = new Set(['abierto', 'en_revision', 'esperando_usuario', 'resuelto', 'cerrado']);
const PRIORITY = new Set(['baja', 'normal', 'alta', 'urgente']);
const CATEGORY = new Set(['reservas', 'pagos', 'torneos', 'cuenta', 'configuracion', 'tecnico', 'otro']);
const clean = (value, max = 5000) => String(value || '').trim().slice(0, max);

async function getTicketForRequester(supabaseAdmin, ticketId, userId) {
  const { data, error } = await supabaseAdmin
    .from('support_tickets')
    .select('*')
    .eq('id', ticketId)
    .eq('requester_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function touchTicket(supabaseAdmin, ticketId, changes = {}) {
  const { error } = await supabaseAdmin
    .from('support_tickets')
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq('id', ticketId);
  if (error) throw error;
}

export function mountSupportTicketsRoutes(app, { supabaseAdmin, getAuthenticatedUser, fetchUserRoleRowForAuthUser, legacySuperAdminEmails = [] }) {
  const deps = { getAuthenticatedUser, fetchUserRoleRowForAuthUser, legacySuperAdminEmails };

  app.post('/api/support/tickets', async (req, res) => {
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser); if (!user) return;
      const asunto = clean(req.body?.asunto, 160), body = clean(req.body?.mensaje);
      const categoria = clean(req.body?.categoria, 40);
      if (asunto.length < 4 || body.length < 1 || !CATEGORY.has(categoria)) return res.status(400).json({ error: 'Completá categoría, asunto y detalle del caso' });
      const role = await resolveAuthRoleForUser(user, deps);
      const requester_role = role.rol === 'admin_club' ? 'sede' : 'jugador';
      const { data: ticket, error } = await supabaseAdmin.from('support_tickets').insert({ requester_user_id: user.id, requester_email: user.email || null, requester_role, sede_id: requester_role === 'sede' ? role.sede_id : null, categoria, asunto }).select().single();
      if (error) throw error;
      const { error: messageError } = await supabaseAdmin.from('support_ticket_messages').insert({ ticket_id: ticket.id, author_user_id: user.id, author_role: requester_role, body });
      if (messageError) throw messageError;
      return res.status(201).json(ticket);
    } catch (error) { console.error('POST /api/support/tickets', error.message); return res.status(500).json({ error: 'No se pudo abrir el ticket' }); }
  });

  app.get('/api/support/tickets', async (req, res) => {
    try { const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser); if (!user) return;
      const { data, error } = await supabaseAdmin.from('support_tickets').select('*').eq('requester_user_id', user.id).order('updated_at', { ascending: false }); if (error) throw error; return res.json(data || []);
    } catch (error) { return res.status(500).json({ error: 'No se pudieron cargar los tickets' }); }
  });

  app.get('/api/support/tickets/:id', async (req, res) => {
    try { const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser); if (!user) return; const id = Number(req.params.id);
      const { data: ticket, error } = await supabaseAdmin.from('support_tickets').select('*').eq('id', id).eq('requester_user_id', user.id).maybeSingle(); if (error) throw error; if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
      const { data: messages, error: msgError } = await supabaseAdmin.from('support_ticket_messages').select('*').eq('ticket_id', id).eq('internal', false).order('created_at'); if (msgError) throw msgError; return res.json({ ...ticket, messages: messages || [] });
    } catch (error) { return res.status(500).json({ error: 'No se pudo cargar el ticket' }); }
  });

  app.post('/api/support/tickets/:id/messages', async (req, res) => {
    try {
      const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser); if (!user) return;
      const id = Number(req.params.id), body = clean(req.body?.mensaje);
      if (!Number.isInteger(id) || id < 1 || body.length < 1) return res.status(400).json({ error: 'Escribí un mensaje para continuar el caso' });
      const ticket = await getTicketForRequester(supabaseAdmin, id, user.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
      if (ticket.estado === 'cerrado') return res.status(409).json({ error: 'Este ticket ya está cerrado' });
      const author_role = ticket.requester_role === 'sede' ? 'sede' : 'jugador';
      const { data: message, error } = await supabaseAdmin.from('support_ticket_messages')
        .insert({ ticket_id: id, author_user_id: user.id, author_role, body })
        .select().single();
      if (error) throw error;
      await touchTicket(supabaseAdmin, id, { estado: 'en_revision', closed_at: null });
      return res.status(201).json(message);
    } catch (error) { console.error('POST /api/support/tickets/:id/messages', error.message); return res.status(500).json({ error: 'No se pudo enviar el mensaje' }); }
  });

  app.get('/api/admin/support/tickets', async (req, res) => {
    try { const auth = await requireSuperAdminUser(req, res, deps); if (!auth) return; let q = supabaseAdmin.from('support_tickets').select('*').order('updated_at', { ascending: false }); if (STATUS.has(clean(req.query.estado, 40))) q = q.eq('estado', req.query.estado); const { data, error } = await q; if (error) throw error; return res.json(data || []);
    } catch (error) { return res.status(500).json({ error: 'No se pudo cargar la bandeja de soporte' }); }
  });

  app.get('/api/admin/support/tickets/:id', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, deps); if (!auth) return;
      const id = Number(req.params.id);
      const { data: ticket, error } = await supabaseAdmin.from('support_tickets').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
      const { data: messages, error: msgError } = await supabaseAdmin.from('support_ticket_messages').select('*').eq('ticket_id', id).order('created_at');
      if (msgError) throw msgError;
      return res.json({ ...ticket, messages: messages || [] });
    } catch (error) { return res.status(500).json({ error: 'No se pudo cargar el ticket' }); }
  });

  app.post('/api/admin/support/tickets/:id/messages', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, deps); if (!auth) return;
      const id = Number(req.params.id), body = clean(req.body?.mensaje);
      const internal = Boolean(req.body?.internal);
      if (!Number.isInteger(id) || id < 1 || body.length < 1) return res.status(400).json({ error: 'Escribí una respuesta para continuar el caso' });
      const { data: ticket, error: ticketError } = await supabaseAdmin.from('support_tickets').select('id, estado').eq('id', id).maybeSingle();
      if (ticketError) throw ticketError;
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
      const { data: message, error } = await supabaseAdmin.from('support_ticket_messages')
        .insert({ ticket_id: id, author_user_id: auth.user.id, author_role: 'soporte', body, internal })
        .select().single();
      if (error) throw error;
      await touchTicket(supabaseAdmin, id, { estado: internal ? ticket.estado : 'esperando_usuario' });
      return res.status(201).json(message);
    } catch (error) { console.error('POST /api/admin/support/tickets/:id/messages', error.message); return res.status(500).json({ error: 'No se pudo enviar la respuesta' }); }
  });

  app.patch('/api/admin/support/tickets/:id', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, deps); if (!auth) return;
      const id = Number(req.params.id), estado = clean(req.body?.estado, 40), prioridad = clean(req.body?.prioridad, 40);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Ticket inválido' });
      const changes = {};
      if (estado) { if (!STATUS.has(estado)) return res.status(400).json({ error: 'Estado inválido' }); changes.estado = estado; changes.closed_at = estado === 'cerrado' ? new Date().toISOString() : null; }
      if (prioridad) { if (!PRIORITY.has(prioridad)) return res.status(400).json({ error: 'Prioridad inválida' }); changes.prioridad = prioridad; }
      if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Indicá un cambio para el ticket' });
      const { data, error } = await supabaseAdmin.from('support_tickets').update({ ...changes, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Ticket no encontrado' });
      return res.json(data);
    } catch (error) { console.error('PATCH /api/admin/support/tickets/:id', error.message); return res.status(500).json({ error: 'No se pudo actualizar el ticket' }); }
  });
}
