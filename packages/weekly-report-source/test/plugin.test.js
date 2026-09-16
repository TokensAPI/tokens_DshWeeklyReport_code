import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { apply, WeeklyReportSource } from '../lib/plugin.js';

test('formal plugin imports dependency-free, provides service and disposes', async () => {
  const provided = new Map();
  const disposers = [];
  const ctx = {
    provide(name, value) { provided.set(name, value); },
    effect(fn) { disposers.push(fn()); },
  };
  assert.equal(plugin.apply, apply);
  apply(ctx, { outputRoot: '/not-used' });
  const source = provided.get('weeklyReportSource');
  assert.ok(source instanceof WeeklyReportSource);
  assert.equal(source.options.outputRoot, '/not-used');
  assert.equal(source.controller.signal.aborted, false);
  disposers.forEach(fn => fn());
  assert.equal(source.controller.signal.aborted, true);
  await assert.rejects(source.generate({ variety: '锡' }), /disposed/);
});
