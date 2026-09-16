# -*- coding: utf-8 -*-
"""rzlib.fonts — 跨平台中文字体发现（macOS / Windows / Linux）。

matplotlib 需要注册字体并把 rcParams.family 指向其 family 名；pymupdf
直接传 fontfile 路径即可。本模块统一返回 (path, family)。
"""
import os
import sys

_CANDIDATES = [
    # macOS
    ("/System/Library/Fonts/STHeiti Medium.ttc", "STHeiti"),
    ("/System/Library/Fonts/PingFang.ttc", "PingFang SC"),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", "Hiragino Sans GB"),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", "Songti SC"),
    # Windows
    ("C:/Windows/Fonts/msyh.ttc", "Microsoft YaHei"),
    ("C:/Windows/Fonts/msyhbd.ttc", "Microsoft YaHei"),
    ("C:/Windows/Fonts/simhei.ttf", "SimHei"),
    ("C:/Windows/Fonts/simsun.ttc", "SimSun"),
    # Linux / 通用
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"),
    ("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf", "Noto Sans CJK SC"),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "WenQuanYi Micro Hei"),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "WenQuanYi Zen Hei"),
]

_reward = 0


def find_font():
    """返回第一个存在的中文字体 (path, family)；都没有返回 (None, None)。"""
    for path, fam in _CANDIDATES:
        if os.path.exists(path):
            return path, fam
    # DSH 工作区本地兜底：随插件安装目录旁的 OpenType 字体
    here = os.path.dirname(os.path.abspath(__file__))
    for fn in ("NotoSansCJKsc-Regular.otf", "NotoSansCJK-Medium.ttc", "wqy-microhei.ttc"):
        cand = os.path.join(here, "..", "fonts", fn)
        if os.path.exists(cand):
            return cand, "Noto Sans CJK SC"
    return None, None


def setup_matplotlib():
    """注册中文字体并设置 matplotlib 全局 family。返回使用的 (path, family)。"""
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import font_manager
    import matplotlib.pyplot as plt

    path, family = find_font()
    if path is None:
        raise RuntimeError(
            "未找到可用的中文字体。请安装任一 CJK 字体（macOS STHeiti/PingFang、"
            "Windows 微软雅黑/黑体、Linux Noto Sans CJK），或将 .ttc/.otf 放入插件 "
            "python/fonts/ 目录。")
    try:
        font_manager.fontManager.addfont(path)
    except Exception as e:
        raise RuntimeError(f"注册字体失败 {path}: {e}")
    plt.rcParams["font.family"] = family
    plt.rcParams["axes.unicode_minus"] = False
    return path, family


def font_tip():
    path, family = find_font()
    if path is None:
        return None
    return path
