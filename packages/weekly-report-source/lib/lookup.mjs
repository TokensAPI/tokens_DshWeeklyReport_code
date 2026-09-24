// lookup.mjs — robust local (5100) data-reference resolver + fetcher.
//
// Purpose: give the weekly-report AI editor a *stable* way to resolve a user's
// natural-language mention of a metric to the unique data reference in the local
// source (runzhou.work mirror on 127.0.0.1:5100), and fetch its series. This is a
// Node.js implementation (cross-platform on macOS/Windows), reads the JSON catalog
// directly, and uses the same base URL / series contract as the Python generator.
//
// It deliberately does NOT depend on the Python generator (charts/PDF) — lookup is
// pure JSON + plain HTTP, so it needs no Python runtime.
//
// Matching is via normalized character-bigram overlap plus field (colon-separated)
// token hits, scaled by variety/category/unit agreement and a stable RZ_>RB_>TF_
// preference. It is designed to disambiguate the notoriously duplicated names in the
// catalog (当周值/累计值/同比/环比, RZ_/RB_ mirrors, unit variants).

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = join(HERE, '..', 'python', 'rzlib', 'catalog.json')

const DEFAULT_BASE = () =>
  process.env.RUNZHOU_BASE || 'http://127.0.0.1:5100'

let _catalog
async function loadCatalog() {
  if (_catalog) return _catalog
  _catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'))
  if (!Array.isArray(_catalog)) throw new Error('catalog.json is not an array')
  return _catalog
}

// ---- normalization ---------------------------------------------------------
const FULLWIDTH = { '：': ':', '（': '(', '）': ')', '，': ',', '、': ',', '％': '%', '－': '-', '｜': '|', '　': ' ' }
function norm(s) {
  if (!s) return ''
  let t = String(s)
  for (const [a, b] of Object.entries(FULLWIDTH)) t = t.split(a).join(b)
  return t.toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[()（）\[\]【】\/]/g, '')
}

// Fields = colon-separated segments of a catalog name (e.g. 铁矿石:发运量:巴西:当周值:万吨).
function fields(name) {
  return norm(name).split(':').map((f) => f).filter(Boolean)
}

function bigrams(s) {
  const a = []
  if (!s) return a
  for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2))
  return a
}

// Fraction of query bigrams present in the name (0..1).
function bigramOverlap(q, name) {
  const qb = bigrams(q)
  if (!qb.length) return 0
  const nb = new Set(bigrams(name))
  let h = 0
  for (const b of qb) if (nb.has(b)) h++
  return h / qb.length
}

const RHYTHM = ['当周', '累计', '同比', '环比', '当月', '日均', '月度']
function hasRhythm(name, q) {
  const n = norm(name)
  for (const r of RHYTHM) if (q.includes(r) && n.includes(r)) return true
  return false
}

// ---- scoring ---------------------------------------------------------------
function score(entry, q, opts) {
  const nameNorm = norm(entry.name || '')
  const id = String(entry.id || '')
  const flds = fields(entry.name)
  const exact = nameNorm.includes(q)

  let s = 0
  if (exact) s += 200
  // Bigram overlap (the main Chinese matcher); weighted highest so candidates that cover MORE of
  // the query (not just a short leading noun) win.
  const ov = bigramOverlap(q, nameNorm)
  s += ov * 170
  // Field-token hits: each catalog field that the query mentions adds confidence.
  let nhit = 0
  for (const f of flds) {
    if (f.length < 2) continue
    if (q.includes(f)) { s += 18; nhit++ }
    else if (f.includes(q) && q.length >= 2) { s += 10; nhit++ }
  }
  // Leading term (first segment before any ':'), i.e. the commodity/object the user names first.
  const lead = (q.split(':')[0] || q)
  if (lead.length >= 2) {
    for (const f of flds) { if (f.length >= 2 && lead.includes(f)) { s += 16; nhit++; break } }
    if (nameNorm.includes(lead.slice(0, 2))) s += 12
  }
  // Variety agreement: strongly prefer the report's commodity, but (unlike a hard filter) still
  // allow a strong name match from another variety so we don't miss e.g. a 螺纹/成材 series the
  // report actually references.
  if (opts.variety) s += (norm(entry.variety) === norm(opts.variety) ? 25 : -18)
  // Category / unit agreement with the query.
  if (norm(entry.cat) && q.includes(norm(entry.cat))) s += 6
  if (norm(entry.unit) && q.includes(norm(entry.unit))) s += 6
  // Stable dedup preference: RZ_ (canonical) > RB_ > TF_ (third-party derivative).
  if (/^RZ_/.test(id)) s += 6
  if (/^RB_/.test(id)) s -= 8
  if (/^TF_/.test(id)) s -= 12
  if (!/^(RZ_|RB_|TF_)/.test(id)) s += 2
  if (hasRhythm(nameNorm, q)) s += 5
  // Prefer concrete rows over "excluding / other / aggregate" rows unless the query names them.
  if (/其他|除.*外|剔除|以上|均值/.test(nameNorm) && !/其他|除.*外|剔除|均值/.test(q)) s -= 30

  // Reject weak/mismatched candidates. A candidate is only eligible when the query's leading term
  // (its first 2 chars) appears in the name, OR it is an exact/substring hit, OR the overlap is
  // very high. Prevents "铁水日均产量" matching an unrelated 煤炭 row, and stops garbage queries
  // grabbing an arbitrary RZ_ row.
  const lead2 = q.slice(0, 2)
  const leadHit = lead2.length === 2 && nameNorm.includes(lead2)
  if (!exact && !leadHit && ov < 0.7) return 0
  if (s < 40) return 0
  return s
}

/**
 * Resolve a query to candidate catalog entries (best first).
 * @param {string} query  user/AI mention, e.g. "巴西发运量" or "铁矿石：发运量：巴西"
 * @param {object} [opts]  { variety?, cat?, limit? }
 * @returns {{ matches, best, reason }}
 */
export async function resolveRef(query, opts = {}) {
  const cat = await loadCatalog()
  const q = norm(query)
  if (!q) return { matches: [], best: null, reason: 'empty-query' }

  let pool = cat
  // Note: `variety` is used as a strong scoring weight, never a hard filter. A hard filter would
  // drop e.g. a 螺纹/成材 series the report actually references when its variety is a broader
  // parent. If no entry exists under the requested variety, the whole catalog is still searched
  // and the weighting simply re-ranks same-variety rows first.

  const scored = pool
    .map((e) => ({ ref: e.id, name: e.name, variety: e.variety, sector: e.sector, cat: e.cat, unit: e.unit, score: score(e, q, opts) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)

  // Collapse near-duplicate names (e.g. RZ_/RB_ or unit variants of the same series): keep the
  // highest-scored candidate per normalized name, preferring the canonical prefix.
  const seen = new Set()
  const unique = []
  for (const c of scored) {
    const key = norm(c.name)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(c)
  }

  const limit = opts.limit ?? 8
  const matches = unique.slice(0, limit)
  const best = matches[0] ?? null
  const reason = best ? 'resolved' : (cat.length ? 'no-match' : 'no-catalog')
  return { matches, best, reason }
}

// ---- series fetch ----------------------------------------------------------
function fmtNum(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return null
  const f = Number(x)
  if (!Number.isFinite(f)) return null
  if (Math.abs(f) >= 1000) return Number(f.toFixed(0))
  if (Math.abs(f) >= 1) return Number(f.toFixed(2))
  return Number(f.toFixed(4))
}

async function fetchSeries(ref, baseUrl, windowMs) {
  const base = (baseUrl || DEFAULT_BASE()).replace(/\/+$/, '')
  const url = new URL(`/defs/${encodeURIComponent(ref)}/values`, base)
  if (windowMs) {
    const end = Date.now()
    url.searchParams.set('start', String(end - windowMs))
    url.searchParams.set('end', String(end))
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error(`5100 values ${res.status} for ${ref}`)
  const rows = await res.json()
  return (Array.isArray(rows) ? rows : []).map((it) => ({ t: Number(it.time), v: it.value })).filter((p) => Number.isFinite(p.t) && typeof p.v === 'number')
}

async function fetchDef(ref, baseUrl) {
  const base = (baseUrl || DEFAULT_BASE()).replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/defs/${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Resolve + fetch a metric mention, returning a report-ready structure.
 * @param {string} query
 * @param {object} [opts] { variety?, cat?, baseUrl?, windowMs?, withSeries? }
 */
export async function lookupData(query, opts = {}) {
  const { matches, best, reason } = await resolveRef(query, opts)
  if (!best) {
    return { ok: false, reason, query, candidates: matches.map((m) => ({ ref: m.ref, name: m.name, unit: m.unit, cat: m.cat })) }
  }
  const ref = best.ref
  let values = null
  if (opts.withSeries !== false) {
    try {
      const pts = await fetchSeries(ref, opts.baseUrl, opts.windowMs)
      if (pts.length >= 1) {
        const last = pts[pts.length - 1]
        const prev = pts.length >= 2 ? pts[pts.length - 2] : null
        const chgPct = prev && Number(prev.v) ? ((last.v / prev.v - 1) * 100) : null
        values = {
          latest: fmtNum(last.v),
          latestAt: new Date(last.t).toISOString(),
          prev: prev ? fmtNum(prev.v) : null,
          changePct: chgPct === null ? null : Number(chgPct.toFixed(2)),
          points: pts.slice(-Math.min(60, pts.length)).map((p) => ({ t: new Date(p.t).toISOString(), v: fmtNum(p.v) })),
        }
      }
    } catch {
      // fall through to the def's latestValue below
    }
  }
  if (!values) {
    const def = await fetchDef(ref, opts.baseUrl)
    if (def && (def.latestValue !== undefined || def.unit !== undefined)) {
      values = {
        latest: def.latestValue !== undefined ? fmtNum(def.latestValue) : null,
        latestAt: def.latestValueTime || null,
        prev: null, changePct: null, points: [],
      }
    }
  }
  return {
    ok: true,
    query,
    resolved: { ref, name: best.name, variety: best.variety, sector: best.sector, cat: best.cat, unit: best.unit },
    candidates: matches.slice(1).map((m) => ({ ref: m.ref, name: m.name, unit: m.unit, cat: m.cat })),
    values,
  }
}

export default { resolveRef, lookupData }
