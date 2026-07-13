const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function parsePadcoinsPagination(query = {}, {
  defaultLimit = DEFAULT_LIMIT,
  maxLimit = MAX_LIMIT,
} = {}) {
  const limitRaw = Number.parseInt(String(query.limit ?? ''), 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, maxLimit)
    : defaultLimit;

  const offsetRaw = Number.parseInt(String(query.offset ?? ''), 10);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  return { limit, offset };
}

export function buildPaginatedPayload(items, { limit, offset, total }, itemsKey) {
  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : (items?.length ?? 0);
  const hasMore = offset + (items?.length ?? 0) < safeTotal;
  const paginacion = {
    limit,
    offset,
    total: safeTotal,
    has_more: hasMore,
  };

  return {
    [itemsKey]: items,
    paginacion,
    total: safeTotal,
    limit,
    offset,
    has_more: hasMore,
  };
}
