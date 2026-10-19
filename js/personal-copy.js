/**
 * personal-copy.js — "Personal copy": one editable copy of a source Liveboard per user.
 *
 * Find, then (only on an explicit create) copy, over REST (Discovery.*). The copy is found by its OWN tag
 * `pcopy:<sourceId>` (not the Personalize strip's `src:`) AND its author — that search is the source of truth. localStorage (`tsp_lbcopy_v1`) only remembers which copy to prefer
 * when a search ever returns more than one; it is never trusted on its own. No server.js involvement.
 */
import * as Discovery from './discovery.js';
import { GUID_RE } from './custom-columns.js';

export const PC_KEY = 'tsp_lbcopy_v1';
export const pcCacheKey = (host, userId, sourceId) => `${host}|${userId}|${sourceId}`;
/** "<source name> — <username> (personal copy)" */
export const pcTitle = (sourceName, userName) => `${sourceName || 'Liveboard'} — ${userName || 'me'} (personal copy)`;

function readCache() {
  try { const o = JSON.parse(localStorage.getItem(PC_KEY) || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
  catch (_) { return {}; }
}
export function setCachedCopy(key, id) {
  const all = readCache();
  if (id) all[key] = id; else delete all[key];
  try { localStorage.setItem(PC_KEY, JSON.stringify(all)); } catch (_) { /* a fast path only */ }
}

const inflight = new Map(); // one find-or-create per key at a time within this tab (the cross-tab race remains)

/**
 * → { ok:true, id, title, created, extra } | { ok:true, none:true } | { ok:false, error }. `extra` = how many
 * additional copies the search returned (a duplicate-copy race); the lowest-sorting GUID wins unless the cache
 * names another. Nothing is created unless `create` is true (an explicit click); `exclude` = ids to ignore
 * (a just-deleted copy the search index may still list). The source id is GUID-gated and never its own copy.
 */
export function findOrCreateCopy(host, user, sourceId, sourceName, { create = false, exclude = [] } = {}) {
  if (!GUID_RE.test(sourceId)) return Promise.resolve({ ok: false, error: 'Pick a Liveboard (a valid GUID) first.' });
  const key = pcCacheKey(host, user.id, sourceId), ikey = key + (create ? '|c' : ''); // the cache key is shared by find and create
  if (!inflight.has(ikey)) { const p = run().finally(() => { if (inflight.get(ikey) === p) inflight.delete(ikey); }); inflight.set(ikey, p); }
  return inflight.get(ikey);

  async function run() {
    const tag = Discovery.pcopyTag(sourceId);
    const r = await Discovery.listPersonalCopies(host, sourceId, { userName: user.id, tag });
    if (!r.ok) return { ok: false, error: `Couldn’t look up your copy (${r.error})` };
    const skip = new Set([sourceId, ...exclude]);
    const mine = r.copies.filter((c) => (c.tags || []).includes(tag) && !skip.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (mine.length) {
      const hit = mine.find((c) => c.id === readCache()[key]) || mine[0];
      setCachedCopy(key, hit.id);
      return { ok: true, id: hit.id, title: hit.title, created: false, extra: mine.length - 1 };
    }
    if (!create) return { ok: true, none: true };
    const title = pcTitle(sourceName, user.name);
    const cp = await Discovery.copyLiveboard(host, sourceId, title);
    if (!cp.ok) {
      return { ok: false, error: cp.status === 403 ? 'This user may not copy the Liveboard (needs view access on the source plus create/edit rights).' : `Copy failed: ${cp.error}` };
    }
    const t = await Discovery.assignTags(host, cp.id, [tag]);
    if (!t.ok) {
      // An untagged copy could never be found again (the next visit would make another): remove it.
      await Discovery.deleteLiveboard(host, cp.id);
      return { ok: false, error: `Couldn’t tag the new copy (${t.error}); it was removed.` };
    }
    setCachedCopy(key, cp.id);
    return { ok: true, id: cp.id, title, created: true, extra: 0 };
  }
}

/** Delete the user's copy and forget it. The caller then runs findOrCreateCopy again. */
export async function deleteCopy(host, user, sourceId, copyId) {
  if (copyId === sourceId) return { ok: false, error: 'Refusing to delete the source Liveboard.' };
  const r = await Discovery.deleteLiveboard(host, copyId);
  if (r.ok) setCachedCopy(pcCacheKey(host, user.id, sourceId), null);
  return r;
}
