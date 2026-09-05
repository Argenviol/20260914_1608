# -*- coding: utf-8 -*-
"""증강 '구현표' 엑셀 생성.

손으로 적지 않고 game/src/augments.js 를 직접 읽어서
 - 각 증강이 어떤 훅으로 구현됐는지
 - 어떤 조건에서 잠기는지(발동 불가)
를 뽑아낸다. 코드가 바뀌면 다시 돌리면 된다.

  python build_impl_xlsx.py   ->  docs/무제체스_증강_구현표.xlsx
"""
import io
import os
import re

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from augment_data import AUGMENTS, PIECES, TIERS, TERM_STYLES, terms_in

HERE = os.path.dirname(os.path.abspath(__file__))
JS = os.path.normpath(os.path.join(HERE, "..", "game", "src", "augments.js"))
OUT = os.path.normpath(os.path.join(HERE, "..", "docs", "무제체스_증강_구현표.xlsx"))

HOOKS = [
    ("onGain", "획득 즉시"),
    ("onCapture", "처치했을 때"),
    ("onAfterMove", "이동 직후"),
    ("onTurnStart", "내 턴 시작"),
    ("onOppMoved", "상대가 둔 직후"),
    ("onCheck", "체크당했을 때"),
    ("onSched", "예약 발동"),
    ("onExpire", "효과 만료"),
    ("tick", "매 턴 지속"),
    ("canActivate", "수동 발동 가능 판정"),
    ("activate", "수동 발동"),
]
HOOK_KO = dict(HOOKS)


def read_js():
    return io.open(JS, encoding="utf-8").read()


def block_of(src, start):
    """start 위치의 '{' 부터 짝이 맞는 '}' 까지 잘라낸다."""
    i = src.index("{", start)
    depth, j = 0, i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
        j += 1
    return src[i:]


def parse_hooks(src):
    """def('ID', { ... }) 에서 쓰인 훅 이름을 뽑는다."""
    out = {}
    for m in re.finditer(r"def\('([A-Z]\d+[a-z])',\s*", src):
        aid = m.group(1)
        body = block_of(src, m.end() - 1)
        found = []
        for h, _ in HOOKS:
            if re.search(r"(?:^|[\s{,])(?:async\s+)?" + h + r"\s*\(", body):
                found.append(h)
        out[aid] = found
    return out


def josa_i_ga(word):
    c = ord(word[-1])
    if not (0xac00 <= c <= 0xd7a3):
        return "가"
    return "이" if (c - 0xac00) % 28 else "가"


def lock_of(a, blocks):
    """명시적 잠금 조건이 없으면 기본 규칙(그 기물이 없으면 잠금)을 적어준다."""
    if a["id"] in blocks:
        return blocks[a["id"]]
    if a["piece"] == "킹":
        return ""
    return f'아군 {a["piece"]}{josa_i_ga(a["piece"])} 없습니다 (기본 규칙)'


def parse_blocks(src):
    """BLOCK = { ID: (G, s) => ... } 에서 잠금 조건 설명을 뽑는다."""
    out = {}
    i = src.find("const BLOCK = {")
    if i < 0:
        return out
    body = block_of(src, i)
    # 각 항목: 두 칸 들여쓰기 + ID:
    for m in re.finditer(r"\n    ([A-Z]\d+[a-z]):\s*", body):
        aid = m.group(1)
        nxt = body.find("\n    ", m.end())
        entry = body[m.end(): nxt if nxt > 0 else len(body)]
        # 사람이 읽을 사유 문자열(마지막 한글 문자열)을 찾는다
        reasons = re.findall(r"'([^']*[가-힣][^']*)'", entry)
        out[aid] = reasons[-1] if reasons else "(조건 있음)"
    return out


# ───────────────── 스타일 ─────────────────
HDR = PatternFill("solid", fgColor="2F3E56")
HDR_FONT = Font(color="FFFFFF", bold=True, size=11)
THIN = Side(style="thin", color="BFBFBF")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
FILL_AUTO = PatternFill("solid", fgColor="E2EFDA")     # 자동
FILL_TARGET = PatternFill("solid", fgColor="DDEBF7")   # 대상 지정
FILL_LOCK = PatternFill("solid", fgColor="FCE4EC")     # 잠금 조건 있음


def style_header(ws, row=1, upto=None):
    upto = upto or ws.max_column
    for c in range(1, upto + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HDR
        cell.font = HDR_FONT
        cell.alignment = CENTER
        cell.border = BOX
    ws.freeze_panes = ws.cell(row=row + 1, column=1)


def widths(ws, spec):
    for col, w in spec.items():
        ws.column_dimensions[col].width = w


def main():
    src = read_js()
    hooks = parse_hooks(src)
    blocks = parse_blocks(src)

    wb = Workbook()
    wb.remove(wb.active)

    # ═══ 1. 구현 격자 (원본 시트와 같은 기물 × 티어 배치) ═══
    ws = wb.create_sheet("구현 격자")
    ws["A1"] = "무제체스 증강 구현표 — 기물 × 처치수"
    ws["A1"].font = Font(bold=True, size=16, color="2F3E56")
    ws["A2"] = ("원본 증강표와 같은 배치입니다. 칸마다 선택지가 3개이고, 게임에서는 "
                "처치한 기물의 칸 하나를 그대로 펼쳐 그중 1개만 고릅니다.")
    ws["A2"].alignment = WRAP
    ws.merge_cells("A2:E2")
    ws.row_dimensions[2].height = 30

    r = 4
    ws.cell(row=r, column=1, value="기물")
    for i, t in enumerate(TIERS):
        ws.cell(row=r, column=2 + i, value=f"{t}개 처치")
    style_header(ws, row=r, upto=5)
    r += 1

    for piece in PIECES:
        rows = max(len(([a for a in AUGMENTS if a["piece"] == piece and a["tier"] == t]))
                   for t in TIERS)
        start = r
        for i in range(rows):
            ws.cell(row=r + i, column=1, value=piece if i == 0 else None)
            for j, t in enumerate(TIERS):
                opts = [a for a in AUGMENTS if a["piece"] == piece and a["tier"] == t]
                cell = ws.cell(row=r + i, column=2 + j)
                if i < len(opts):
                    a = opts[i]
                    hk = hooks.get(a["id"], [])
                    hk_ko = " / ".join(HOOK_KO[h] for h in hk) or "패시브 (엔진이 직접 처리)"
                    lock = lock_of(a, blocks)
                    txt = f"[{a['id']}] {a['text']}\n\n▸ 발동 시점: {hk_ko}"
                    if a["impl"] == "target":
                        txt += "\n▸ 대상 지정 필요"
                    if lock:
                        txt += f"\n▸ 잠금 조건: {lock}"
                    tm = terms_in(a["text"], a["secret"])
                    if tm:
                        txt += "\n▸ 용어: " + " ".join("#" + x for x in tm)
                    cell.value = txt
                    cell.fill = (FILL_LOCK if lock else
                                 (FILL_TARGET if a["impl"] == "target" else FILL_AUTO))
                cell.alignment = WRAP
                cell.border = BOX
            ws.cell(row=r + i, column=1).border = BOX
        ws.merge_cells(start_row=start, start_column=1, end_row=start + rows - 1, end_column=1)
        ws.cell(row=start, column=1).alignment = CENTER
        ws.cell(row=start, column=1).font = Font(bold=True, size=12)
        for i in range(rows):
            ws.row_dimensions[r + i].height = 118
        r += rows

    r += 1
    ws.cell(row=r, column=1, value="범례").font = Font(bold=True)
    r += 1
    for fill, label in [(FILL_AUTO, "자동 — 조건이 맞으면 알아서 발동"),
                        (FILL_TARGET, "대상 지정 — 플레이어가 칸/기물을 고름"),
                        (FILL_LOCK, "잠금 조건 있음 — 못 쓰는 상황이면 드래프트에서 ✕ 처리")]:
        ws.cell(row=r, column=1).fill = fill
        ws.cell(row=r, column=1).border = BOX
        ws.cell(row=r, column=2, value=label).alignment = WRAP
        r += 1

    widths(ws, {"A": 12, "B": 52, "C": 52, "D": 52, "E": 52})

    # ═══ 2. 구현 목록 (필터 가능한 표) ═══
    ws2 = wb.create_sheet("구현 목록")
    cols = ["ID", "기물", "티어", "지속형태", "비밀", "증강 문구",
            "발동 시점(훅)", "대상 지정", "잠금 조건", "용어"]
    ws2.append(cols)
    style_header(ws2)
    order = {p: i for i, p in enumerate(PIECES)}
    for a in sorted(AUGMENTS, key=lambda x: (order[x["piece"]], TIERS.index(x["tier"]), x["id"])):
        hk = hooks.get(a["id"], [])
        lock = lock_of(a, blocks)
        ws2.append([
            a["id"], a["piece"], a["tier"], a["tag"], "O" if a["secret"] else "",
            a["text"],
            " / ".join(HOOK_KO[h] for h in hk) or "패시브 (엔진이 직접 처리)",
            "O" if a["impl"] == "target" else "",
            lock,
            " ".join("#" + x for x in terms_in(a["text"], a["secret"])),
        ])
    for row in ws2.iter_rows(min_row=2):
        for c in row:
            c.alignment = WRAP
            c.border = BOX
        ws2.row_dimensions[row[0].row].height = 56
    widths(ws2, {"A": 8, "B": 9, "C": 7, "D": 11, "E": 7, "F": 64,
                 "G": 26, "H": 10, "I": 40, "J": 18})
    ws2.auto_filter.ref = f"A1:J{ws2.max_row}"

    # ═══ 3. 훅 설명 ═══
    ws3 = wb.create_sheet("구조 설명")
    ws3["A1"] = "증강은 어떻게 구현되어 있나"
    ws3["A1"].font = Font(bold=True, size=14, color="2F3E56")
    ws3.append([])
    ws3.append(["항목", "설명"])
    style_header(ws3, row=3)
    notes = [
        ("한 줄 요약",
         "증강 73종은 game/src/augments.js 안에 '훅' 으로 구현되어 있습니다. "
         "게임 진행 중 특정 시점(획득·처치·이동·턴 시작 등)이 되면 해당 시점에 등록된 증강이 실행됩니다."),
        ("드래프트 방식",
         "처치 카운트가 1·3·6·11 에 닿으면, 방금 처치한 기물의 칸(기물×티어)에 있는 선택지 3개를 "
         "그대로 펼쳐 보여주고 그중 1개만 고릅니다. 원본 증강표가 칸마다 3개씩 두고 있는 구조를 그대로 따랐습니다."),
        ("잠금 조건",
         "지금 발동해도 아무 일이 일어나지 않는 증강은 고를 수 없게 막고 빨간 ✕ 로 표시합니다. "
         "기본 규칙은 '해당 기물이 판에 하나도 없으면 잠금' 이고, 그 밖의 개별 조건은 '잠금 조건' 칸에 있습니다."),
        ("자동 발동 추적",
         "증강 훅을 실행하기 전후로 판을 통째로 비교해, 바뀐 칸을 자동으로 찾아냅니다. "
         "그래서 73종 전부에 따로 코드를 넣지 않아도 '어느 증강 때문에 무엇이 바뀌었는지' 를 화면에 표시할 수 있습니다."),
        ("패시브 증강",
         "이동 규칙 자체를 바꾸는 증강(예: 룩이 기물을 통과, 폰이 뒤로 이동)은 훅이 아니라 "
         "체스 엔진의 이동 생성기(engine.js)가 직접 읽습니다. 표에서 '패시브' 로 표시된 것들입니다."),
        ("용어",
         "지정불가 · 제거 · 교환 · 포영 · 변이 · 비밀 여섯 가지를 용어로 정의하고, "
         "증강 문구 안의 용어와 카드 아래 #태그를 같은 색으로 칠합니다. "
         "'처치' 도 용어지만 거의 모든 증강에 나와서 태그로는 달지 않았습니다."),
        ("이 파일은 자동 생성",
         "tools/build_impl_xlsx.py 가 augments.js 를 직접 읽어서 만듭니다. "
         "코드를 고친 뒤 다시 돌리면 표도 같이 갱신됩니다."),
    ]
    for k, v in notes:
        ws3.append([k, v])
    for row in ws3.iter_rows(min_row=4):
        for c in row:
            c.alignment = WRAP
            c.border = BOX
        ws3.row_dimensions[row[0].row].height = 62
    widths(ws3, {"A": 20, "B": 108})

    # ═══ 4. 용어 색상 ═══
    ws4 = wb.create_sheet("용어 색상")
    ws4.append(["용어", "글자색", "배경색", "쓰이는 증강 수"])
    style_header(ws4)
    for term, st in TERM_STYLES.items():
        n = sum(1 for a in AUGMENTS if term in terms_in(a["text"], a["secret"]))
        ws4.append([term, st["fg"], st["bg"], n])
        cell = ws4.cell(row=ws4.max_row, column=1)
        cell.fill = PatternFill("solid", fgColor=st["bg"].lstrip("#"))
        cell.font = Font(color=st["fg"].lstrip("#"), bold=True)
    for row in ws4.iter_rows(min_row=2):
        for c in row:
            c.border = BOX
    widths(ws4, {"A": 14, "B": 12, "C": 12, "D": 16})

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    wb.save(OUT)
    print("saved:", OUT)
    print("sheets:", wb.sheetnames)
    passive = [a["id"] for a in AUGMENTS if not hooks.get(a["id"])]
    print(f"훅으로 구현: {len(AUGMENTS) - len(passive)}종 / 패시브: {len(passive)}종 {passive}")
    print(f"잠금 조건이 명시된 증강: {len(blocks)}종")


if __name__ == "__main__":
    main()
