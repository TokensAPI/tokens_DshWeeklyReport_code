# -*- coding: utf-8 -*-
"""rzlib.variants — 品种规格表（目录驱动）

每个品种描述：
  - benchmarks : 异动监控的基准价序列（ref id 优先，或搜索关键字兜底）
  - figures    : 周报图表模板（固定模板，charts.py 按此渲染）
  - evidence   : 归因用的关键指标组（异动报告证据表）

三套手工特调模板（沥青固定六图 / 碳酸锂 / 锡）对应工作区参考 PDF。
其余全部品种由内置全量目录（catalog.json，覆盖本地 API（runzhou.work 镜像）平台
54 个品种 / 7 大板块 / 2400+ 条序列）自动解析：挑基准价、组证据、画价格图，
做到任意商品开箱即用。另有离线目录查询：list_varieties() / catalog_series()。
"""
import datetime
import json
import os
import re

PALETTE = ["#1f5cae", "#c0392b", "#b58c29", "#2e8b57", "#8e44ad",
           "#e08a1e", "#777777", "#003366"]

_HERE = os.path.dirname(os.path.abspath(__file__))
_CATALOG_PATH = os.path.join(_HERE, "catalog.json")


def load_catalog():
    """目录加载：优先 RUNZHOU_CACHE/catalog.json（运行时刷新版），
    否则用随包内置目录。返回 list[dict]。"""
    cat = []
    cache = os.environ.get("RUNZHOU_CACHE")
    if cache:
        p = os.path.join(cache, "catalog.json")
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    cat = json.load(f)
            except Exception:
                cat = []
    if not cat and os.path.exists(_CATALOG_PATH):
        try:
            with open(_CATALOG_PATH, "r", encoding="utf-8") as f:
                cat = json.load(f)
        except Exception:
            cat = []
    return cat


_CATALOG = load_catalog()

# 供 cli 运行时基准兜底与 catalog --refresh 使用
_CACHE_DIR = os.environ.get("RUNZHOU_CACHE", os.path.join(os.path.expanduser("~"), ".runzhou"))

# ---------- 沥青（固定模板：6 图周度深度报告） ----------
ASPHALT = {
    "name": "沥青",
    "code": "BU",
    "sector": "能源",
    "group": "能源组",
    "page": "1876",
    "period_hint": "周频",
    "benchmarks": [
        {"label": "山东低端价沥青crack(马瑞)", "refs": ["RZ_20043"], "kind": "价差", "unit": "元/吨"},
        {"label": "沥青盘面裂解", "refs": ["RZ_17305"], "kind": "裂解", "unit": "元/吨"},
    ],
    "evidence": [
        ("基差", [
            ("RZ_17152", "山东华龙基差"),
            ("RZ_17153", "华南基差"),
            ("RZ_17990", "华北基差"),
            ("RZ_17992", "西南基差"),
        ]),
        ("裂解/价差", [
            ("RZ_17305", "盘面裂解"),
            ("RZ_20043", "山东现货crack(马瑞)"),
            ("RZ_17809", "山东:渣油-沥青"),
        ]),
        ("供需/开工", [
            ("RZ_17362", "企业出货量(万吨)"),
            ("RZ_17316", "山东产量(万吨)"),
            ("RZ_17334", "改性沥青开工率(%)"),
        ]),
    ],
    "figures": [
        {"key": "crack", "window_days": 400, "title": "沥青裂解估值：盘面裂解 vs 山东现货crack(马瑞) · 1年",
         "ylabel": "盘面裂解(元/吨)", "twin_ylabel": "现货crack(元/吨)",
         "series": [
             {"ref": "RZ_17305", "label": "沥青盘面裂解(元/吨)", "color": "#003366"},
             {"ref": "RZ_20043", "label": "山东低端价crack(马瑞,元/吨)", "color": "#e08a1e", "twin": True},
         ]},
        {"key": "basis", "window_days": 400, "title": "沥青现货基差（山东华龙/华南/华北/西南）· 1年",
         "ylabel": "元/吨", "zero": True,
         "series": [
             {"ref": "RZ_17152", "label": "山东华龙基差", "color": "#003366"},
             {"ref": "RZ_17153", "label": "华南基差", "color": "#e08a1e"},
             {"ref": "RZ_17990", "label": "华北基差", "color": "#2e8b57"},
             {"ref": "RZ_17992", "label": "西南基差", "color": "#8e44ad"},
         ]},
        {"key": "spread", "window_days": 400, "title": "月差结构",
         "panels": [
             {"title": "近端月差：连一-连三 / 连二-连三", "ylabel": "元/吨", "zero": True,
              "series": [
                  {"ref": "RZ_21800", "label": "连一-连三", "color": "#003366"},
                  {"ref": "RZ_22984", "label": "连二-连三", "color": "#e08a1e"},
              ]},
             {"title": "远端月差：06-09 / 06-12", "ylabel": "元/吨", "zero": True,
              "series": [
                  {"ref": "RZ_17303", "label": "06-09", "color": "#1f5cae"},
                  {"ref": "RZ_17304", "label": "06-12", "color": "#c0392b"},
              ]},
         ]},
        {"key": "output", "window_days": 800, "title": "产量与出货量",
         "panels": [
             {"title": "分地区周产量（万吨）· 2年", "ylabel": "万吨",
              "series": [
                  {"ref": "RZ_17316", "label": "山东产量", "color": "#003366"},
                  {"ref": "RZ_17317", "label": "华东产量", "color": "#e08a1e"},
                  {"ref": "RZ_17318", "label": "华北产量", "color": "#2e8b57"},
              ]},
             {"title": "企业出货量（万吨）· 2年", "ylabel": "万吨",
              "series": [
                  {"ref": "RZ_17362", "label": "企业出货量", "color": "#c0392b"},
                  {"ref": "RZ_17367", "label": "西南出货量", "color": "#8e44ad"},
              ]},
         ]},
        {"key": "operating", "window_days": 800, "title": "沥青下游开工率（%）· 2年",
         "ylabel": "%",
         "series": [
             {"ref": "RZ_17334", "label": "改性沥青开工率", "color": "#003366"},
             {"ref": "RZ_17331", "label": "道路改性开工率", "color": "#e08a1e"},
             {"ref": "RZ_17336", "label": "华东改性开工率", "color": "#2e8b57"},
             {"ref": "RZ_17329", "label": "东北重交开工率", "color": "#8e44ad"},
             {"ref": "RZ_17330", "label": "西北重交开工率", "color": "#777777"},
         ]},
        {"key": "demand", "window_days": 800, "title": "表需与渣油-沥青价差",
         "panels": [
             {"title": "分地区周度表需（万吨）", "ylabel": "万吨",
              "series": [
                  {"ref": "RZ_23587", "label": "东北表需", "color": "#003366"},
                  {"ref": "RZ_23584", "label": "西南表需", "color": "#e08a1e"},
              ]},
             {"title": "渣油-沥青价差 / 区域物流价差（元/吨）", "ylabel": "元/吨", "zero": True,
              "series": [
                  {"ref": "RZ_17809", "label": "山东:渣油-沥青", "color": "#c0392b"},
                  {"ref": "RZ_20020", "label": "山东→华南价差", "color": "#1f5cae"},
              ]},
         ]},
    ],
}

# ---------- 碳酸锂（参考火爆分析报告实现） ----------
LITHIUM = {
    "name": "碳酸锂",
    "code": "LC",
    "sector": "有色",
    "group": "有色组",
    "page": "",
    "period_hint": "日频",
    "benchmarks": [
        {"label": "碳酸锂现货价（SMM基准）", "refs": ["RZ_07365"], "kind": "现货", "unit": "元/吨"},
        {"label": "碳酸锂期货指数LC8888", "refs": ["LC8888"], "kind": "期货", "unit": "元/吨"},
        {"label": "碳酸锂主力近月LC2610", "refs": ["LC2610"], "kind": "期货", "unit": "元/吨"},
    ],
    "evidence": [
        ("现货与期货", [
            ("RZ_07365", "现货价(元/吨)"),
            ("LC8888", "期货指数(元/吨)"),
            ("LC2610", "LC2610收盘(元/吨)"),
            ("LC2701", "LC2701收盘(元/吨)"),
        ]),
        ("库存/仓单", [
            ("RZ_14936", "仓单(张)"),
            ("RZ_20428", "锂矿在途库存(吨)"),
        ]),
        ("升贴水", [
            ("RZ_16363", "电池级·赣锋升贴水"),
            ("RZ_16364", "电池级·九岭升贴水"),
            ("RZ_16365", "电池级·盛新升贴水"),
            ("RZ_16368", "工业级·蓝科升贴水"),
        ]),
    ],
    "figures": [
        {"key": "price", "title": "碳酸锂价格轨迹：现货 / 近月 / 远月",
         "ylabel": "元/吨",
         "series": [
             {"ref": "RZ_07365", "label": "现货价", "color": "#1f5cae", "marker": "o", "lw": 2.2},
             {"ref": "LC2610", "label": "LC2610 近月", "color": "#c0392b", "marker": "s", "lw": 1.8},
             {"ref": "LC2701", "label": "LC2701 远月", "color": "#b58c29", "marker": "^", "lw": 1.8},
         ]},
        {"key": "structure", "title": "仓单 与 远月-近月价差",
         "series": [
             {"ref": "RZ_14936", "label": "碳酸锂仓单(张)", "color": "#2e8b57", "axis": "left"},
         ],
         "spread": {"a": "LC2701", "b": "LC2610", "label": "远月-近月价差(元/吨)", "color": "#b58c29"}},
    ],
}

# ---------- 锡（价格、库存、结构、成本与进口） ----------
TIN = {
    "name": "锡",
    "code": "SN",
    "sector": "有色",
    "group": "有色组",
    "page": "1421",
    "period_hint": "日频",
    "benchmarks": [
        {"label": "沪锡收盘价", "refs": ["RZ_08594"], "kind": "期货", "unit": "元/吨"},
        {"label": "LME锡收盘价", "refs": ["RZ_08600"], "kind": "期货", "unit": "美元/吨"},
    ],
    "evidence": [
        ("库存/仓单", [
            ("RZ_06310", "LME锡库存"),
            ("RZ_06338", "上期所锡仓单合计"),
            ("RZ_06335", "上海锡仓单"),
            ("RZ_06336", "广东锡仓单"),
        ]),
        ("升贴水/内外盘", [
            ("RZ_06313", "LME锡升贴水"),
            ("RZ_14861", "锡内外价差"),
            ("RZ_24154", "云锡升贴水"),
            ("RZ_24155", "云字升贴水"),
        ]),
        ("成本/进口", [
            ("RZ_06320", "60%锡精矿加工费"),
            ("RZ_06319", "40%锡精矿加工费"),
            ("RZ_06314", "锡现货进口盈亏"),
        ]),
    ],
    "figures": [
        {"key": "price", "window_days": 400,
         "title": "锡价走势：沪锡 vs LME锡 · 1年",
         "ylabel": "沪锡（元/吨）", "twin_ylabel": "LME锡（美元/吨）",
         "series": [
             {"ref": "RZ_08594", "label": "沪锡收盘价", "color": "#003366", "lw": 2.0},
             {"ref": "RZ_08600", "label": "LME锡收盘价", "color": "#e08a1e", "lw": 1.8, "axis": "right"},
         ]},
        {"key": "inventory", "window_days": 800,
         "title": "锡库存与仓单 · 2年",
         "panels": [
             {"title": "LME锡库存", "series": [
                 {"ref": "RZ_06310", "label": "LME锡库存", "color": "#003366"},
             ]},
             {"title": "上期所锡仓单", "series": [
                 {"ref": "RZ_06338", "label": "仓单合计", "color": "#c0392b"},
                 {"ref": "RZ_06335", "label": "上海", "color": "#1f5cae"},
                 {"ref": "RZ_06336", "label": "广东", "color": "#2e8b57"},
             ]},
         ]},
        {"key": "structure", "window_days": 400,
         "title": "锡升贴水与内外盘结构 · 1年",
         "panels": [
             {"title": "LME升贴水 / 内外价差", "zero": True, "series": [
                 {"ref": "RZ_06313", "label": "LME锡升贴水", "color": "#003366"},
                 {"ref": "RZ_14861", "label": "锡内外价差", "color": "#e08a1e"},
             ]},
             {"title": "国内品牌升贴水", "zero": True, "series": [
                 {"ref": "RZ_24154", "label": "云锡", "color": "#1f5cae"},
                 {"ref": "RZ_24155", "label": "云字", "color": "#2e8b57"},
             ]},
         ]},
        {"key": "processing_import", "window_days": 800,
         "title": "锡精矿加工费与进口盈亏 · 2年",
         "panels": [
             {"title": "锡精矿加工费", "series": [
                 {"ref": "RZ_06320", "label": "60%锡精矿加工费", "color": "#003366"},
                 {"ref": "RZ_06319", "label": "40%锡精矿加工费", "color": "#e08a1e"},
             ]},
             {"title": "锡现货进口盈亏", "zero": True, "series": [
                 {"ref": "RZ_06314", "label": "进口盈亏", "color": "#c0392b"},
             ]},
         ]},
    ],
}

# ---------- 全商品别名表（→ catalog.json 的 variety 名） ----------
_ALIAS = {
    # 能源
    "沥青": "沥青", "bu": "沥青", "BU": "沥青",
    "原油": "原油", "sc": "原油", "SC": "原油",
    "燃料油": "燃料油", "fu": "燃料油", "FU": "燃料油",
    "柴油": "柴油/汽油", "汽油": "柴油/汽油", "柴油汽油": "柴油/汽油",
    "石脑油": "石脑油", "天然气": "天然气", "LPG": "LPG", "lpg": "LPG",
    "动力煤": "动力煤", "动煤": "动力煤",
    # 黑色
    "螺纹": "螺纹/成材", "螺纹钢": "螺纹/成材", "钢材": "螺纹/成材", "成材": "螺纹/成材",
    "热卷": "热卷", "热轧卷板": "热卷", "铁矿": "铁矿", "铁矿石": "铁矿",
    "焦煤": "焦煤", "焦炭": "焦炭", "废钢": "废钢", "不锈钢": "不锈钢",
    "锰硅": "锰硅", "硅铁": "硅铁", "铁合金": "铁合金",
    # 有色
    "碳酸锂": "碳酸锂", "lc": "碳酸锂", "LC": "碳酸锂", "锂": "碳酸锂",
    "锡": "锡", "sn": "锡", "SN": "锡",
    "铜": "铜", "沪铜": "铜", "cu": "铜", "CU": "铜",
    "铝": "铝", "沪铝": "铝", "al": "铝", "AL": "铝",
    "锌": "锌", "沪锌": "锌", "zn": "锌", "ZN": "锌",
    "镍": "镍", "沪镍": "镍", "ni": "镍", "NI": "镍",
    "铅": "铅", "沪铅": "铅", "pb": "铅", "PB": "铅",
    "锰矿": "锰(矿)", "锰": "锰(矿)",
    "黄金": "贵金属", "金": "贵金属", "沪金": "贵金属", "au": "贵金属", "AU": "贵金属",
    "白银": "贵金属", "银": "贵金属", "沪银": "贵金属", "ag": "贵金属", "AG": "贵金属",
    "铂金": "贵金属", "铂": "贵金属",
    # 化工
    "纯碱": "纯碱", "玻璃": "玻璃", "甲醇": "甲醇", "尿素": "尿素",
    "PVC": "PVC", "pvc": "PVC", "聚氯乙烯": "PVC",
    "烧碱": "烧碱", "PTA": "PTA", "pta": "PTA", "MEG": "MEG", "meg": "MEG", "乙二醇": "MEG",
    "PX": "PX", "px": "PX", "聚烯烃": "聚烯烃", "聚丙烯": "聚烯烃", "PP": "聚烯烃", "pp": "聚烯烃",
    "聚乙烯": "聚烯烃", "塑料": "聚烯烃", "PE": "聚烯烃", "pe": "聚烯烃",
    "苯化工": "苯化工", "苯乙烯": "苯化工", "纯苯": "苯化工",
    "聚酯": "聚酯(短纤/瓶片)", "短纤": "聚酯(短纤/瓶片)", "瓶片": "聚酯(短纤/瓶片)",
    "工业硅": "工业硅", "多晶硅": "多晶硅", "橡胶": "橡胶", "纸浆": "纸浆", "磷肥": "磷肥",
    # 农产品 / 油脂
    "棕榈油": "棕榈油", "棕榈": "棕榈油", "豆油": "豆油", "菜油": "菜油", "葵油": "葵油",
    "油脂": "豆油",
    "棉花": "棉花", "白糖": "白糖", "苹果": "苹果", "红枣": "红枣", "花生": "花生",
    "玉米": "玉米", "鸡蛋": "鸡蛋", "生猪": "生猪", "原木": "原木",
    # 其它
    "航运": "航运", "海外宏观": "海外宏观", "宏观": "海外宏观",
}

# 贵金属内部按金属再切分（catalog 里黄金/白银/铂金同属 variety=贵金属）
_PM_KIND = {
    "黄金": lambda n: ("黄金" in n or "金" in n) and "白银" not in n and "铂" not in n and "钯" not in n,
    "白银": lambda n: "白银" in n,
    "铂金": lambda n: "铂" in n or "钯" in n,
}

_SECTOR_GROUP = {"黑色": "黑色组", "化工": "化工组", "有色": "有色金属组",
                 "农产品": "农产品组", "能源": "能源组", "宏观": "宏观组",
                 "其他": "综合组"}

_CAT_GROUP = {
    "现货价格": "基差/升贴水",
    "升贴水/基差": "基差/升贴水",
    "库存": "库存",
    "仓单": "仓单/持仓",
    "持仓/资金": "仓单/持仓",
    "产量/供给": "产量/供给",
    "消费/需求": "需求/消费",
    "价差": "价差",
    "进口/出口": "进出口",
    "物流/发运": "发运",
    "成本/利润": "成本/利润",
    "期货价格": "期货价格",
    "价格/行情": "价格行情",
}

_GROUP_ORDER = ["现货价格", "升贴水/基差", "库存", "仓单", "持仓/资金",
                "产量/供给", "消费/需求", "价差", "进口/出口", "物流/发运",
                "成本/利润", "期货价格", "价格/行情"]


def _series_rows(variety, name_token=None):
    """返回某品种（可选金属关键字过滤）的目录行。"""
    rows = [r for r in _CATALOG if r.get("variety") == variety]
    if name_token and variety == "贵金属":
        fn = _PM_KIND.get(name_token)
        if fn:
            rows = [r for r in rows if fn(r.get("name", ""))]
    return rows


def _bench_score(r):
    n = r.get("name", "")
    c = r.get("cat", "")
    s = 0
    if c == "现货价格":
        s += 100
    elif c == "期货价格":
        s += 60
    elif c == "价格/行情":
        s += 20
    if "主力" in n:
        s += 40
    if "活跃" in n:
        s += 30
    if "指数" in n:
        s += 20
    if "连续" in n:
        s += 15
    if "收盘" in n:
        s += 10
    if "现货" in n:
        s += 8
    if "结算" in n:
        s += 6
    if "上期所" in n or "上海" in n or "沪" in n:
        s += 5
    # TF_ 前缀为第三方衍生序列，优先级略低但仍可用（部分品种仅 TF_ 有价格）
    if str(r.get("id", "")).startswith("TF_"):
        s -= 8
    # 明确剔除：非价格类
    if any(k in n for k in ("基差", "价差", "升贴水", "库存", "仓单", "持仓",
                            "开工", "产量", "表需", "利润", "进口", "出口",
                            "发运", "移仓", "期货", "ETF", "持仓量",
                            "资金", "净多", "净空", "比价", "内外")):
        s -= 60
    # 偏好国内盘，压低海外盘
    if any(k in n for k in ("伦敦", "COMEX", "LME", "纽约", "ICE", "新加坡",
                            "鹿特丹", "迪拜", "欧洲", "美国", "日本")):
        s -= 40
    # 压低具体合约（如 09合约 / 03合约 / 2601 等），除非是主力/指数
    if ("合约" in n or re.search(r"\d{2,4}月|\d{4}", n)) and not ("主力" in n or "指数" in n):
        s -= 35
    return s


def _pick_benchmark(rows):
    if not rows:
        return None
    best = max(rows, key=_bench_score)
    if _bench_score(best) <= 0:
        return None
    return best


def _catalog_variant(user_name):
    """目录驱动：任意品种/金属自动解析出可用规格。返回 dict 或 None。"""
    variety = _ALIAS.get(user_name)
    if not variety:
        return None
    name_token = None
    if variety == "贵金属":
        name_map = {"黄金": "黄金", "金": "黄金", "沪金": "黄金", "au": "黄金",
                    "AU": "黄金", "白银": "白银", "银": "白银", "沪银": "白银",
                    "ag": "白银", "AG": "白银", "铂金": "铂金", "铂": "铂金"}
        display = name_map.get(user_name, user_name)
        name_token = display  # 用规范金属名（黄金/白银/铂金）做过滤
    else:
        display = variety
    rows = _series_rows(variety, name_token)
    if not rows:
        return None

    bench = _pick_benchmark(rows)
    refs = [bench["id"]] if bench else []
    if bench:
        bench_b = {"label": bench.get("name", display), "refs": refs,
                   "kind": bench.get("cat", "价格"), "unit": bench.get("unit", "")}
    else:
        # 无合适基准时交给运行期搜索兜底
        bench_b = {"label": f"{display} 价格", "refs": [], "search": display,
                   "kind": "价格", "unit": ""}
    # 备选基准（用于价格图多参考）
    cands = sorted(rows, key=_bench_score, reverse=True)[:3]
    alt = [{"label": c.get("name"), "refs": [c["id"]],
            "kind": c.get("cat", ""), "unit": c.get("unit", "")}
           for c in cands if c is not bench and _bench_score(c) > 10][:2]

    # 证据分组：按类别归类（剔除基准自身），同组标签合并
    bench_id = refs[0] if refs else None
    groups = {}   # label -> rows
    order = []
    for cat in _GROUP_ORDER:
        grp = [r for r in rows if r.get("cat") == cat and r["id"] != bench_id]
        if not grp:
            continue
        label = _CAT_GROUP.get(cat, cat)
        if label not in groups:
            groups[label] = []
            order.append(label)
        groups[label].extend([(r["id"], r.get("name", r["id"])) for r in grp])
    evidence = [(g, groups[g][:6]) for g in order if groups[g]]

    # 通用图：① 价格轨迹 ② 关键指标（最多4条）
    figures = []
    if bench:
        figures.append({
            "key": "price", "window_days": 400,
            "title": f"{display} 价格轨迹",
            "ylabel": bench.get("unit", ""),
            "series": [{"ref": bench["id"], "label": bench.get("name", display),
                        "color": "#1f5cae", "lw": 2.0}],
        })
    ev_flat = [(r, l) for _g, ev in evidence for r, l in ev]
    if ev_flat:
        cols = PALETTE
        series = [{"ref": r, "label": l, "color": cols[i % len(cols)]}
                  for i, (r, l) in enumerate(ev_flat[:4])]
        figures.append({
            "key": "evidence", "window_days": 400,
            "title": f"{display} 关键指标（基差/库存/供给需求等）",
            "ylabel": "",
            "series": series,
        })

    sector = rows[0].get("sector") or ""
    return {
        "name": display, "code": display, "sector": sector,
        "group": _SECTOR_GROUP.get(sector, "综合组"), "page": "",
        "period_hint": "",
        "benchmarks": ([bench_b] + alt) if bench else [bench_b],
        "evidence": evidence, "figures": figures,
        "catalog_src": True,
    }


def generic_variant(name):
    """目录缺失时的终极回退：只做价格基准搜索 + 骨架周报。"""
    return {
        "name": name, "code": name, "sector": "", "group": "",
        "page": "", "period_hint": "",
        "benchmarks": [{"label": f"{name} 价格", "refs": [], "search": name,
                        "kind": "价格", "unit": ""}],
        "evidence": [], "figures": [],
    }


_BUILTIN = {"沥青": ASPHALT, "碳酸锂": LITHIUM, "锡": TIN}

# 每种基准可选的起点长度（按频率）
START_BY_FREQ = {"日": "365d", "周": "730d", "月": "1825d"}


_PM_CANON = {"沪金": "黄金", "au": "黄金", "AU": "黄金",
              "沪银": "白银", "ag": "白银", "AG": "白银", "银": "白银",
              "铂": "铂金"}


def get_variant(name):
    """解析品种规格：特调模板 → 目录自动解析 → 通用回退（兜底关键词归一）。"""
    raw = str(name).strip()
    key = _ALIAS.get(raw)
    if key in _BUILTIN:
        return _BUILTIN[key]
    if key:
        v = _catalog_variant(raw)
        if v is not None:
            return v
    return generic_variant(_PM_CANON.get(raw, raw))


# ---------- 目录离线查询（catalog 子命令 / Agent 使用） ----------

def list_varieties():
    """全品种清单：[{"variety","sector","count"}...]"""
    from collections import Counter
    cnt = Counter(r.get("variety") for r in _CATALOG)
    seen = {}
    for r in _CATALOG:
        seen[r.get("variety")] = r.get("sector")
    out = []
    for v in cnt:
        out.append({"variety": v, "sector": seen.get(v, ""), "count": cnt[v]})
    out.sort(key=lambda x: (-x["count"], x["variety"]))
    return out


def catalog_series(variety=None, cat=None, keyword=None, metal=None, limit=100):
    """按品种/类别/关键字过滤平台序列。返回 [{id,name,variety,cat,unit}]。"""
    out = []
    for r in _CATALOG:
        if variety and r.get("variety") != variety:
            continue
        if cat and r.get("cat") != cat:
            continue
        if metal and r.get("variety") == "贵金属":
            fn = _PM_KIND.get(metal)
            if fn and not fn(r.get("name", "")):
                continue
        if keyword and keyword not in r.get("name", ""):
            continue
        out.append({"id": r["id"], "name": r.get("name"), "cat": r.get("cat"),
                    "unit": r.get("unit", ""), "sector": r.get("sector")})
    return out[:limit]


# ---------- 目录 refresh 用：轻量分类器（把平台搜索行反推 品种/类别/板块） ----------

# 品种名 token（仅多字词，避免误判；如 沪铜/螺纹/碳酸锂/黄金/白银/棕榈油…）
_VARIETY_TOKEN = []
_seen = set()
for _tok, _var in _ALIAS.items():
    if len(_tok) >= 2 and _tok not in _seen:
        _VARIETY_TOKEN.append((_tok, _var))
        _seen.add(_tok)
for _r in _CATALOG:
    _vname = _r.get("variety") or ""
    if len(_vname) >= 2 and _vname not in _seen:
        _VARIETY_TOKEN.append((_vname, _vname))
        _seen.add(_vname)
_VARIETY_TOKEN.sort(key=lambda x: -len(x[0]))

_VARIETY_SECTOR = {}
for _r in _CATALOG:
    _v = _r.get("variety")
    if _v and _v not in _VARIETY_SECTOR and _r.get("sector"):
        _VARIETY_SECTOR[_v] = _r["sector"]

_CAT_RULES = [
    ("升贴水/基差", ["升贴水", "基差"]),
    ("仓单", ["仓单"]),
    ("库存", ["库存", "库容", "可用天数"]),
    ("持仓/资金", ["持仓", "资金", "净多", "净空", "ETF", "CFTC", "持仓量"]),
    ("进口/出口", ["进口", "出口"]),
    ("产量/供给", ["产量", "开工", "负荷", "检修", "供给", "日均产量", "排产"]),
    ("消费/需求", ["表需", "表观", "消费", "需求", "成交量", "成交", "停发", "出货量"]),
    ("物流/发运", ["发运", "到货", "运费", "运价", "物流", "航运", "船只", "船期"]),
    ("成本/利润", ["利润", "成本", "加工费", "毛利", "制造成本", "吨焦利润"]),
    ("价差", ["价差", "比价", "月差", "跨期", "内外价差", "反套", "正套"]),
    ("期货价格", ["收盘价", "结算价", "主力合约", "指数", "连续合约", "活跃合约", "收盘", "日收盘"]),
    ("现货价格", ["现货价格", "现货价", "市场价", "出厂价", "均价", "平仓价", "FOB", "CFR", "CIF"]),
]


def _classify_variety(name, kw_variety=None):
    """按名称 token 反推品种；命不中则用触发关键字对应的品种。"""
    name = name or ""
    for tok, var in _VARIETY_TOKEN:
        if tok in name:
            return var
    # 单字金属风险高（金→金步巴 铁矿），仅在触发关键字本身就是金属别名时使用
    if kw_variety:
        return kw_variety
    return None


def classify_name(name, kw_variety=None):
    """返回 (variety, cat, sector)。"""
    name = name or ""
    variety = _classify_variety(name, kw_variety)
    cat = "价格/行情"
    for cl, kws in _CAT_RULES:
        if any(k in name for k in kws):
            cat = cl
            break
    sector = _VARIETY_SECTOR.get(variety, "其他") if variety else "其他"
    return variety, cat, sector


def fmt(x):
    if x is None:
        return "—"
    try:
        f = float(x)
        if abs(f) >= 1000:
            return f"{f:,.0f}"
        if abs(f) >= 1:
            return f"{f:,.2f}".rstrip("0").rstrip(".")
        return f"{f:.4f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        return str(x)


def dstr(ms):
    if not ms:
        return "—"
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
