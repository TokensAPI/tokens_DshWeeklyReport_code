# -*- coding: utf-8 -*-
"""rzlib.reports — 报告内容组装（Markdown 生成）

功能一：weekly 周报 — 固定模板 + 数据自动填充
功能二：alert  异动证据报告 — 行情回顾 + 关键指标证据 + 待写归因
生成的 md 交给 pdfbuilder.build() 渲染成模板版式 PDF。
"""
import os, json, datetime

from . import variants

WEEK_TEMPLATE = """# {variety} {code}：润洲周度报告（{period}）

> **核心快照**：{snapshot_line}
> **行情性质**：{nature_line}
> **数据口径**：数据来自本地 API（runzhou.work 镜像，http://127.0.0.1:5100），截至 {as_of}；周更序列可能滞后至上一周。
> **联网分析**：{scope_line}

---

## 一、行情快照

{snapshot_table}

---

## 二、图表

{charts_section}

---

## 三、盘面结构

{structure_section}

---

## 四、供需与库存（周频）

{supply_section}

---

## 五、本周要点与跟踪（待填充）

{events_section}

---

## 六、风险提示

- 待分析师补充：政策、资金面、外围情绪与产业行为变化。

---

> 数据平台：http://127.0.0.1:5100{page_anchor}   ·   {disclaimer}
"""

ALERT_TEMPLATE = """# {variety} {code}：{pct_line}

> **核心结论**：{verdict_placeholder}
> **行情快照**：{bench_label} 最新 {last}（{delta_pct:+.2f}% vs 前值 {prev}）{unit}，截至 {as_of}。
> **结构提示**：见下方证据表与图表。
> **数据口径**：数据来自本地 API（runzhou.work 镜像，http://127.0.0.1:5100）；外部信源需归因时由分析师/模型补充并标注。
> **联网分析**：{scope_line}

---

## 一、行情回顾（平台数据）

| 指标 | 最新 | 前值 | 变化 | 环比% |
|---|---|---|---|---|
{review_rows}

![价格轨迹]({price_chart_rel})

---

## 二、关键指标证据（异动归因依据）

{evidence_section}

---

## 三、结构信号

{structure_signals}

---

## 四、风险与观察指标（待填充）

- 待归因补充：库存持续性、仓单/交割压力、供给扰动退坡、需求证伪风险、资金与外围。

---

## 五、结论（待归因补充）

> 一句话结论待分析师/模型撰写：基于上方证据链（{drivers_hint}）给出驱动拆解与后续观察点。

> 数据口径备注：本报告基于本地 API（runzhou.work 镜像，http://127.0.0.1:5100）序列，截止 {as_of}；外部信源（公告、行业周报等）仅作交叉佐证并需标注。内部参考，仅供投研使用，不构成投资建议。
"""


def fmt(x, unit=""):
    s = variants.fmt(x)
    return s + unit


def _scope_line(with_web):
    """根据是否联网分析返回报告「联网分析」行说明。"""
    if with_web:
        return "已启用联网查询（搜索新闻）与外部信息分析，请结合外部信源补充归因并在文中标注来源。"
    return "本报告仅基于本地 API 查询结果总结，未进行联网新闻/外部信息分析。"


def _prev_point(pts, last_ts, days=7):
    """取距 last_ts 约 days 天前的点；找不到则取倒数第二个点。"""
    if not pts:
        return None
    target = last_ts - days * 86400 * 1000
    best = None
    for ms, v in pts:
        if ms <= target:
            best = (ms, v)
    if best is None and len(pts) >= 2:
        best = pts[-2]
    return best


def snapshot_rows(data, refs_labels):
    """refs_labels: [(ref,label)] -> rows 及一行快照文本。"""
    rows = []
    bits = []
    for ref, label in refs_labels:
        pts = data.get(ref) or []
        if len(pts) < 2:
            continue
        last_ts, last = pts[-1]
        prev = _prev_point(pts, last_ts, 7) or pts[-2]
        pv = prev[1]
        if pv:
            chg = (last / pv - 1) * 100
            rows.append((label, variants.fmt(last), variants.fmt(pv), f"{chg:+.2f}%"))
            bits.append(f"{label} {variants.fmt(last)}（{chg:+.2f}%）")
        else:
            rows.append((label, variants.fmt(last), "—", "—"))
    return rows, "；".join(bits[:6])


def md_table(headers, rows):
    if not rows:
        return "（本周无平台数据）"
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(x) for x in r) + " |")
    return "\n".join(out)


def _weekly_evidence_sections(variant, data):
    """Split evidence by report meaning instead of duplicating every row twice."""
    structure_words = ("基差", "升贴水", "价差", "月差", "结构", "现货", "期货")
    supply_words = ("供需", "库存", "仓单", "产量", "开工", "加工", "成本", "进口", "出口")
    structure_parts = []
    supply_parts = []
    for group_name, group_refs in variant.get("evidence", []):
        rows, _ = snapshot_rows(data, group_refs)
        if not rows:
            continue
        block = f"### {group_name}\n\n" + md_table(["指标", "最新", "一周前", "环比"], rows)
        if any(word in group_name for word in supply_words):
            supply_parts.append(block)
        elif any(word in group_name for word in structure_words):
            structure_parts.append(block)
        else:
            structure_parts.append(block)
    return (
        "\n\n".join(structure_parts) or "（本周无可用盘面结构数据）",
        "\n\n".join(supply_parts) or "（本周无可用供需或库存数据）",
    )


# ---------- 功能一：周报 ----------

def build_weekly(out_dir, variant, data, as_of, opts):
    os.makedirs(out_dir, exist_ok=True)
    name, code = variant["name"], variant["code"]
    period = opts.get("period") or as_of
    # 行情快照
    bench = variant.get("benchmarks") or []
    bench_refs = []
    for b in bench:
        for r in b.get("refs", []):
            if r not in [x[0] for x in bench_refs]:
                bench_refs.append((r, b["label"]))
    all_refs = list(bench_refs)
    rows, snap_line = snapshot_rows(data, all_refs)
    if bench:
        main = bench[0]
        pts = data.get(main.get("refs", [None])[0] if main.get("refs") else None) or []
        if len(pts) >= 2:
            pv = _prev_point(pts, pts[-1][0], 7) or pts[-2]
            if pv[1]:
                chg = (pts[-1][1] / pv[1] - 1) * 100
                snap_line = snap_line or f"{main['label']} {variants.fmt(pts[-1][1])}（{chg:+.2f}%）"
    nature_line = opts.get("nature") or "待分析填充：本周多空逻辑与关键驱动。"
    # 图表（用绝对路径：本机 md/PDF 渲染可解析；上传 WeKnora 时工具会再嵌入为 data-URI）
    chart_lines = []
    for path, caption in opts.get("charts", []):
        rel = os.path.abspath(path).replace(os.sep, "/")
        chart_lines.append(f"![{caption}]({rel})")
    charts_section = "\n".join(chart_lines) if chart_lines else "（本品种暂无可渲染图表）"
    structure_section, supply_section = _weekly_evidence_sections(variant, data)
    events_section = opts.get("events") or "- 待填充：本周重点事件（政策/供需/资金/产业）。"
    page_anchor = f"/page/{variant['page']}" if variant.get("page") else ""
    disclaimer = "内部参考 · 仅供投研使用 · 不构成投资建议。"
    content = WEEK_TEMPLATE.format(
        variety=name, code=code, period=period, snapshot_line=snap_line or "待填",
        nature_line=nature_line, as_of=as_of, scope_line=_scope_line(opts.get("with_web")),
        snapshot_table=md_table(
            ["指标", "最新", "一周前", "环比"], rows) if rows else "（暂无基准数据，请检查平台序列）",
        charts_section=charts_section, structure_section=structure_section,
        supply_section=supply_section, events_section=events_section,
        page_anchor=page_anchor, disclaimer=disclaimer)
    stem = opts.get("stem") or f"{name}_{code}_周度报告_{period}"
    md_path = os.path.join(out_dir, f"{stem}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(content)
    return md_path


# ---------- 功能二：异动证据报告 ----------

def build_alert(out_dir, variety, anomaly, evidence_rows, chart_path, as_of, with_web=False):
    """写出单商品异动证据 md。anomaly: benchmark dict（带 label/last/prev/delta_pct/unit）。"""
    os.makedirs(out_dir, exist_ok=True)
    name, code = variety["name"], variety["code"]
    bench = anomaly.get("benchmark", anomaly)
    label = bench.get("label", "价格")
    last = bench.get("last"); prev = bench.get("prev")
    d = bench.get("delta_pct", 0.0)
    unit = bench.get("unit", "")
    review_rows = []
    for gname, gl in evidence_rows:
        for ref, lab, lastv, prevv, chg in gl:
            review_rows.append((lab, variants.fmt(lastv), variants.fmt(prevv),
                                "", f"{chg:+.2f}%"))
    if not review_rows:
        review_rows.append((label, variants.fmt(last), variants.fmt(prev), "", f"{d:+.2f}%"))
    evidence_sections = []
    for gname, gl in evidence_rows:
        lines = [f"### {gname}", ""]
        trows = [(lab, variants.fmt(lv), variants.fmt(pv), f"{c:+.2f}%")
                 for ref, lab, lv, pv, c in gl]
        lines.append(md_table(["指标", "最新", "前值", "环比"], trows))
        evidence_sections.append("\n".join(lines))
    evidence_section = "\n\n".join(evidence_sections) if evidence_sections else "（无配套指标数据，请补充外部信源归因）"
    drivers_hint = "平台关键指标变化 + 待补充外部信息"
    price_rel = os.path.relpath(chart_path, out_dir).replace(os.sep, "/") if chart_path else ""
    content = ALERT_TEMPLATE.format(
        variety=name, code=code, pct_line=f"价格异动证据包（{d:+.2f}%）",
        verdict_placeholder="待归因：基于下方证据链给出驱动判定（供给/需求/库存/资金偏离）。",
        bench_label=label, last=variants.fmt(last), prev=variants.fmt(prev),
        delta_pct=d, unit=unit, as_of=as_of, scope_line=_scope_line(with_web),
        review_rows="\n".join("| " + " | ".join(r) + " |" for r in review_rows),
        price_chart_rel=price_rel or "", evidence_section=evidence_section,
        structure_signals="（仓单/月差/升贴水等结构信号由分析补充；升贴水变化见上表。）",
        drivers_hint=drivers_hint)
    md_path = os.path.join(out_dir, f"{name}_{code}_异动_证据包_{as_of}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(content)
    return md_path


def dump_json(out_dir, obj, name):
    p = os.path.join(out_dir, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, default=str)
    return p
