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
  generate(input, extra = {}) {
    if (this.controller.signal.aborted) return Promise.reject(new Error('weeklyReportSource disposed'));
    // Honor a per-call cancel signal (from the generate progress stream) while retaining the disposal signal.
    const options = extra?.signal
      ? { ...this.options, signal: (typeof AbortSignal?.any === 'function') ? AbortSignal.any([this.options.signal, extra.signal]) : extra.signal }
      : this.options;
    return generate(input, options);
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
