const inputLabels = {
  classes: ['alumnos por clase', 'USD por alumno y clase', 'clases por mes'],
  tournaments: ['parejas por torneo', 'USD por inscripción de pareja', 'torneos por mes'],
  leagues: ['parejas', 'USD por cuota mensual de pareja'],
  buffet: ['clientes por día', 'USD por consumo medio', 'días por mes'],
};
const clean = value => String(value ?? '').replace(/[<>\r\n]/g, ' ').slice(0, 160);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;

/** Private CRM note pages. No delivery or notification side effects. */
export function simulationDetailNotes(value) {
  if (value?.type !== 'business-v2' || value.complementaryMode !== 'monthly') return [];
  const currency = ['USD','EUR','ARS','MXN','CLP'].includes(value.currency) ? value.currency : 'USD';
  const money = amount => numeric(amount) ? `${currency} ${amount.toLocaleString('es-AR', {maximumFractionDigits:2})}` : 'No informado';
  const rows = [
    'DETALLE DE SIMULACIÓN · datos declarados; revisión comercial interna.',
    `Presupuesto: ${money(value.budget)}. Canchas: ${clean(value.courts)}. Referencia por cancha: ${money(value.referencePerCourt)}.`,
    `Espacio existente: ${value.existingFacilities ? 'Sí' : 'No'}. Días de reservas al mes: ${clean(value.openDays)}. Horas reservadas por cancha/día: ${clean(value.openHours)}.`,
    ...(value.complements || []).slice(0,12).map(item => `Inversión · ${clean(item.label)}: ${money(item.budget)}${item.pending ? ' · pendiente de confirmar' : ''}.`),
    ...(value.activities || []).slice(0,30).map(item => `Reservas · ${clean(item.label)}: ${clean(item.hours)} h por cancha/día, ${clean(item.days)} días/mes, ${money(item.rate)}/hora (${clean(item.start)}–${clean(item.end)}).`),
  ];
  for (const item of (value.simpleMonthlyRevenues || []).slice(0,9)) {
    let detail = '';
    const labels = inputLabels[item.key];
    if (labels && Array.isArray(item.inputs) && item.inputs.length === labels.length && item.inputs.every(numeric)) {
      const product = item.inputs.reduce((total, n) => total*n, 1);
      if (Math.abs(product-item.amount)>0.01) throw new Error('SIMULATION_INPUT_MISMATCH');
      detail = ' · ' + item.inputs.map((n,i)=>`${n} ${labels[i]}`).join(' × ') + (item.example === true ? ' · ejemplo hipotético' : ' · valores ajustados por el visitante');
    }
    rows.push(`Ingreso · ${clean(item.label || item.key)}: ${money(item.amount)}/mes${detail}.`);
  }
  rows.push(`Gastos operativos mensuales informados (con mantenimiento publicitario cuando esté seleccionado): ${money(value.monthlyOperatingCosts)}.`);
  if (value.advertisingMaintenanceEnabled === true) rows.push('Publicidad de mantenimiento seleccionada: USD 250/mes desde el mes 4; ya incluida en los gastos informados cuando se conocen. Campaña inicial: USD 1.500 incluida desde 2 canchas, sin duplicarla en la inversión.');
  if (numeric(value.balanceScenarioHours) && value.balanceScenarioHours <= 16) rows.push(`Escenario de equilibrio explorado: ${value.balanceScenarioHours} horas de reservas por cancha al día; mantiene los otros ingresos y gastos declarados.`);
  if (value.operatingCostsSource === 'example') rows.push('Gastos del ejemplo didáctico: cifras hipotéticas, no costos reales declarados ni un presupuesto de Padbol.');
  rows.push('Los ingresos son facturación bruta; la simulación no es una oferta ni una garantía de resultados.');
  const notes = []; let page = '';
  for (const row of rows) {
    if ((page+'\n'+row).length>1800) { notes.push(page); page='DETALLE DE SIMULACIÓN · continuación.'; }
    page += (page ? '\n' : '')+row;
  }
  if (page) notes.push(page);
  return notes;
}
