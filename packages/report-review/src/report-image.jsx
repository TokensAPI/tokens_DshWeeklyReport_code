import React from 'react';
import { DEMO_CHART_URL, DEMO_CHART_DATA } from './demo-content.mjs';

// Arbitrary report URLs never become automatic tracking/image requests.
// Asset URLs need the Host's asset transport; the built-in sample is available offline.
export function ReportImage({ url, caption, readOnly, onChange }) {
  return <figure className="rr-editable-image" contentEditable={false}>
    {url === DEMO_CHART_URL ? <img src={DEMO_CHART_DATA} alt={caption || '模拟库存示意图'} /> : <div className="rr-image-placeholder">{caption || '图片'} · 此地址暂不支持正文预览，可在 PDF 中核对资产。</div>}
    <label>图片说明 <input aria-label="图片说明" disabled={readOnly} value={caption || ''} onChange={e => onChange({ caption: e.target.value })} /></label>
    <label>图片地址 <input aria-label="图片地址" disabled={readOnly} value={url || ''} placeholder={DEMO_CHART_URL} onChange={e => onChange({ url: e.target.value })} /></label>
  </figure>;
}

export function imageMarkdown(url, caption, title = '') {
  const escape = value => String(value || '').replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&').replace(/\r?\n/g, ' ');
  const destination = String(url || '').replace(/\r?\n/g, '').replace(/[<> ]/g, c => encodeURIComponent(c));
  return `![${escape(caption)}](<${destination}>${title ? ' "' + String(title).replace(/["\\]/g, '\\$&').replace(/\r?\n/g, ' ') + '"' : ''})`;
}
