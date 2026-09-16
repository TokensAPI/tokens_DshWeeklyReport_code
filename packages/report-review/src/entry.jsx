import React from 'react';
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { apply as registerWorkspace } from './client.jsx';

function ReportIcon({ size }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="M3 1.75h6.5L13 5.25v9H3zM9 1.75v4h4M5.5 8h5M5.5 11h5" /></svg>;
}
export function ReportTrigger({ footer, wide, opened, onClick }) {
  const label = footer ? '周报工作台' : '生成周报';
  return <Tooltip label={label} delayMs={500} disabled={!footer || wide}>
    <Button variant="ghost" className={footer ? 'rr-footer-entry' : 'rr-header-entry'} data-wide={wide}
      aria-label={label} aria-haspopup="dialog" aria-expanded={opened} icon={<ReportIcon size={footer && !wide ? 18 : 16} />} onClick={onClick}>
      {!footer || wide ? label : null}
    </Button>
  </Tooltip>;
}
export const inject = ['slots'];
export function apply(ctx) {
  registerWorkspace(ctx, props => <ReportTrigger {...props} />);
}

export * from './client.jsx';
