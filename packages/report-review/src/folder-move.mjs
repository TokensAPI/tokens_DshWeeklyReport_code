// Standalone, pure WeKnora folder-placement module.
//
// Kept separate from the publish flow so future changes (better grouping, idempotent re-move, reconcile,
// tenant-specific roots) live in this one file and never risk breaking the core publish path. All functions
// here are fail-soft: they return structured results / warnings and never throw into the caller.
import { deriveVariety } from '../../report-core/src/index.mjs';

export const DEFAULT_COMMODITY_GROUPS = {
  '锡': '有色/锡铝氧化铝锌',
  '铝': '有色/锡铝氧化铝锌',
  '氧化铝': '有色/锡铝氧化铝锌',
  '锌': '有色/锡铝氧化铝锌',
  '碳酸锂': '有色/碳酸锂',
};

// Sub-folders inside a report's folder, so a report's artifacts (正文/资产/人工修改) stay isolated and retrievable
// without piling everything into one flat folder. Kept here so the layout is owned by this module, not the publisher.
export const SUBDIR = { asset: '资产', human: '人工修改' };

// A safe single folder-path segment (no traversal, no control chars, no glob). Allows `/` as an internal
// separator so a group like `有色/锡铝氧化铝锌` is one segment, but rejects `a/../b` / leading `..`.
const segOK = value => typeof value === 'string' && value.length >= 1 && value.length <= 128
  && /^[A-Za-z0-9_\u4e00-\u9fa5\-\/]+$/.test(value) && !/(^|\/)\.\.?($|\/)/.test(value) && !/[\x00-\x1f]/.test(value);

/**
 * Resolve the target folder for one report from its (persisted) variety. Produces a PER-REPORT folder so every
 * report's artifacts (a single evolving knowledge + assets + human entries) live in one isolated branch of the
 * tree instead of sharing a folder with many reports:
 *   grouped   → `${root}/${group}/${reportType}/${reportKey}`
 *   ungrouped → `${root}/未分类/${reportType}/${reportKey}`
 * @param {{variety?:string, title?:string, groupMap?:object, folderRoot?:string, reportType?:string, reportKey?:string}} input
 * @returns {{variety:string, group?:string, reportKey:?string, folderPath:?string, invalidGroup:boolean, ungrouped:boolean, reason:'ok'|'invalid_group'|'ungrouped'}}
 *   - invalidGroup: the variety mapped to a group value that is not a safe path segment → no placement.
 *   - ungrouped: the variety has no group mapping → fall back to `${root}/未分类/${reportType}`.
 */
export function resolveFolderPath({ variety, title, groupMap, folderRoot = '商品策略', reportType = '周报', reportKey } = {}) {
  const v = (typeof variety === 'string' && variety.trim()) ? variety.trim() : deriveVariety(title || '');
  const map = (groupMap && typeof groupMap === 'object' && !Array.isArray(groupMap)) ? groupMap : DEFAULT_COMMODITY_GROUPS;
  const root = segOK(folderRoot) ? folderRoot : '商品策略';
  const type = segOK(reportType) ? reportType : '周报';
  const key = (typeof reportKey === 'string' && reportKey && segOK(reportKey)) ? reportKey : null;
  const withKey = base => key ? `${base}/${key}` : base;
  const group = map[v];
  if (group !== undefined && !segOK(group)) return { variety: v, group, reportKey: key, folderPath: null, invalidGroup: true, ungrouped: false, reason: 'invalid_group' };
  if (group === undefined) return { variety: v, group: undefined, reportKey: key, folderPath: withKey(`${root}/未分类/${type}`), invalidGroup: false, ungrouped: true, reason: 'ungrouped' };
  return { variety: v, group, reportKey: key, folderPath: withKey(`${root}/${group}/${type}`), invalidGroup: false, ungrouped: false, reason: 'ok' };
}

/**
 * Move `ids` into `folderPath` with a single connector.moveToFolder call, then validate the moved count.
 * Fail-soft: never throws; a move failure is returned as warnings so the core publish stays intact.
 * @returns {{ok:boolean, movedCount:number, expected:number, warnings:string[]}}
 */
export async function moveArtifacts({ connector, kbId, ids, folderPath }) {
  const expected = Array.isArray(ids) ? ids.length : 0;
  if (!expected) return { ok: true, movedCount: 0, expected: 0, warnings: [] };
  if (!folderPath) return { ok: false, movedCount: 0, expected, warnings: [] };
  if (typeof connector?.moveToFolder !== 'function') return { ok: false, movedCount: 0, expected, warnings: ['moveToFolder 不可用，已跳过文件夹放置。'] };

  let mv;
  try { mv = await connector.moveToFolder(kbId, ids, folderPath); }
  catch (error) { return { ok: false, movedCount: 0, expected, warnings: [`放入文件夹失败：${(error && error.code) || 'folder_move_failed'}；已上传条目暂留知识库根目录，请只读核对后处理。`] }; }

  const succeeded = mv?.ok === true;
  const movedCount = succeeded ? (typeof mv?.data?.moved_count === 'number' ? mv.data.moved_count : (typeof mv?.moved_count === 'number' ? mv.moved_count : expected)) : 0;
  const warnings = [];
  if (succeeded) {
    if (movedCount !== expected) warnings.push(`移动成功但数量不一致：期望 ${expected}，实际 ${movedCount}；请只读核对「${folderPath}」。`);
    else warnings.push(`已将 ${movedCount} 条已提交条目（md/图/pdf/human）放入「${folderPath}」。`);
  } else {
    warnings.push(`放入文件夹失败：${(mv && mv.error) || 'folder_move_failed'}；已上传条目暂留知识库根目录，请只读核对后处理。`);
  }
  return { ok: succeeded, movedCount, expected, warnings };
}
