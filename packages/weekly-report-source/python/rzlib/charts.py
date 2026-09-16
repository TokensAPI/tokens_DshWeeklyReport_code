# -*- coding: utf-8 -*-
"""rzlib.charts — 模板化图表生成

按 variant["figures"] 规格渲染时间序列图：
  - 单轴 / 多面板(panels) / 右轴(twin, axis=right)
  - 零线(zero)、价差序列(spread=a-b)、marker/线宽
统一版式：继承工作区沥青/碳酸锂图表风格（浅灰网格、去顶右边框、页脚数据来源）。
"""
import os, datetime
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

from . import fonts

DEEP = "#003366"
SUB = "#e08a1e"
GRAY = "#777777"
GREEN = "#2e8b57"
RED = "#c0392b"
PURPLE = "#8e44ad"
BLUE = "#1f5cae"

_DEFAULT_COLORS = [DEEP, SUB, GREEN, PURPLE, RED, BLUE, GRAY]


def _setup():
    fonts.setup_matplotlib()


def _series(data, sid, window_days=None):
    """(datetime[], value[])；window_days 给出时只保留最近该窗口。"""
    pts = data.get(sid) or []
    if window_days:
        last_ts = pts[-1][0] if pts else 0
        cutoff = last_ts - window_days * 86400 * 1000
        pts = [p for p in pts if p[0] >= cutoff]
    x, y = [], []
    for ms, v in pts:
        if v is None:
            continue
        x.append(datetime.datetime.fromtimestamp(ms / 1000))
        y.append(v)
    return x, y


def _yfmt(v, pos):
    try:
        if abs(v) >= 1000:
            return f"{v:,.0f}"
        if abs(v) >= 1:
            return f"{v:,.1f}".rstrip("0").rstrip(".")
        return f"{v:.2f}".rstrip("0").rstrip(".")
    except Exception:
        return ""


def style_ax(ax):
    ax.grid(True, which="major", color="#dddddd", linewidth=0.6, alpha=0.8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    for sk in ["left", "bottom"]:
        ax.spines[sk].set_color("#888888")


def footer(fig, txt):
    fig.text(0.01, 0.005, txt, fontsize=7, color="#999999")


def _slice_xy(x, y, window_days):
    """按最近 window_days 切片（datetime[] / value[]）。"""
    if not window_days or not x:
        return x, y
    cutoff = x[-1] - datetime.timedelta(days=window_days)
    xx, yy = [], []
    for xi, yi in zip(x, y):
        if xi >= cutoff:
            xx.append(xi); yy.append(yi)
    return xx, yy


def _plot_left(ax, panel, data, window_days=None):
    """绘制左轴序列（axis != right），返回 (handles, labels)。"""
    hs, ls = [], []
    for s in panel.get("series", []):
        if s.get("axis") == "right":
            continue
        x, y = _series(data, s["ref"], window_days)
        if not x:
            continue
        kw = {"color": s.get("color", _DEFAULT_COLORS[0]), "lw": s.get("lw", 1.3)}
        if s.get("marker"):
            kw["marker"] = s["marker"]
            kw.setdefault("ms", 3.5)
        h, = ax.plot(x, y, label=s.get("label", s["ref"]), **kw)
        hs.append(h); ls.append(s.get("label", s["ref"]))
    # 价差序列（a-b）
    sp = panel.get("spread")
    if sp:
        xs, ys = _spread_series(data, sp["a"], sp["b"])
        xs, ys = _slice_xy(xs, ys, window_days)
        if xs:
            h, = ax.plot(xs, ys, color=sp.get("color", GRAY), lw=1.6,
                         label=sp.get("label"))
            hs.append(h); ls.append(sp.get("label"))
    return hs, ls


def _spread_series(data, a, b):
    sa = data.get(a) or []
    sb = data.get(b) or []
    mb = dict(sb)
    out = []
    for ms, v in sa:
        if v is None or ms not in mb or mb[ms] is None:
            continue
        out.append((ms, v - mb[ms]))
    return _series({"x": out}, "x")


def ts_figure(cfg, data, out_path, as_of):
    _setup()
    panels = cfg.get("panels")
    if panels:
        n = len(panels)
        fig, axs = plt.subplots(1, n, figsize=(11.5, 3.9), dpi=150)
        if n == 1:
            axs = [axs]
    else:
        panels = [cfg]
        fig, axs = plt.subplots(figsize=(11.5, 3.9), dpi=150)
        axs = [axs]

    for i, panel in enumerate(panels):
        ax = axs[i]
        ax.set_title(panel.get("title") or "", fontsize=11.5)
        ylabel = panel.get("ylabel", "")
        if ylabel:
            ax.set_ylabel(ylabel)
        style_ax(ax)
        if panel.get("zero"):
            ax.axhline(0, color="#999999", lw=0.8, ls="--")
        window_days = panel.get("window_days") or cfg.get("window_days")
        hs, ls = _plot_left(ax, panel, data, window_days)
        # 右轴
        right = [s for s in panel.get("series", []) if s.get("axis") == "right"]
        if right:
            ax2 = ax.twinx()
            for s in right:
                x, y = _series(data, s["ref"], window_days)
                if not x:
                    continue
                kw = {"color": s.get("color", SUB), "lw": s.get("lw", 1.3)}
                if s.get("marker"):
                    kw["marker"] = s["marker"]; kw.setdefault("ms", 3.5)
                h, = ax2.plot(x, y, label=s.get("label", s["ref"]), **kw)
                hs.append(h); ls.append(s.get("label", s["ref"]))
            ax2.set_ylabel(panel.get("twin_ylabel", ""))
            ax2.spines["top"].set_visible(False)
            ax2.yaxis.set_major_formatter(FuncFormatter(_yfmt))
        ax.yaxis.set_major_formatter(FuncFormatter(_yfmt))
        if hs:
            ax.legend(hs, ls, fontsize=8.5, frameon=False, loc="upper left", ncol=2)

    fig.autofmt_xdate()
    footer(fig, f"数据来源：本地 API（runzhou.work 镜像）  截至 {as_of}")
    fig.tight_layout(rect=[0, 0.02, 1, 1])
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


def alert_price_figure(label, unit, points, prev, last, out_path, as_of):
    """异动监控价格轨迹图：末两点标注较前值涨跌。"""
    _setup()
    fig, ax = plt.subplots(figsize=(10.5, 3.8), dpi=150)
    x = [datetime.datetime.fromtimestamp(ms / 1000) for ms, v in points]
    y = [v for ms, v in points]
    ax.plot(x, y, color=DEEP, lw=1.8, marker="o", ms=3)
    if len(x) >= 2:
        ax.scatter(x[-2:], y[-2:], color=RED, zorder=5, s=26)
        chg = ((last / prev) - 1) * 100 if prev else 0
        ax.annotate(f"最新 {last:,.0f}（较前值 {chg:+.2f}%）",
                    xy=(x[-1], y[-1]),
                    xytext=(x[0], min(y) - (max(y) - min(y)) * 0.15),
                    fontsize=9, color=RED,
                    arrowprops=dict(arrowstyle="->", color=RED, lw=1))
    ax.set_title(f"{label} 价格轨迹", fontsize=12)
    ax.set_ylabel(unit or "价格")
    ax.yaxis.set_major_formatter(FuncFormatter(_yfmt))
    style_ax(ax)
    fig.autofmt_xdate()
    footer(fig, f"数据来源：本地 API（runzhou.work 镜像）  截至 {as_of}")
    fig.tight_layout(rect=[0, 0.02, 1, 1])
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


def render_variant_figures(variant, data, out_dir, as_of):
    """渲染品种全部图表 -> out_dir/charts/<i>_<key>.png；返回 [(path, caption)]。"""
    os.makedirs(os.path.join(out_dir, "charts"), exist_ok=True)
    out = []
    for i, cfg in enumerate(variant.get("figures", []), 1):
        p = os.path.join(out_dir, "charts", f"{i}_{cfg['key']}.png")
        try:
            ts_figure(cfg, data, p, as_of)
            out.append((p, cfg.get("title", cfg["key"])))
        except Exception as e:
            print(f"[warn] 图 {cfg['key']} 失败: {e}")
    return out


def wkn_chart_caption(report_stem, index, caption):
    """返回知识库（WeKnora）图表标题：『[原周报文件名] - [序号]-[caption]』。

    例：report_stem='锡 - 周报 - 2026-09-08-16-39-31'，index=1，caption='锡价走势：沪锡 vs LME锡 · 1年'
    ->  '锡 - 周报 - 2026-09-08-16-39-31 - 1-锡价走势：沪锡 vs LME锡 · 1年'
    """
    return f"{report_stem} - {index}-{caption}"
