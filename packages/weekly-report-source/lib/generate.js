import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../python/generate.py', import.meta.url));

/** Generate an unconfirmed MD-only draft. No core mutation, search, upload or bootstrap. */
export async function generate(input, options = {}) {
  if (!input || typeof input.variety !== 'string' || !input.variety.trim()) throw new TypeError('variety required');
  if (typeof options.outputRoot !== 'string' || !options.outputRoot) throw new TypeError('explicit outputRoot required');
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:5100';
  const u = new URL(baseUrl);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new TypeError('baseUrl must be a loopback HTTP origin');
  }
  for (const key of ['start', 'end']) {
    if (input[key] !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input[key]) || !Number.isFinite(Date.parse(input[key])))) throw new TypeError(`invalid ${key}`);
  }
  for (const key of ['charts', 'webSearchEnabled']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  if (input.period !== undefined && (typeof input.period !== 'string' || /[\r\n]/.test(input.period))) throw new TypeError('period must be single-line text');
  const materials = input.materials ?? [];
  if (!Array.isArray(materials)) throw new TypeError('materials must be an array');
  const cleanMaterials = materials.map(m => {
    if (!m || !['weknora', 'web'].includes(m.kind) || ['id', 'title', 'text'].some(k => typeof m[k] !== 'string' || !m[k])) throw new TypeError('invalid connector material');
    if (m.kind === 'web' && input.webSearchEnabled !== true) throw new TypeError('web material requires explicit opt-in');
    // Do not forward arbitrary connector objects, tokens, prompts or local notes.
    return Object.fromEntries(['id', 'kind', 'title', 'text', 'url', 'knowledgeId', 'versionId'].filter(k => typeof m[k] === 'string').map(k => [k, m[k]]));
  });
  const root = resolve(options.outputRoot);
  await mkdir(root, { recursive: true });
  const runDir = await mkdtemp(join(root, 'weekly-'));
  const req = { runDir, variety: input.variety, baseUrl: u.origin, materials: cleanMaterials,
    charts: input.charts ?? true, webSearchEnabled: input.webSearchEnabled ?? false };
  for (const key of ['start', 'end', 'period']) if (input[key] !== undefined) req[key] = input[key];
  // Optional LLM synthesis: only a bounded plain string crosses to the generator; never forwards
  // tokens, prompts, objects, or anything derived from connector config.
  if (input.synthesis !== undefined) {
    if (typeof input.synthesis !== 'string' || !input.synthesis.trim() || input.synthesis.length > 16000 || input.synthesis.includes('\0')) throw new TypeError('synthesis must be a non-empty bounded string (<=16000 chars)');
    req.synthesis = input.synthesis;
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  try {
    await new Promise((resolveRun, reject) => {
      const child = spawn(options.python ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-B', entry], {
        cwd: runDir, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
        env: { PATH: process.env.PATH, HOME: runDir, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1', MPLCONFIGDIR: join(runDir, 'cache', 'mpl'), MPLBACKEND: 'Agg' },
      });
      let stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.resume();
      child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4000); });
      child.stdin.on('error', () => {});
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && !expired) resolveRun();
        else reject(Object.assign(new Error(expired ? 'generation timed out' : `Python generation failed (exit ${code})`), { code: expired ? 'GENERATION_TIMEOUT' : 'GENERATION_FAILED', diagnostic: stderr }));
      });
      child.stdin.end(JSON.stringify(req));
    });
    return JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  } catch (error) {
    // Persist only a controlled code, not stderr that could contain upstream data.
    await writeFile(join(runDir, 'failure.json'), JSON.stringify({ code: error.code ?? 'GENERATION_FAILED' }));
    error.runDir = runDir;
    throw error;
  }
}
