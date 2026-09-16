import { registerReviewTools } from './index.mjs';

// Opt-in Agent-preset plugin. Never mount this as a replacement for the Host service.
export const inject = ['tools', 'reportReview'];
export function apply(ctx) {
  // tools.register owns each registration through the scoped Cordis effect registry.
  registerReviewTools(ctx, ctx.reportReview);
}
export default { name: 'run19-report-review-tools', inject, apply };
