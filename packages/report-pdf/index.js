import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptPath = fileURLToPath(new URL('./renderer.py', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
export const RENDERER_VERSION = 'run19-pdf/0.2.0';

/** Host-only service. Paths/configuration MUST NOT be accepted from untrusted Client RPC. */
export class PdfRenderer {
  constructor({ cacheDir = path.join(os.homedir(), '.run19', 'pdf-cache'), assetRoots = [], pythonPath = process.env.RUN19_PYTHON || 'python3', fontPath = process.env.RUN19_FONT || '/System/Library/Fonts/STHeiti Medium.ttc', timeoutMs = 60000 } = {}) {
    this.cacheDir = path.resolve(cacheDir);
    this.assetRoots = assetRoots.map(p => path.resolve(p));
    this.pythonPath = pythonPath;
    this.fontPath = path.resolve(fontPath);
    this.timeoutMs = timeoutMs;
    this.tail = Promise.resolve();
    this.latest = new Map();
    this.children = new Set();
    this.closed = false;
  }

  async process(args) {
    if (this.closed) throw new Error('RENDERER_DISPOSED');
    return await new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      this.children.add(child);
      let output = '', error = '', overflow = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('RENDER_TIMEOUT')); }, this.timeoutMs);
      child.stdout.on('data', b => { output += b; if (output.length > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', b => { error += b; if (error.length > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
      child.on('error', () => { clearTimeout(timer); this.children.delete(child); reject(new Error('PYTHON_UNAVAILABLE')); });
      child.on('close', code => {
        clearTimeout(timer); this.children.delete(child);
        if (overflow) return reject(new Error('RENDER_OUTPUT_LIMIT'));
        if (code !== 0) return reject(new Error(['ANNOTATION_BLOCK_BOUNDARY_REQUIRED', 'ANNOTATION_NON_TEXT_BLOCK'].includes(error.trim()) ? error.trim() : 'PDF_RENDER_FAILED')); // allowlisted diagnostics only
        try { resolve(JSON.parse(output)); } catch { reject(new Error('INVALID_RENDER_RECEIPT')); }
      });
    });
  }

  render(input) {
    // Snapshot caller-owned JSON synchronously; do not retain mutable input references.
    let request;
    try {
      request = {
        reportId: input.reportId, markdown: input.markdown, saveToken: input.saveToken,
        templateVersion: input.templateVersion || 'plain-a4-v1',
        assets: (input.assets || []).map(a => ({ id: a.id, path: a.path, sha256: a.sha256 })),
        annotations: (input.annotations || []).filter(a => a.public === true).map(a => ({
          id: typeof a.id === 'string' ? a.id : '', source: a.source, target: { startLine: a.target?.startLine, endLine: a.target?.endLine, quote: a.target?.quote },
          displayName: a.displayName || '', completedAt: a.completedAt || ''
        })),
        cover: (typeof input.cover === 'object' && input.cover) ? {
          big_title: typeof input.cover.big_title === 'string' ? input.cover.big_title : '',
          sub_title: typeof input.cover.sub_title === 'string' ? input.cover.sub_title : '',
          date_line: typeof input.cover.date_line === 'string' ? input.cover.date_line : '',
          keywords: typeof input.cover.keywords === 'string' ? input.cover.keywords : '',
          header_text: typeof input.cover.header_text === 'string' ? input.cover.header_text : '',
          disclaimer: typeof input.cover.disclaimer === 'string' ? input.cover.disclaimer : ''
        } : null
      };
    } catch { return Promise.resolve({ status: 'failed', saveToken: input?.saveToken, digest: null, error: 'INVALID_REQUEST' }); }
    const ticket = randomUUID();
    const key = request.reportId;
    this.latest.set(key, ticket);
    const stale = () => this.closed || this.latest.get(key) !== ticket;
    const run = async () => {
      if (stale()) return { status: 'stale', saveToken: request.saveToken, digest: null };
      let digest = null, temp;
      try {
        if (typeof key !== 'string' || !key || typeof request.markdown !== 'string' || request.markdown.length > 2_000_000 || !['string', 'number'].includes(typeof request.saveToken)) throw new Error('INVALID_REQUEST');
        if (typeof request.templateVersion !== 'string') throw new Error('INVALID_TEMPLATE');
        const roots = await Promise.all(this.assetRoots.map(p => fs.realpath(p)));
        const assets = [];
        const ids = new Set();
        for (const asset of request.assets) {
          if (typeof asset.id !== 'string' || !/^[\w.-]+$/.test(asset.id) || ids.has(asset.id) || typeof asset.path !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('INVALID_ASSET');
          ids.add(asset.id);
          const real = await fs.realpath(asset.path).catch(() => { throw new Error('ASSET_MISSING'); });
          if (!roots.some(root => inside(root, real))) throw new Error('ASSET_OUTSIDE_WHITELIST');
          const stat = await fs.stat(real);
          if (!stat.isFile() || stat.size > 30_000_000) throw new Error('INVALID_ASSET_FILE');
          const bytes = await fs.readFile(real);
          if (hash(bytes) !== asset.sha256) throw new Error('ASSET_HASH_MISMATCH');
          // Only actual PNG/JPEG: no SVG scripts, file references or active content.
          const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
          const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
          if (!png && !jpeg) throw new Error('UNSUPPORTED_IMAGE_FORMAT');
          assets.push({ id: asset.id, sha256: asset.sha256, bytes, ext: png ? 'png' : 'jpg' });
        }
        assets.sort((a,b) => a.id.localeCompare(b.id));
        // Reject HTML and reference-style images rather than letting a parser read paths implicitly.
        if (/<\/?[a-z][^>]*>/i.test(request.markdown)) throw new Error('HTML_UNSUPPORTED');
        if (/!\[[^\]]*\]\s*\[/.test(request.markdown)) throw new Error('REFERENCE_IMAGE_UNSUPPORTED');
        const imageRe = /!\[([^\]]*)\]\(([^\s)]+)\)/g;
        let match, imageCount = 0;
        while ((match = imageRe.exec(request.markdown))) {
          imageCount++;
          const id = match[2].startsWith('asset:') ? match[2].slice(6) : match[2];
          if (!ids.has(id)) throw new Error('IMAGE_NOT_REGISTERED');
          const start = request.markdown.lastIndexOf('\n', match.index) + 1;
          const end = request.markdown.indexOf('\n', match.index);
          if (request.markdown.slice(start, end < 0 ? undefined : end).trim() !== match[0]) throw new Error('INLINE_IMAGE_UNSUPPORTED');
        }
        if ((request.markdown.match(/!\[/g) || []).length !== imageCount) throw new Error('IMAGE_SYNTAX_UNSUPPORTED');
        const lines = request.markdown.split('\n');
        for (const a of request.annotations) {
          const { startLine, endLine, quote } = a.target;
          if (!['user_direct','user_prompt'].includes(a.source) || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error('ANNOTATION_TARGET_INVALID');
          if (typeof quote !== 'string' || lines.slice(startLine - 1, endLine).join('\n') !== quote) throw new Error('ANNOTATION_QUOTE_MISMATCH');
          if (typeof a.displayName !== 'string' || typeof a.completedAt !== 'string') throw new Error('ANNOTATION_SOURCE_INVALID');
        }
        const font = await fs.readFile(this.fontPath).catch(() => { throw new Error('FONT_UNAVAILABLE'); });
        const script = await fs.readFile(scriptPath);
        const engine = await this.process(['--probe']);
        const content = { markdown: request.markdown, assets: assets.map(({ id, sha256 }) => ({ id, sha256 })), annotations: request.annotations, templateVersion: request.templateVersion, cover: request.cover, fontHash: hash(font), renderer: RENDERER_VERSION, scriptHash: hash(script), engine };
        digest = hash(JSON.stringify(content));
        const target = path.join(this.cacheDir, digest + '.pdf');
        const receiptPath = path.join(this.cacheDir, digest + '.json');
        await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        try {
          const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
          const bytes = await fs.readFile(target);
          if (receipt.pdfHash === hash(bytes) && bytes.subarray(0,5).toString() === '%PDF-' && receipt.pages > 0) {
            return { status: stale() ? 'stale' : 'ready', saveToken: request.saveToken, digest, ...(stale() ? {} : { pdfPath: target }), cached: true, pages: receipt.pages, imageCount: receipt.imageCount, markedBlocks: receipt.markedBlocks, warnings: receipt.warnings };
          }
        } catch { /* cache absence/corruption triggers real rendering */ }
        if (stale()) return { status: 'stale', saveToken: request.saveToken, digest };
        temp = await fs.mkdtemp(path.join(this.cacheDir, '.job-'));
        const staged = [];
        for (const a of assets) {
          const p = path.join(temp, a.sha256 + '.' + a.ext);
          await fs.writeFile(p, a.bytes, { mode: 0o600 });
          staged.push({ id: a.id, path: p });
        }
        const stagedFont = path.join(temp, 'font.ttc');
        await fs.writeFile(stagedFont, font);
        const output = path.join(temp, 'result.pdf');
        await fs.writeFile(path.join(temp, 'input.json'), JSON.stringify({ ...content, assets: staged, fontPath: stagedFont, output }), { mode: 0o600 });
        const receipt = await this.process([path.join(temp, 'input.json')]);
        const pdf = await fs.readFile(output);
        if (pdf.subarray(0,5).toString() !== '%PDF-' || !(receipt.pages > 0) || receipt.imageCount !== imageCount) throw new Error('INVALID_PDF_OUTPUT');
        await fs.rename(output, target);
        const receiptTemp = path.join(temp, 'receipt.json');
        await fs.writeFile(receiptTemp, JSON.stringify({ ...receipt, pdfHash: hash(pdf) }));
        await fs.rename(receiptTemp, receiptPath);
        return { status: stale() ? 'stale' : 'ready', saveToken: request.saveToken, digest, ...(stale() ? {} : { pdfPath: target }), cached: false, ...receipt };
      } catch (error) {
        const safe = /^(INVALID_|ASSET_|IMAGE_|INLINE_|HTML_|REFERENCE_|UNSUPPORTED_|ANNOTATION_|FONT_|PYTHON_|PDF_|RENDER_|RENDERER_)[A-Z_]+$/.test(error.message) ? error.message : 'PDF_RENDER_FAILED';
        return { status: stale() ? 'stale' : 'failed', saveToken: request.saveToken, digest, error: safe };
      } finally { if (temp) await fs.rm(temp, { recursive: true, force: true }); }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }

  dispose() { this.closed = true; this.latest.clear(); for (const child of this.children) child.kill('SIGKILL'); }
}

export const name = 'report-pdf';
export function apply(ctx, config = {}) {
  const renderer = new PdfRenderer(config);
  ctx.provide('reportPdf', renderer);
  ctx.effect(() => () => renderer.dispose());
}
export default { name, apply };
