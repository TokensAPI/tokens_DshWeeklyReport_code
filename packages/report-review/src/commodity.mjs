// commodity.mjs — per-commodity WeKnora placement mapping.
//
// The workbench's commodity selector is the single source of truth for a report's target location:
//   - `COMMODITY_LIST`            drives the client <select> (one known commodity per row).
//   - `DEFAULT_COMMODITY_FOLDERS` hardcodes the upload folder (relative to the KB root) per commodity.
//     A commodity missing here falls back to the group-based `resolveFolderPath` in folder-move.mjs.
//   - `kbIdFor(config, variety)` resolves the target knowledge base for a commodity: a per-commodity
//     override (`config.commodityKbIds[variety]`, editable in the workbench settings) wins, else the
//     global `config.publishKbId`. This lets different commodities publish to different KBs.
//
// "空间 id" is intentionally out of scope for now (connection id only): the connector works with
// knowledge-base id + folder path, so a commodity's "space" is expressed via its kbId + folderPath.

export const COMMODITY_LIST = ['锡', '铝', '氧化铝', '锌', '碳酸锂'];

// Hardcoded per-commodity upload folder, relative to the knowledge-base root. Add a row per known
// commodity; the example 锡 -> `根目录/周报` (a folder literally named 根目录, then 周报 inside).
export const DEFAULT_COMMODITY_FOLDERS = {
  '锡': '根目录/周报',
  // TODO(commodity): fill in others, e.g. '铝': '根目录/周报'
};

/**
 * Resolve the target knowledge-base id for a commodity.
 * @param {object} config  host config (publishKbId, commodityKbIds?)
 * @param {string} variety the report/request commodity
 * @returns {string|null}
 */
export function kbIdFor(config, variety) {
  const v = (typeof variety === 'string' && variety.trim()) ? variety.trim() : '';
  if (!config) return null;
  const perCommodity = config.commodityKbIds && config.commodityKbIds[v];
  return (typeof perCommodity === 'string' && perCommodity.trim()) ? perCommodity.trim() : (config.publishKbId || null);
}

/**
 * The commodity-profile folder override for a variety, or null when the commodity has no hardcoded
 * folder (caller then falls back to group-based `resolveFolderPath`).
 * @param {string} variety
 * @returns {string|null}
 */
export function commodityFolder(variety) {
  const v = (typeof variety === 'string' && variety.trim()) ? variety.trim() : '';
  return v && DEFAULT_COMMODITY_FOLDERS[v] ? DEFAULT_COMMODITY_FOLDERS[v] : null;
}

/**
 * The list of commodities exposed to the workbench (select options) + their hardcoded default folders
 * + currently configured per-commodity kbIds.
 * @param {object} config
 */
export function commodityProfilesView(config = {}) {
  const kbIds = { ...(config.commodityKbIds || {}) };
  return {
    list: COMMODITY_LIST.slice(),
    folders: { ...DEFAULT_COMMODITY_FOLDERS },
    kbIds,
  };
}

export default { COMMODITY_LIST, DEFAULT_COMMODITY_FOLDERS, kbIdFor, commodityFolder, commodityProfilesView };
