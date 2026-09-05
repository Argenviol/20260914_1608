# -*- coding: utf-8 -*-
"""augment_data.py -> docs/무제체스_증강표_v2.xlsx 생성"""
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

from augment_data import (
    AUGMENTS, PIECES, TIERS, GLOBAL_RULES, GLOSSARY,
    BALANCE_KILL, BALANCE_PIECE, BALANCE_POPULAR, by_cell, changed,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "docs", "무제체스_증강표_v2.xlsx"))

# 원본 시트의 색깔별 의미
TAG_FILL = {
    "턴제한":   "FFF2CC",   # 노랑
    "횟수제한": "DDEBF7",   # 파랑
    "영구지속": "E2EFDA",   # 초록
    "해당없음": "F2F2F2",
}
HDR = PatternFill("solid", fgColor="2F3E56")
HDR_FONT = Font(color="FFFFFF", bold=True, size=11)
CHANGED_FILL = PatternFill("solid", fgColor="FCE4EC")
THIN = Side(style="thin", color="BFBFBF")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)


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


# ══════════════════════════ 1. 증강표 (격자) ══════════════════════════
def sheet_grid(wb):
    ws = wb.create_sheet("증강표")
    ws["A1"] = "무제체스 증강표 (v2 · 개정판)"
    ws["A1"].font = Font(bold=True, size=16, color="2F3E56")
    ws["A2"] = ("처치 카운트가 1 · 3 · 6 · 11 에 도달하면 해당 티어의 증강 18개 중 무작위 3개를 제시받고 1개를 획득합니다. "
                "분홍색 배경 = 원안에서 수정된 증강 (수정 사유는 '개정내역' 시트 참고).")
    ws["A2"].alignment = WRAP
    ws.merge_cells("A2:F2")
    ws.row_dimensions[2].height = 30

    r = 4
    ws.cell(row=r, column=1, value="기물")
    for i, t in enumerate(TIERS):
        ws.cell(row=r, column=2 + i, value=f"{t}개 처치")
    style_header(ws, row=r, upto=5)

    r += 1
    for piece in PIECES:
        maxopts = max(len(by_cell(piece, t)) for t in TIERS)
        start = r
        for i in range(maxopts):
            ws.cell(row=r + i, column=1, value=piece if i == 0 else None)
            for j, t in enumerate(TIERS):
                opts = by_cell(piece, t)
                cell = ws.cell(row=r + i, column=2 + j)
                if i < len(opts):
                    a = opts[i]
                    prefix = "(비밀) " if a["secret"] else ""
                    cell.value = f"[{a['id']}] {prefix}{a['text']}"
                    cell.fill = (CHANGED_FILL if a["change"]
                                 else PatternFill("solid", fgColor=TAG_FILL[a["tag"]]))
                cell.alignment = WRAP
                cell.border = BOX
            ws.cell(row=r + i, column=1).border = BOX
        ws.merge_cells(start_row=start, start_column=1, end_row=start + maxopts - 1, end_column=1)
        ws.cell(row=start, column=1).alignment = CENTER
        ws.cell(row=start, column=1).font = Font(bold=True, size=12)
        for i in range(maxopts):
            ws.row_dimensions[r + i].height = 62
        r += maxopts

    # 범례
    r += 1
    ws.cell(row=r, column=1, value="범례").font = Font(bold=True)
    r += 1
    for tag, color in TAG_FILL.items():
        ws.cell(row=r, column=1, value=tag).fill = PatternFill("solid", fgColor=color)
        ws.cell(row=r, column=1).border = BOX
        note = {"턴제한": "정해진 턴 수 동안만 유효",
                "횟수제한": "자신이 원할 때 정해진 횟수만큼 사용",
                "영구지속": "게임이 끝날 때까지 유지",
                "해당없음": "즉시 1회 처리 후 소멸"}[tag]
        ws.cell(row=r, column=2, value=note).alignment = WRAP
        r += 1
    ws.cell(row=r, column=1, value="개정됨").fill = CHANGED_FILL
    ws.cell(row=r, column=1).border = BOX
    ws.cell(row=r, column=2, value="원안에서 문구/수치가 수정된 증강")

    widths(ws, {"A": 12, "B": 46, "C": 46, "D": 46, "E": 46})
    return ws


# ══════════════════════════ 2. 증강 목록 (DB) ══════════════════════════
def sheet_list(wb):
    ws = wb.create_sheet("증강목록")
    cols = ["ID", "기물", "티어", "지속형태", "비밀", "개정 문구 (적용본)", "원본 문구", "구현", "개정 여부"]
    ws.append(cols)
    style_header(ws)
    order = {p: i for i, p in enumerate(PIECES)}
    for a in sorted(AUGMENTS, key=lambda x: (order[x["piece"]], TIERS.index(x["tier"]), x["id"])):
        ws.append([
            a["id"], a["piece"], a["tier"], a["tag"], "O" if a["secret"] else "",
            a["text"],
            a["orig"] if a["change"] else "(동일)",
            {"auto": "자동", "target": "대상지정", "partial": "일부단순화"}[a["impl"]],
            "개정" if a["change"] else "",
        ])
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = WRAP
            c.border = BOX
        if row[8].value == "개정":
            for c in row:
                c.fill = CHANGED_FILL
        ws.row_dimensions[row[0].row].height = 48
    widths(ws, {"A": 8, "B": 9, "C": 7, "D": 11, "E": 7, "F": 62, "G": 62, "H": 11, "I": 10})
    ws.auto_filter.ref = f"A1:I{ws.max_row}"
    return ws


# ══════════════════════════ 3. 개정내역 ══════════════════════════
def sheet_changes(wb):
    ws = wb.create_sheet("개정내역")
    ws.append(["ID", "기물", "티어", "원본 문구", "개정 문구", "수정 사유"])
    style_header(ws)
    order = {p: i for i, p in enumerate(PIECES)}
    for a in sorted(changed(), key=lambda x: (order[x["piece"]], TIERS.index(x["tier"]), x["id"])):
        ws.append([a["id"], a["piece"], a["tier"], a["orig"], a["text"], a["change"]])
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = WRAP
            c.border = BOX
        ws.row_dimensions[row[0].row].height = 66
    widths(ws, {"A": 8, "B": 9, "C": 7, "D": 52, "E": 52, "F": 58})
    return ws


# ══════════════════════════ 4. 전역 룰 ══════════════════════════
def sheet_rules(wb):
    ws = wb.create_sheet("전역룰")
    ws["A1"] = "전역 룰 패치 — 개별 증강보다 우선하는 규칙"
    ws["A1"].font = Font(bold=True, size=14, color="2F3E56")
    ws.append([])
    ws.append(["규칙", "내용", "필요한 이유"])
    style_header(ws, row=3)
    for name, body, why in GLOBAL_RULES:
        ws.append([name, body, why])
    for row in ws.iter_rows(min_row=4):
        for c in row:
            c.alignment = WRAP
            c.border = BOX
        ws.row_dimensions[row[0].row].height = 62
    widths(ws, {"A": 16, "B": 66, "C": 66})
    return ws


# ══════════════════════════ 5. 용어해설 ══════════════════════════
def sheet_glossary(wb):
    ws = wb.create_sheet("용어해설")
    ws.append(["용어", "설명"])
    style_header(ws)
    for term, desc in GLOSSARY:
        ws.append([term, desc])
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = WRAP
            c.border = BOX
        ws.row_dimensions[row[0].row].height = 46
    widths(ws, {"A": 14, "B": 96})

    ws.append([])
    ws.append(["기물 점수", "폰 1 / 나이트 3 / 비숍 3 / 룩 5 / 퀸 9 / 킹 — (점수 비교에서 제외)"])
    ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
    return ws


# ══════════════════════════ 6. 밸런스 메모 ══════════════════════════
def sheet_balance(wb):
    ws = wb.create_sheet("밸런스메모")
    ws["A1"] = "원본 시트의 밸런스 평가 (그대로 보존)"
    ws["A1"].font = Font(bold=True, size=14, color="2F3E56")

    r = 3
    ws.cell(row=r, column=1, value="처치 밸런스 (티어별 기물 강함 순)").font = Font(bold=True)
    r += 1
    ws.cell(row=r, column=1, value="티어"); ws.cell(row=r, column=2, value="순위")
    style_header(ws, row=r, upto=2)
    r += 1
    for tier, txt in BALANCE_KILL:
        ws.cell(row=r, column=1, value=tier).border = BOX
        ws.cell(row=r, column=2, value=txt).border = BOX
        r += 1

    r += 1
    ws.cell(row=r, column=1, value="기물 밸런스 (기물별 티어 강함 순)").font = Font(bold=True)
    r += 1
    ws.cell(row=r, column=1, value="기물"); ws.cell(row=r, column=2, value="순위")
    style_header(ws, row=r, upto=2)
    r += 1
    for piece, txt in BALANCE_PIECE:
        ws.cell(row=r, column=1, value=piece).border = BOX
        ws.cell(row=r, column=2, value=txt).border = BOX
        r += 1

    r += 1
    ws.cell(row=r, column=1, value="통계상 자주 사용되는 기물").font = Font(bold=True)
    r += 1
    ws.cell(row=r, column=1, value="티어"); ws.cell(row=r, column=2, value="기물")
    style_header(ws, row=r, upto=2)
    r += 1
    for tier, txt in BALANCE_POPULAR:
        ws.cell(row=r, column=1, value=tier).border = BOX
        ws.cell(row=r, column=2, value=txt).border = BOX
        r += 1

    r += 2
    ws.cell(row=r, column=1, value="개정판이 이 평가에 준 영향").font = Font(bold=True, size=12)
    r += 1
    for line in [
        "룩 1개: R1b(줄 전멸)를 사거리 4칸·아군 포함·킹 제외로 하향 → '1개 밸런스'에서 룩의 순위가 내려감.",
        "룩 11개: 원본에서 최약체 평가. R11c 캐슬링 조건을 완전 해방해 소폭 상향.",
        "킹 6개/11개: 킹 직접 강화(2칸 이동·퀸처럼 이동)를 메타 증강으로 교체. "
        "'킹=플레이어' 철학에 맞추면서, 원본에서 최약체였던 킹 11개(K11b)를 달성 가능한 승리 조건으로 재설계.",
        "퀸 11개: 원본에서 최강(11개 >>> ...). 킹 제외 규칙만 추가하고 위력은 유지.",
        "비숍 3개: 홀/짝 동시 등장 금지 규칙으로 '무조건 맞는 선택지' 문제 제거.",
    ]:
        ws.cell(row=r, column=1, value="· " + line).alignment = WRAP
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        ws.row_dimensions[r].height = 32
        r += 1

    r += 2
    ws.cell(row=r, column=1, value="자동 대전 시뮬레이션 결과 (AI '중간' 40판)").font = Font(bold=True, size=12)
    r += 1
    ws.cell(row=r, column=1, value="항목"); ws.cell(row=r, column=2, value="값")
    style_header(ws, row=r, upto=2)
    r += 1
    for k, v in [
        ("평균 수(플라이)", "162"),
        ("한 판 평균 총 처치 수", "10.7 (양측 합산)"),
        ("승부가 난 비율", "40판 중 36판 체크메이트"),
        ("한 진영당 평균 획득 증강", "2.0개"),
        ("도달 티어 분포(80진영 기준)", "0단계 13 / 1단계 10 / 2단계 17 / 3단계 32 / 4단계 8"),
    ]:
        ws.cell(row=r, column=1, value=k).border = BOX
        ws.cell(row=r, column=2, value=v).border = BOX
        r += 1

    r += 1
    ws.cell(row=r, column=1, value="시뮬레이션에서 드러난 문제").font = Font(bold=True, size=12)
    r += 1
    for line in [
        "11개 티어에 도달하는 진영은 10%(80진영 중 8)뿐이다. 원본 시트의 '11개 밸런스' 평가가 "
        "실전 경험보다 추정에 가까울 수밖에 없는 이유이며, 가장 화려한 증강 18개가 거의 쓰이지 않는다.",
        "→ 대응 1: 킹 1개 티어에 K1d(필요 처치 수 -1)를 신설했다. 1개 티어에서 뽑으면 "
        "3·6·11이 2·5·10이 되어 11개 티어 도달률이 눈에 띄게 올라간다.",
        "→ 대응 2(미적용, 검토 필요): 티어를 1·3·6·11 에서 1·3·6·9 로 낮추는 안. "
        "한 판 평균 처치 수가 양측 합산 10.7 이라 11은 사실상 '한 진영이 판을 압도했을 때'만 열린다.",
        "제거는 처치에 포함되지 않으므로, 광역 제거 증강을 고른 진영은 오히려 다음 티어가 늦어진다. "
        "의도된 브레이크지만 11개 티어 도달률을 더 낮추는 요인이기도 하다.",
    ]:
        ws.cell(row=r, column=1, value="· " + line).alignment = WRAP
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        ws.row_dimensions[r].height = 46
        r += 1

    widths(ws, {"A": 22, "B": 92})
    return ws


def main():
    wb = Workbook()
    wb.remove(wb.active)
    sheet_grid(wb)
    sheet_list(wb)
    sheet_changes(wb)
    sheet_rules(wb)
    sheet_glossary(wb)
    sheet_balance(wb)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    wb.save(OUT)
    print("saved:", OUT)
    print("sheets:", wb.sheetnames)


if __name__ == "__main__":
    main()
