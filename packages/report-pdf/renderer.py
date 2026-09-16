# -*- coding: utf-8 -*-
"""RUN-19 report-pdf renderer, port of the 润洲 (Runzhou) template.

Layout, palette, cover card, header/footer, rich-text bold, coloured
blockquotes, deep-header zebra tables, bullets and centred images are ported
from dsh-runzhou-wklyreport_weknora/python/rzlib/pdfbuilder.py (Builder) so
run19 output matches the reference template.

run19-specific behaviour is preserved on top:
  * annotation marking (bold + underline) driven by the semantic block model;
  * connector reference excerpts: the leading '[id] title' line becomes a gray
    citation note rendered below the block, never inside the quote body;
  * the '- 以下为 connector ...' disclaimer is rendered as a small gray hint;
  * assets arrive as {'id': path} and are referenced as asset:<id>.

Input is a JSON object written by index.js:
  {markdown, annotations, assets([{id,path}]), fontPath, output, templateVersion, cover?}
No network/HTML/Markdown resource loader. Runtime PyMuPDF is AGPL/commercial.
"""
import json
import os
import re
import sys
from datetime import datetime
import pymupdf as fitz

if len(sys.argv) == 2 and sys.argv[1] == '--probe':
    print(json.dumps({'pymupdf': fitz.VersionBind, 'python': '.'.join(map(str, sys.version_info[:3]))}))
    sys.exit(0)

# ---- 润洲 palette (from rzlib.pdfbuilder) ----
DEEP = (0.00, 0.20, 0.40)          # 003366
DEEPER = (0.10, 0.18, 0.38)
ZEBRA = (0.94, 0.96, 0.99)
HDR2 = (0.90, 0.94, 0.99)
BEIGE = (0.99, 0.97, 0.92)
GOLD = (0.71, 0.55, 0.16)
GOLDBG = (0.995, 0.965, 0.875)
TEXT = (0.10, 0.10, 0.15)
GRAY = (0.42, 0.42, 0.48)
LIGHT = (0.60, 0.60, 0.66)
WHITE = (1, 1, 1)
RED = (0.71, 0.16, 0.16)

PAGE_W, PAGE_H = 595.0, 842.0
ML, MR, MT, MB = 44, 44, 56, 52
CW = PAGE_W - ML - MR

FULLW_PUNCT = set("，。、；：？！「」『』（）—…·　【】《》①②③④⑤⑥")


def is_wide(ch):
    return ord(ch) >= 0x2E80


def tokens_of(text, bold=False):
    out, buf = [], ""
    for ch in text:
        if is_wide(ch) or ch in FULLW_PUNCT:
            if buf:
                out.append((buf, bold))
                buf = ""
            out.append((ch, bold))
        elif ch == ' ':
            if buf:
                out.append((buf, bold))
                buf = ""
            out.append((' ', bold))
        else:
            buf += ch
    if buf:
        out.append((buf, bold))
    return out


def rich_tokens(text, marks=()):
    """Split `text` into (run, bold, hi) rich tokens.
    - `**` toggles bold (outside an annotated run only).
    - A run is `hi` (human-annotated: bold + underline) when its source char range
      overlaps any (s,e) mark span.
    - Emphasis/formatting markers (`**`, `*`, `_`, `` ` ``, `~~`) inside an `hi` run are dropped so a
      marked quote renders cleanly; markers *outside* an `hi` run stay literal (non-destructive)."""
    def hit(s, e):
        return any(not (e <= ms or s >= me) for ms, me in marks)
    out = []
    i, n, bold = 0, len(text), False
    buf = []
    def flush():
        nonlocal buf
        if not buf:
            return
        s, e = buf[0][1], buf[-1][1] + 1
        hi = hit(s, e)
        t = ''.join(c for c, _ in buf).replace('`', '')
        if hi:
            t = t.replace('~~', '').replace('**', '').replace('*', '').replace('_', '')
        out.append((t, bold, hi))
        buf.clear()
    while i < n:
        if text.startswith('**', i) and not hit(i, i + 2):
            flush(); bold = not bold; i += 2; continue
        ch = text[i]
        if is_wide(ch) or ch in FULLW_PUNCT or ch == ' ':
            flush()
            hi = hit(i, i + 1)
            if hi and ch in '*_`~':
                i += 1
                continue
            out.append((ch, bold, hi))
        else:
            buf.append((ch, i))
        i += 1
    flush()
    return out


def wrap_tokens(toks, maxw, size, font):
    lines, cur, curw = [], [], 0.0
    for tok in toks:
        t = tok[0]
        w = font.text_length(t, fontsize=size)
        if cur and curw + w > maxw:
            lines.append(cur)
            cur, curw = [], 0.0
        cur.append(tok)
        curw += w
    if cur:
        lines.append(cur)
    return lines


def nlines(toks, maxw, size, font):
    return len(wrap_tokens(toks, maxw, size, font))


# ---- run19 semantic block model (kept so annotation line ranges map to exact blocks) ----
def blocks(lines):
    result = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        start = i
        if s.startswith('```') or s.startswith('~~~'):
            marker = s[:3]
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(marker):
                i += 1
            if i >= len(lines):
                raise ValueError('unclosed code fence')
            result.append(('code', start, i, lines[start + 1:i]))
            i += 1
            continue
        if re.match(r'^#{1,6}\s', s):
            kind = 'heading'
        elif re.fullmatch(r'!\[([^\]]*)\]\(([^\s)]+)\)', s):
            kind = 'image'
        elif re.fullmatch(r'(?:---+|\*\*\*+|___+)', s):
            kind = 'rule'
        elif s.startswith('|'):
            kind = 'table'
            while i + 1 < len(lines) and lines[i + 1].strip().startswith('|'):
                i += 1
        elif s.startswith('>'):
            kind = 'blockquote'
            while i + 1 < len(lines) and lines[i + 1].strip().startswith('>'):
                i += 1
        else:
            kind = 'paragraph'
            while i + 1 < len(lines) and lines[i + 1].strip() and not re.match(r'^(#{1,6}\s|!\[|\||```|~~~|---+$)', lines[i + 1].strip()):
                i += 1
        result.append((kind, start, i, lines[start:i + 1]))
        i += 1
    return result


class Builder:
    def __init__(self, opts, fontpath):
        self.opts = opts
        self.fontpath = fontpath
        self.font = fitz.Font(fontfile=fontpath)
        self.doc = fitz.open()
        self.page = None
        self.pno = 0
        self.y = MT
        self.new_page(cover=True)

    def tw(self, s, size):
        return self.font.text_length(s, fontsize=size)

    def new_page(self, cover=False):
        if self.page is not None and not cover:
            self._footer()
        self.page = self.doc.new_page(width=PAGE_W, height=PAGE_H)
        self.pno += 1
        self.y = MT
        if not cover:
            self._header()

    def _header(self):
        self.page.draw_line(fitz.Point(ML, MT - 16), fitz.Point(PAGE_W - MR, MT - 16),
                            color=(0.85, 0.87, 0.91), width=0.6)
        htxt = self.opts.get("header_text") or "润洲投研 · 商品报告"
        self.page.insert_text((ML, MT - 28), htxt, fontname="cn", fontfile=self.fontpath,
                              fontsize=7.5, color=DEEP)

    def _footer(self):
        self.page.draw_line(fitz.Point(ML, PAGE_H - MB + 12), fitz.Point(PAGE_W - MR, PAGE_H - MB + 12),
                            color=(0.85, 0.87, 0.91), width=0.6)
        self.page.insert_text((PAGE_W / 2 - 10, PAGE_H - MB + 24), str(self.pno),
                              fontname="cn", fontfile=self.fontpath, fontsize=8, color=LIGHT)
        self.page.insert_text((ML, PAGE_H - MB + 24), "内部参考 · 仅供投研使用",
                              fontname="cn", fontfile=self.fontpath, fontsize=6.5, color=LIGHT)

    def ensure(self, h):
        if self.y + h > PAGE_H - MB:
            self.new_page()

    # ---------- cover ----------
    def cover(self, title, meta):
        o = self.opts
        self.y = 150
        self.page.insert_text((ML, 120), "内部参考", fontname="cn", fontfile=self.fontpath,
                              fontsize=9, color=GOLD)
        if o.get("big_title"):
            big = o["big_title"]
            sub = o.get("sub_title", "")
        else:
            if "：" in title:
                big, sub = title.split("：", 1)
            elif " " in title:
                bi, _, rest = title.partition(" ")
                big, sub = bi, rest
            else:
                big, sub = title, ""
        big_size = 34
        bw = self.tw(big, big_size)
        if bw > CW:
            big_size = max(16, 34 * CW / bw)
        self.page.insert_text((ML, 190), big, fontname="cn", fontfile=self.fontpath,
                              fontsize=big_size, color=DEEP)
        sub_size = 22
        sw = self.tw(sub if sub else "投研报告", sub_size)
        if sw > CW:
            sub_size = max(13, 22 * CW / sw)
        if sub:
            self.page.insert_text((ML, 238), sub, fontname="cn", fontfile=self.fontpath,
                                  fontsize=sub_size, color=DEEP)
        else:
            self.page.insert_text((ML, 238), "投研报告", fontname="cn", fontfile=self.fontpath,
                                  fontsize=sub_size, color=DEEP)
        self.page.draw_line(fitz.Point(ML, 262), fitz.Point(ML + 240, 262),
                            color=GOLD, width=2)
        self.page.insert_text((ML, 296),
                              o.get("date_line") or "2026 版  ·  数据来自本地 API（runzhou.work 镜像）",
                              fontname="cn", fontfile=self.fontpath, fontsize=11, color=GRAY)
        if o.get("keywords"):
            self.page.insert_text((ML, 334), o["keywords"], fontname="cn", fontfile=self.fontpath,
                                  fontsize=10, color=DEEP)
        card_y = 372
        card_h = len(meta) * 17 + 24
        self.page.draw_rect(fitz.Rect(ML, card_y, PAGE_W - MR, card_y + card_h),
                            color=ZEBRA, fill=ZEBRA)
        self.page.draw_rect(fitz.Rect(ML, card_y, ML + 3, card_y + card_h),
                            color=DEEP, fill=DEEP)
        yy = card_y + 18
        for m in meta:
            m = m.replace('**', '')
            toks = rich_tokens(m)
            lines = wrap_tokens(toks, CW - 28, 8.5, self.font)
            self._draw_rich(ML + 14, yy, CW - 24, toks, 8.5, TEXT, TEXT, 12)
            yy += max(len(lines), 1) * 17
        self.page.insert_text((ML, PAGE_H - 80),
                              o.get("disclaimer") or
                              "基于本地 API（runzhou.work 镜像）整合分析，仅供内部参考，不构成投资建议。",
                              fontname="cn", fontfile=self.fontpath, fontsize=8, color=LIGHT)
        self.new_page()

    # ---------- rich text draw (bold synthesis by double-draw; underline when marked) ----------
    def _draw_rich(self, x, y, maxw, toks, size, cnormal, cbold, lh, marks=()):
        lines = wrap_tokens(toks, maxw, size, self.font)
        for line in lines:
            cx = x
            linew = 0.0
            hl_start = None
            for tok in line:
                t, b, hi = tok
                left = cx
                col = cbold if (b or hi) else cnormal
                self.page.insert_text((cx, y), t, fontname="cn", fontfile=self.fontpath,
                                      fontsize=size, color=col)
                if b or hi:
                    self.page.insert_text((cx + 0.35, y), t, fontname="cn", fontfile=self.fontpath,
                                          fontsize=size, color=col)
                w = self.tw(t, size)
                cx += w
                linew += w
                if hi:
                    if hl_start is None:
                        hl_start = left
                elif hl_start is not None:
                    self.page.draw_line((hl_start, y + 1.8), (left, y + 1.8), width=0.55)
                    hl_start = None
            if hl_start is not None:
                self.page.draw_line((hl_start, y + 1.8), (x + linew, y + 1.8), width=0.55)
            y += lh
        return y

    def para(self, text, size=9, lh=13, color=TEXT, indent=0, marks=()):
        toks = rich_tokens(text, marks)
        w = CW - indent
        h = nlines(toks, w, size, self.font) * lh
        self.ensure(h)
        self._draw_rich(ML + indent, self.y, w, toks, size, color, DEEPER, lh, marks)
        self.y += h + 3

    def note(self, text, size=8.5, color=GRAY):
        toks = rich_tokens(text)
        for line in wrap_tokens(toks, CW, size, self.font):
            self.ensure(size * 1.55)
            cx = ML
            for tok in line:
                t = tok[0]
                self.page.insert_text((cx, self.y + size * 0.85), t, fontname="cn",
                                      fontfile=self.fontpath, fontsize=size, color=color)
                cx += self.tw(t, size)
            self.y += size * 1.55
        self.y += 3

    def h2(self, text, marked=False):
        text = text.replace('**', '')
        self.ensure(36)
        if self.y > MT + 10:
            self.y += 8
        self.page.draw_rect(fitz.Rect(ML, self.y - 13, ML + 3.5, self.y + 15),
                            color=DEEP, fill=DEEP)
        col = DEEPER if marked else DEEP
        self.page.insert_text((ML + 11, self.y), text, fontname="cn", fontfile=self.fontpath,
                              fontsize=14, color=col)
        if marked:
            self.page.insert_text((ML + 11.35, self.y), text, fontname="cn", fontfile=self.fontpath,
                                  fontsize=14, color=col)
            self.page.draw_line((ML + 11, self.y + 2), (ML + 11 + self.tw(text, 14), self.y + 2), width=0.55)
        self.y += 22
        self.page.draw_line(fitz.Point(ML, self.y), fitz.Point(PAGE_W - MR, self.y),
                            color=(0.78, 0.82, 0.88), width=0.8)
        self.y += 10

    def h3(self, text, marked=False):
        text = text.replace('**', '')
        self.ensure(26)
        self.y += 6
        col = DEEPER if marked else DEEP
        self.page.insert_text((ML, self.y), text, fontname="cn", fontfile=self.fontpath,
                              fontsize=11.5, color=col)
        if marked:
            self.page.insert_text((ML + 0.35, self.y), text, fontname="cn", fontfile=self.fontpath,
                                  fontsize=11.5, color=col)
            self.page.draw_line((ML, self.y + 2), (ML + self.tw(text, 11.5), self.y + 2), width=0.55)
        self.y += 19

    def h4(self, text, marked=False):
        text = text.replace('**', '')
        self.ensure(22)
        self.y += 4
        col = DEEPER if marked else DEEPER
        self.page.insert_text((ML, self.y), text, fontname="cn", fontfile=self.fontpath,
                              fontsize=10, color=col)
        if marked:
            self.page.insert_text((ML + 0.35, self.y), text, fontname="cn", fontfile=self.fontpath,
                                  fontsize=10, color=col)
            self.page.draw_line((ML, self.y + 2), (ML + self.tw(text, 10), self.y + 2), width=0.55)
        self.y += 16

    def hr(self):
        self.ensure(18)
        self.y += 4
        self.page.draw_line(fitz.Point(ML, self.y), fitz.Point(PAGE_W - MR, self.y),
                            color=GOLD, width=1.2)
        self.y += 12

    def blockquote(self, lines, marked=False):
        text = " ".join(l.strip() for l in lines)
        text = text.replace('**', '')
        joined = "".join(text)
        if "口述" in joined or text.strip().startswith('"'):
            kind = 'beige'
        elif any(k in joined for k in ["数据口径备注", "呈现形式小结", "骨架依据", "图表原则", "来源数据"]):
            kind = 'meta'
        else:
            kind = 'gold'
        size = 8.5 if kind != 'meta' else 7.8
        lh = 12 if kind != 'meta' else 11
        pad = 10
        marks = [(0, len(text))] if marked else []
        toks = rich_tokens(text, marks)
        w = CW - 18 - pad
        n = nlines(toks, w, size, self.font)
        h = n * lh + 12
        self.ensure(h)
        if kind == 'gold':
            self.page.draw_rect(fitz.Rect(ML, self.y - 2, PAGE_W - MR, self.y + h - 4),
                                color=GOLDBG, fill=GOLDBG)
            self.page.draw_rect(fitz.Rect(ML, self.y - 2, ML + 3, self.y + h - 4), color=GOLD, fill=GOLD)
            self._draw_rich(ML + 13, self.y + 9, w, toks, size, DEEPER, DEEPER, lh, marks)
        elif kind == 'beige':
            self.page.draw_rect(fitz.Rect(ML, self.y - 2, PAGE_W - MR, self.y + h - 4),
                                color=BEIGE, fill=BEIGE)
            self.page.draw_rect(fitz.Rect(ML, self.y - 2, ML + 3, self.y + h - 4), color=GOLD, fill=GOLD)
            self._draw_rich(ML + 13, self.y + 9, w, toks, size, TEXT, TEXT, lh, marks)
        else:
            self.page.draw_rect(fitz.Rect(ML, self.y - 2, PAGE_W - MR, self.y + h - 4),
                                color=(0.96, 0.96, 0.97), fill=(0.96, 0.96, 0.97))
            self.page.draw_rect(fitz.Rect(ML, self.y - 2, ML + 3, self.y + h - 4), color=LIGHT, fill=LIGHT)
            self._draw_rich(ML + 13, self.y + 9, w, toks, size, GRAY, GRAY, lh, marks)
        self.y += h + 4

    # ---------- table ----------
    def _cell_lines(self, text, w, size):
        text = text.replace('**', '').replace('`', '')
        toks = tokens_of(text)
        return wrap_tokens(toks, w, size, self.font)

    def _row_h(self, cells, widths, size, lh):
        mx = 1
        for c, wd in zip(cells, widths):
            if wd <= 8:
                continue
            n = len(self._cell_lines(c, wd - 8, size))
            mx = max(mx, n)
        return mx * lh + 6

    def table(self, header, rows, marked=False, row_lines=None):
        ncol = len(header)
        weights = []
        for c in range(ncol):
            mx = len(header[c].replace('**', ''))
            for r in rows:
                mx = max(mx, len(r[c].replace('**', '')))
            weights.append((mx + 1) ** 0.5)
        sw = sum(weights)
        widths = [CW * w / sw for w in weights]
        for c in range(ncol):
            widths[c] = max(widths[c], 24.0)
        sw2 = sum(widths)
        if sw2 > CW:
            widths = [w * CW / sw2 for w in widths]
        size = 8.0
        lh = 11.0
        head_h = 20

        def draw_header(y):
            self.page.draw_rect(fitz.Rect(ML, y - 13, PAGE_W - MR, y + head_h - 13),
                                color=DEEP, fill=DEEP)
            x = ML
            for c in range(ncol):
                t = header[c].replace('**', '')
                self.page.insert_text((x + 4, y), t, fontname="cn", fontfile=self.fontpath,
                                      fontsize=size, color=WHITE)
                x += widths[c]
            return y + head_h

        self.ensure(head_h + 6)
        y = self.y
        y = draw_header(y)
        for ri, r in enumerate(rows):
            cells = [c.replace('**', '') for c in r]
            rh = self._row_h(cells, widths, size, lh)
            if y + rh > PAGE_H - MB:
                self.new_page()
                self.ensure(head_h + 6)
                y = draw_header(self.y)
                rh = self._row_h(cells, widths, size, lh)
            is_total = r[0].startswith('**')
            if is_total:
                self.page.draw_rect(fitz.Rect(ML, y - 9, PAGE_W - MR, y + rh - 9),
                                    color=HDR2, fill=HDR2)
            elif ri % 2 == 1:
                self.page.draw_rect(fitz.Rect(ML, y - 9, PAGE_W - MR, y + rh - 9),
                                    color=ZEBRA, fill=ZEBRA)
            x = ML
            for c in range(ncol):
                lines = self._cell_lines(cells[c], widths[c] - 8, size)
                yy = y
                for ln in lines:
                    cx = x
                    for t, b in ln:
                        col = DEEPER if (marked or is_total) else TEXT
                        self.page.insert_text((cx + 4, yy), t, fontname="cn", fontfile=self.fontpath,
                                              fontsize=size, color=col)
                        if marked or is_total:
                            self.page.insert_text((cx + 4.35, yy), t, fontname="cn", fontfile=self.fontpath,
                                                  fontsize=size, color=col)
                        cx += self.tw(t, size)
                    yy += lh
                x += widths[c]
            y += rh
        self.y = y + 6

    # ---------- list ----------
    def list_item(self, marker, text, indent, marks=()):
        size = 9
        lh = 13
        toks = rich_tokens(text, marks)
        w = CW - indent - 16
        n = nlines(toks, w, size, self.font)
        h = n * lh
        self.ensure(h)
        x0 = ML + indent
        self.page.insert_text((x0, self.y), marker, fontname="cn", fontfile=self.fontpath,
                              fontsize=size, color=DEEP)
        self._draw_rich(x0 + 16, self.y, w, toks, size, TEXT, DEEPER, lh, marks)
        self.y += h + 1

    # ---------- image ----------
    def image(self, path, caption=None):
        if not os.path.exists(path):
            absp = os.path.abspath(path)
            if not os.path.exists(absp):
                self.para("[缺图] %s" % path, size=7, color=RED)
                return 0
            path = absp
        try:
            pix = fitz.Pixmap(path)
            w, h = pix.width, pix.height
        except Exception:
            self.para("[缺图] %s" % path, size=7, color=RED)
            return 0
        target_w = CW
        target_h = target_w * h / w
        cap_h = 16 if caption else 0
        if target_h > PAGE_H - MB - self.y - 16 - cap_h:
            usable = PAGE_H - MB - 16 - cap_h
            if usable < 160:
                self.new_page()
                usable = PAGE_H - MB - 16 - cap_h
            scale = usable / h
            target_w = w * scale
            target_h = h * scale
            if target_w > CW:
                scale = CW / w
                target_w = CW
                target_h = h * scale
        self.ensure(target_h + 12 + cap_h)
        x0 = ML + (CW - target_w) / 2
        self.page.insert_image(fitz.Rect(x0, self.y, x0 + target_w, self.y + target_h),
                               pixmap=pix)
        self.y += target_h + 4
        if caption:
            cwidth = self.tw(caption, 7.5)
            self.page.insert_text((ML + max(0, (CW - cwidth) / 2), self.y + 8), caption,
                                  fontname="cn", fontfile=self.fontpath, fontsize=7.5, color=GRAY)
            self.y += 16
        self.y += 6
        return 1


def _find_marks(text, quotes):
    """Map an annotation's quote substring(s) onto (s,e) char offsets in `text`."""
    marks = []
    for q in quotes:
        if not isinstance(q, str) or not q:
            continue
        start = 0
        while start <= len(text):
            pos = text.find(q, start)
            if pos < 0:
                break
            marks.append((pos, pos + len(q)))
            start = pos + 1
    return marks


def render_paragraph(pdf, lines, marked=False, quotes=()):
    """Render a run19 'paragraph' block, honouring bullets, the connector
    disclaimer and rich text, while highlighting only the annotated sub-span (quote)
    so emphasis markers in the surrounding text do not over-mark the whole block."""
    buf = []

    def flush():
        if buf:
            text = ' '.join(l.strip() for l in buf)
            mks = _find_marks(text, quotes)
            if marked and not mks:
                mks = [(0, len(text))]
            pdf.para(text, marks=mks)
            buf.clear()

    for line in lines:
        s = line.strip()
        if not s:
            continue
        if re.match(r'^\s*-\s*以下为', s):
            flush()
            pdf.note(s.lstrip('- ').strip())
            continue
        # Footnote citation for a cited WeKnora source: render as a small gray note.
        m = re.match(r'^\s*〔\s*\d+\s*〕来源', s)
        if m:
            flush()
            pdf.note(s, size=8, color=GRAY)
            continue
        m = re.match(r'^(\s*)[-*]\s+(.*)$', s)
        if m:
            flush()
            mks = _find_marks(m.group(2), quotes)
            if marked and not mks:
                mks = [(0, len(m.group(2)))]
            pdf.list_item('•', m.group(2), len(m.group(1)) * 7, mks)
            continue
        m = re.match(r'^(\s*)(\d+)\.\s+(.*)$', s)
        if m:
            flush()
            mks = _find_marks(m.group(3), quotes)
            if marked and not mks:
                mks = [(0, len(m.group(3)))]
            pdf.list_item(m.group(2) + '.', m.group(3), len(m.group(1)) * 7, mks)
            continue
        buf.append(line)
    flush()


def main(request):
    lines = request['markdown'].split('\n')
    parsed = blocks(lines)
    annotations = request['annotations']
    marked = set()
    block_quotes = {}   # block index -> list of annotation quote strings (for precise sub-span highlight)
    for a in annotations:
        start, end = a['target']['startLine'] - 1, a['target']['endLine'] - 1
        matched = [idx for idx, (_, bs, be, _) in enumerate(parsed) if bs >= start and be <= end]
        if not matched or parsed[matched[0]][1] != start or parsed[matched[-1]][2] != end:
            raise ValueError('ANNOTATION_BLOCK_BOUNDARY_REQUIRED')
        if any(parsed[idx][0] in ('image', 'rule') for idx in matched):
            raise ValueError('ANNOTATION_NON_TEXT_BLOCK')
        quote = (a.get('target') or {}).get('quote')
        marked.update(matched)
        if isinstance(quote, str) and quote:
            for idx in matched:
                block_quotes.setdefault(idx, []).append(quote)

    assets = {a['id']: a['path'] for a in request['assets']}
    warnings = set()
    if re.search(r'(\$|\[\^|~~|\*[^*\n]+\*|_[^_\n]+_|^\s*-\s*\[[ xX]\])', request['markdown'], re.M):
        warnings.add('LIMITED_MARKDOWN: advanced/inline GFM or math syntax is preserved literally, not fully interpreted')

    # ---- cover derivation: '# title' + following '>' meta block (like rzlib build) ----
    cover = request.get('cover') or {}
    i = 0
    while i < len(lines) and not lines[i].startswith('# '):
        i += 1
    if i < len(lines):
        title = lines[i][2:].strip()
    else:
        title = cover.get('big_title') or '润洲商品投研报告'
    i += 1
    meta = []
    while i < len(lines) and (lines[i].strip() == '' or lines[i].lstrip().startswith('>')):
        s = lines[i].strip()
        if s.startswith('>'):
            meta.append(s[1:].strip())
        i += 1
    cover_end = i  # lines[0:cover_end] consumed by the cover card

    opts = {
        'big_title': cover.get('big_title') or '',
        'sub_title': cover.get('sub_title') or '',
        'date_line': cover.get('date_line') or '',
        'keywords': cover.get('keywords') or '',
        'header_text': cover.get('header_text') or '润洲投研 · 商品报告',
        'disclaimer': cover.get('disclaimer') or '基于本地 API（runzhou.work 镜像）整合分析，仅供内部参考，不构成投资建议。',
    }

    pdf = Builder(opts, request['fontPath'])
    pdf.cover(title, meta)

    images = 0
    for idx, (kind, start, end, content) in enumerate(parsed):
        if start < cover_end:
            continue  # already consumed by the cover card
        text = '\n'.join(content)
        is_marked = idx in marked
        if kind == 'heading':
            level = len(content[0]) - len(content[0].lstrip('#'))
            h = content[0].strip().lstrip('#').strip()
            if level <= 2:
                pdf.h2(h, is_marked)
            elif level == 3:
                pdf.h3(h, is_marked)
            else:
                pdf.h4(h, is_marked)
        elif kind == 'table':
            if '\\|' in text:
                raise ValueError('escaped table pipes unsupported')
            rows = [l.strip() for l in content]
            header = [c.strip() for c in rows[0].strip('|').split('|')]
            data = []
            for bl in rows[1:]:
                cells = [c.strip() for c in bl.strip('|').split('|')]
                if all(re.fullmatch(r':?-{2,}:?', c or '-') for c in cells):
                    continue
                if len(cells) == len(header):
                    data.append(cells)
            pdf.table(header, data, is_marked)
        elif kind == 'image':
            match = re.fullmatch(r'!\[([^\]]*)\]\(([^\s)]+)\)', text.strip())
            asset_id = match[2].removeprefix('asset:')
            images += pdf.image(assets[asset_id], caption=match[1] or None)
        elif kind == 'rule':
            pdf.hr()
        elif kind == 'blockquote':
            stripped = [re.sub(r'^\s*>\s?', '', l) for l in content]
            source = None
            body = []
            for li, line in enumerate(stripped):
                if li == 0 and re.match(r'^\[[^\]]+\]\s*', line.strip()):
                    source = line.strip()
                    continue
                body.append(line)
            if body and any(b.strip() for b in body):
                pdf.blockquote([b for b in body if b.strip()], is_marked)
            if source:
                pdf.note('来源：' + source, size=8, color=GRAY)
        elif kind == 'code':
            warnings.add('LIMITED_MARKDOWN: fenced code is rendered as literal CJK-font text without syntax highlighting')
            pdf.note('\n'.join(content).strip(), size=8, color=TEXT)
        else:
            render_paragraph(pdf, content, is_marked, block_quotes.get(idx) or ())

    # ---- annotation source footer ----
    sources = sorted(set((a['completedAt'], a['displayName']) for a in annotations))
    for timestamp, author in sources:
        if not timestamp or not author:
            warnings.add('ANNOTATION_IDENTITY_OR_TIME_UNCONFIRMED: source footer is provisional')
        display_time = timestamp
        if timestamp and 'T' in timestamp:
            try:
                parsed_time = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                display_time = parsed_time.strftime('%Y-%m-%d-%H-%M')
            except ValueError:
                warnings.add('ANNOTATION_TIME_FORMAT_INVALID: supplied timestamp preserved')
        pdf.note('加粗下划线为人工注释（来自%s 用户%s）' % (display_time or '时间未确认', author or '身份未确认'),
                 size=8.5, color=LIGHT)

    pdf._footer()
    try:
        pdf.doc.subset_fonts()
    except Exception as e:
        sys.stderr.write('subset warn: %s\n' % e)
    os.makedirs(os.path.dirname(os.path.abspath(request['output'])), exist_ok=True)
    pdf.doc.save(request['output'], deflate=True)
    pdf.doc.close()
    with fitz.open(request['output']) as check:
        pages = len(check)
        embedded = sum(len(p.get_images()) for p in check)
        if images and not embedded:
            raise ValueError('image verification failed')
    return {'pages': pages, 'imageCount': images, 'markedBlocks': len(marked), 'warnings': sorted(warnings)}


if __name__ == '__main__':
    try:
        with open(sys.argv[1], encoding='utf-8') as stream:
            result = main(json.load(stream))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(str(error) if str(error).startswith('ANNOTATION_') else 'RENDER_ERROR', file=sys.stderr)
        sys.exit(1)
