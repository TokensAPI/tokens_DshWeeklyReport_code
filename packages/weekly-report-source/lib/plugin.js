import { generate } from './generate.js';

/** Host service object without a second Cordis runtime dependency. */
export class WeeklyReportSource {
  constructor(config = {}) {
    this.controller = new AbortController();
    this.options = Object.freeze({
      signal: this.controller.signal,
      outputRoot: config.outputRoot, python: config.python,
      baseUrl: config.baseUrl, timeoutMs: config.timeoutMs,
    });
  }
  generate(input) {
    if (this.controller.signal.aborted) return Promise.reject(new Error('weeklyReportSource disposed'));
    return generate(input, this.options);
  }
  dispose() { this.controller.abort(); }
}
export const name = 'weekly-report-source';
export function apply(ctx, config = {}) {
  const source = new WeeklyReportSource(config);
  ctx.provide('weeklyReportSource', source);
  ctx.effect(() => () => source.dispose());
}
export default { name, apply };
