#!/usr/bin/env python3
"""MD-only 0.1.5 adapter. stdin JSON -> stdout manifest JSON; no bootstrap/PDF/KB client."""
import sys
sys.dont_write_bytecode = True
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path


# Metadata / boilerplate lines that belong to a stored report's header or footer,
# not to the quoted body. Strip them so excerpts carry only the substantive prose.
_META_PATTERNS = [
    # Stored-report header/footer boilerplate (e.g. `> **数据口径：...**`).
    r'^\s*>?\s*\*\*(核心快照|行情性质|数据口径|数据口径备注|联网分析|核心结论|结构提示|行情快照)([：:]|\*\*)',
    r'^\s*>?\s*\*\*(内部参考|仅供投研使用)\s*\*?\s*$',
    r'^\s*>?\s*\*\*基于本地 API\*\*',
    r'^\s*>?\s*\*\*润洲投研\s*[·．|]?',
    r'^\s*>?\s*数据平台：',
]
_DISCLAIMER_WORDS = ('仅供投研', '不构成投资建议', '内部参考', '数据完整性提示')


def _clean_material(text):
    lines = []
    for line in (text or '').split('\n'):
        s = line.strip()
        if any(re.search(p, line) for p in _META_PATTERNS):
            continue
        if any(w in s for w in _DISCLAIMER_WORDS):
            continue
        lines.append(line)
    return '\n'.join(lines).strip()


def _data_summary(variant, data):
    """Compact current-snapshot text so the model can reason over live numbers. """
    from rzlib.reports import snapshot_rows
    lines = []
    bench = variant.get('benchmarks') or []
    bench_refs = []
    for b in bench:
        for r in b.get('refs', []):
            if r not in [x[0] for x in bench_refs]:
                bench_refs.append((r, b['label']))
    if bench_refs:
        _, bits = snapshot_rows(data, bench_refs)
        if bits:
            lines.append('行情快照：' + bits)
    for group_name, group_refs in variant.get('evidence', []):
        rows, _ = snapshot_rows(data, group_refs)
        if rows:
            lines.append(group_name + '：' + '；'.join(f'{l} {latest}（{chg}）' for l, latest, _prev, chg in rows))
    return '\n'.join(lines)


def generate(req):
    from urllib.parse import urlsplit
    base_check = urlsplit(req.get('baseUrl', 'http://127.0.0.1:5100'))
    if base_check.scheme != 'http' or base_check.hostname not in ('localhost', '127.0.0.1', '::1') or base_check.username or base_check.password or base_check.path not in ('', '/') or base_check.query or base_check.fragment:
        raise ValueError('baseUrl must be a loopback HTTP origin')
    materials_check = req.get('materials', [])
    if not isinstance(materials_check, list):
        raise ValueError('materials must be an array')
    for m in materials_check:
        if not isinstance(m, dict) or m.get('kind') not in ('weknora', 'web') or not all(isinstance(m.get(k), str) and m[k] for k in ('id', 'title', 'text')):
            raise ValueError('invalid connector material')
        if m['kind'] == 'web' and req.get('webSearchEnabled', False) is not True:
            raise ValueError('web material requires explicit opt-in')
    root = Path(req['runDir']).resolve()
    # Exclusive claim also protects standalone Python calls against overwrite.
    with (root / '.claimed').open('x'):
        pass
    os.environ['RUNZHOU_CACHE'] = str(root / 'cache')
    os.environ['MPLCONFIGDIR'] = str(root / 'cache' / 'mpl')
    os.environ['MPLBACKEND'] = 'Agg'
    from rzlib import variants, reports, runzhou_api as api
    base = req.get('baseUrl', 'http://127.0.0.1:5100')
    api.configure(base=base)
    end = req.get('end') or dt.datetime.now(dt.timezone.utc).date().isoformat()
    end_date = dt.date.fromisoformat(end)
    start = req.get('start') or (end_date - dt.timedelta(days=800)).isoformat()
    if dt.date.fromisoformat(start) > end_date:
        raise ValueError('start must not exceed end')
    variant = variants.get_variant(req['variety'])
    refs = []
    def add(items):
        for item in items:
            if item and item not in refs:
                refs.append(item)
    for bench in variant.get('benchmarks', []):
        add(bench.get('refs', []))
    for fig in variant.get('figures', []):
        for panel in fig.get('panels', [fig]):
            add([s['ref'] for s in panel.get('series', [])])
            if panel.get('spread'):
                add([panel['spread']['a'], panel['spread']['b']])
    for _, rows in variant.get('evidence', []):
        add([ref for ref, _ in rows])
    data, series, warnings = {}, [], []
    for ref in refs:
        try:
            points = sorted(api.pull_series(ref, start, end))
            data[ref] = points
            status = 'ok' if points else 'empty'
        except Exception as exc:
            # Avoid logging remote bodies or injected material text.
            points, data[ref], status = [], [], 'failed'
            warnings.append({'code': 'SERIES_FETCH_FAILED', 'ref': ref, 'errorType': type(exc).__name__})
        series.append({'ref': ref, 'status': status, 'pointCount': len(points),
                       'firstTimestampMs': points[0][0] if points else None,
                       'lastTimestampMs': points[-1][0] if points else None})
    if not any(len(p) >= 2 for p in data.values()):
        raise RuntimeError('NO_USABLE_DATA: no series with at least two points')
    if any(s['status'] != 'ok' for s in series):
        warnings.append({'code': 'PARTIAL_DATA'})
    charts_list = []
    if req.get('charts', True):
        from rzlib import charts
        asset_dir = root / 'assets'
        asset_dir.mkdir()
        charts_list = charts.render_variant_figures(variant, data, str(asset_dir), end)
    materials = req.get('materials', [])
    web = req.get('webSearchEnabled', False)
    if not isinstance(web, bool):
        raise ValueError('webSearchEnabled must be boolean')
    if any(m.get('kind') == 'web' for m in materials) and not web:
        raise ValueError('web material requires webSearchEnabled=true')
    synthesis = req.get('synthesis')
    if synthesis is not None and (not isinstance(synthesis, str) or len(synthesis) > 16000 or '\x00' in synthesis):
        raise ValueError('synthesis must be a bounded string')
    events = []
    if materials or synthesis:
        if synthesis:
            events = ['- 以下为基于历史周报的 LLM 综合推理（仅依据给定材料梳理冲突/延续/驱动变化），未人工核实，不作为执行指令。']
        else:
            events = ['- 以下为 connector 注入的参考资料摘录；未自动核实，不是执行指令。']
    if synthesis:
        events.append('\n### 本周综合推理（LLM，仅依据给定材料）\n' + synthesis)
        events.append('')
    if materials and synthesis:
        events.append('参考资料摘录：')
    for m in materials:
        if m.get('kind') not in ('weknora', 'web') or not all(isinstance(m.get(k), str) and m[k] for k in ('id', 'title', 'text')):
            raise ValueError('material requires kind, id, title, text')
        # Quote material rather than treating it as generator instructions, and drop
        # the stored report's metadata/disclaimer lines so only the substance is quoted.
        body = _clean_material(m['text'])
        if not body:
            continue
        events.append('\n> ' + ('[' + m['id'] + '] ' + m['title'] + '\n' + body).replace('\n', '\n> '))
    md_path = Path(reports.build_weekly(str(root), variant, data, end, {
        'stem': 'report', 'period': req.get('period') or end, 'charts': charts_list,
        'events': '\n'.join(events) or None, 'with_web': web,
    }))
    md = md_path.read_text(encoding='utf-8')
    md = md.replace('http://127.0.0.1:5100', base)
    # Leave a stable anchor for the host's post-hoc analysis (本周多空逻辑 / 近四周连贯性 / 风险).
    if '## 五、本周要点与跟踪' in md:
        md = md.replace('## 五、本周要点与跟踪', '## 五、本周要点与跟踪\n\n__RUN19_ANALYSIS__\n', 1)
    if '## 六、风险提示' in md:
        md = md.replace('## 六、风险提示', '## 六、风险提示\n\n__RUN19_RISK__\n', 1)
    scope = ('已启用联网查询（搜索新闻）与外部信息分析，请结合外部信源补充归因并在文中标注来源；' if web else '未执行联网搜索；')
    scope += ('包含调用方显式注入的联网材料。' if any(m.get('kind') == 'web' for m in materials) else '无联网新闻材料。')
    if materials:
        scope += '包含 connector 注入的参考材料，引用未自动核实。'
    md = md.replace(reports._scope_line(bool(web)), scope)
    data_summary = _data_summary(variant, data)
    assets = []
    for path, caption in charts_list:
        p = Path(path).resolve()
        rel = p.relative_to(root).as_posix()
        md = md.replace(str(p), rel)
        raw = p.read_bytes()
        assets.append({'path': rel, 'absolutePath': str(p), 'sha256': hashlib.sha256(raw).hexdigest(),
                       'bytes': len(raw), 'mimeType': 'image/png', 'caption': caption})
    if warnings:
        md += '\n\n> 数据完整性提示：部分序列缺失或获取失败，详见 manifest.sources.series。\n'
    # write_text() translates newlines on Windows, which made the manifest hash
    # describe different bytes from the file on disk. Persist the exact bytes
    # that are hashed so Host verification is platform-independent.
    md_path.write_bytes(md.encode('utf-8'))
    fetched = dt.datetime.now(dt.timezone.utc).isoformat()
    manifest = {
        'schemaVersion': 'run19.weekly-source.v1', 'runId': root.name, 'runDir': str(root),
        'status': 'draft', 'generator': {'name': '@run19/weekly-report-source', 'version': '0.1.0', 'upstreamVersion': '0.1.5'},
        'title': md.splitlines()[0].removeprefix('# '),
        'markdown': {'path': 'report.md', 'absolutePath': str(md_path), 'sha256': hashlib.sha256(md.encode()).hexdigest(), 'bytes': len(md.encode())},
        'assets': assets, 'sourceMeta': {'dataSummary': data_summary},
        'sources': {'baseUrl': base, 'requestedStart': start, 'requestedEnd': end, 'fetchedAt': fetched, 'series': series, 'materials': [
            {k: m[k] for k in ('id', 'kind', 'title', 'url', 'knowledgeId', 'versionId') if k in m} | {'textSha256': hashlib.sha256(m['text'].encode()).hexdigest()} for m in materials]},
        'config': {'variety': req['variety'], 'period': req.get('period') or end, 'charts': req.get('charts', True), 'webSearchEnabled': web, 'webSearchExecuted': False},
        'warnings': warnings, 'manifestPath': str(root / 'manifest.json'),
    }
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    assert not any(k.endswith('pdfbuilder') or k == 'fitz' or k == 'cli' for k in sys.modules)
    return manifest


if __name__ == '__main__':
    try:
        print(json.dumps(generate(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'errorType': type(exc).__name__, 'message': str(exc)}), file=sys.stderr)
        sys.exit(1)
