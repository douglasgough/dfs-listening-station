/* Subscribe to a store for a chosen set of ids. Pure (no DOM). */

/** ids: array, Set, or predicate (id) => boolean. Calls fn(id, value) for matching ids only; returns unsubscribe. */
export function onParams(store, ids, fn) {
  const match = typeof ids === 'function' ? ids : (set => id => set.has(id))(new Set(ids));
  return store.subscribe((id, value) => { if (match(id)) fn(id, value); });
}
