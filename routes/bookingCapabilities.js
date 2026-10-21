// Versioned public contract for clients which require exact price confirmation.
export function mountBookingCapabilities(app) {
  app.get('/api/reservas/price-capabilities', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ strict_price_confirmation: true, version: 2 });
  });
}
