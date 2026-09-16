#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rzlib.runzhou_api — 润洲数据客户端（本地 API 版）

默认连接本地 API（http://127.0.0.1:5100，runzhou.work 镜像），该服务已内置登录，
因此本客户端无需账号/密码，也不执行登录请求；`RUNZHOU_BASE` 可覆盖平台地址。

本地 API 契约（注意：不是 /trpc）：
    GET  /health                    探活（已登录）
    GET  /defs?search=<kw>          搜索数据项（参数名 search）
    GET  /defs/{id}                 取数据项定义
    GET  /defs/{id}/values?start=&end=   取时间序列（毫秒时间戳，可省略）
    全部只读。

用法：
    import rzlib.runzhou_api as rz
    rows = rz.search_defs("锡", 10)
    pts = rz.pull_series("SN9999", "2026-09-01", "2026-09-08")
"""
import json, os, sys, time, datetime as _dt, urllib.parse, urllib.request, urllib.error

BASE = os.environ.get("RUNZHOU_BASE", "http://127.0.0.1:5100")
_USER = os.environ.get("RUNZHOU_USER", "")
_PASS = os.environ.get("RUNZHOU_PASS", "")
_CACHE = os.environ.get("RUNZHOU_CACHE", os.path.join(os.path.expanduser("~"), ".runzhou"))
_COOKIE_FILE = os.environ.get("RUNZHOU_COOKIE_FILE", os.path.join(_CACHE, "cookies.txt"))


def configure(user=None, password=None, base=None, cookie_file=None):
    """显式注入连接配置；省略项保持现有值。已无需账号密码，保留 user/password 仅兼容旧配置。"""
    global _USER, _PASS, BASE, _COOKIE_FILE
    if user is not None:
        _USER = user
    if password is not None:
        _PASS = password
    if base is not None:
        BASE = base.rstrip("/")
    if cookie_file is not None:
        _COOKIE_FILE = cookie_file


def have_credentials():
    # 本地 API（http://127.0.0.1:5100，runzhou.work 镜像）已内置登录，无需账号密码。
    return True


def _request(method, path, body=None, timeout=90, cookie=None):
    headers = {"Cookie": cookie} if cookie else {}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw), dict(resp.headers), resp.headers.get("Set-Cookie")


def login(cookie_file=None):
    """本地 API 已内置登录，无需账号密码；此处仅做可达性校验（GET /health）。
    返回空串（本地服务不要求会话 cookie）。"""
    _request("GET", "/health")  # 本地 API 不可达/异常时抛错
    return ""


def _ms(s):
    """把 'YYYY-MM-DD' 日期字符串或毫秒时间戳转成 UTC 毫秒时间戳；None 原样返回。"""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(s)
    ss = str(s).strip()
    if ss.isdigit():
        return int(ss)
    d = _dt.datetime.strptime(ss[:10], "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc)
    return int(d.timestamp() * 1000)


def search_defs(keyword, limit=20):
    """搜索数据项（本地 API：GET /defs?search=<kw>），返回 def 列表。"""
    q = urllib.parse.quote(keyword, safe="")
    out, _h, _sc = _request("GET", f"/defs?search={q}")
    rows = out if isinstance(out, list) else []
    return rows[:limit]


def pull_series(ref_id, start, end):
    """拉单条时序（本地 API：GET /defs/{id}/values?start=&end=）-> [(ts_ms, value), ...]"""
    ref = urllib.parse.quote(str(ref_id), safe="")
    path = f"/defs/{ref}/values"
    parts = []
    s, e = _ms(start), _ms(end)
    if s is not None:
        parts.append(f"start={s}")
    if e is not None:
        parts.append(f"end={e}")
    if parts:
        path += "?" + "&".join(parts)
    out, _h, _sc = _request("GET", path)
    pts = []
    for it in (out or []):
        t, v = it.get("time"), it.get("value")
        if t is not None and v is not None:
            pts.append((int(t), v))
    return pts


def pull_many(ids, start, end):
    """拉多条时序（逐条请求，本地 API）-> {sid: [(ts_ms, v)...]}"""
    if not ids:
        return {}
    res = {}
    for sid in ids:
        try:
            res[sid] = pull_series(sid, start, end)
        except Exception as ex:
            print(f"  [warn] {sid} 拉取失败: {ex}", file=sys.stderr)
            res[sid] = []
    return res


if __name__ == "__main__":
    print("health ok:", login() == "")
    for r in search_defs("锡", 5):
        print(r.get("id"), r.get("name"), r.get("unit", ""))
