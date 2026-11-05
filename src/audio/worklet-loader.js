/*
 * addModule once per (context, module URL). Browser-only at call time; importing it touches no globals.
 * A failed load is forgotten so a later call can retry.
 */
const loaded = new WeakMap(); // ctx -> Map(url string -> Promise<void>)

export function addModuleOnce(ctx, url) {
  let byUrl = loaded.get(ctx);
  if (!byUrl) { byUrl = new Map(); loaded.set(ctx, byUrl); }
  const key = String(url);
  let p = byUrl.get(key);
  if (!p) {
    p = ctx.audioWorklet.addModule(key);
    byUrl.set(key, p);
    p.catch(() => { if (byUrl.get(key) === p) byUrl.delete(key); });
  }
  return p;
}
