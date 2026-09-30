# -*- coding: utf-8 -*-
"""upgrade_data.py -> game/src/data.js 생성 (강화 텍스트/메타 데이터)"""
import io
import json
import os

from upgrade_data import (UPGRADES, PIECES, TIERS, GLOSSARY, GLOBAL_RULES, PIECE_VALUE,
                          TERM_STYLES, terms_in)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "game", "src", "data.js"))

TYPE_OF = {"폰": "p", "나이트": "n", "비숍": "b", "룩": "r", "퀸": "q", "킹": "k"}


def main():
    items = []
    for a in UPGRADES:
        items.append({
            "id": a["id"],
            "piece": a["piece"],
            "type": TYPE_OF[a["piece"]],
            "tier": a["tier"],
            "tag": a["tag"],
            "secret": a["secret"],
            "text": a["text"],
            "orig": a["orig"] if a["change"] else "",
            "change": a["change"],
            "impl": a["impl"],
            "terms": terms_in(a["text"], a["secret"]),
        })

    js = io.StringIO()
    js.write("/* 자동 생성 파일 — tools/build_js.py 로 생성됨. 직접 수정하지 말 것.\n")
    js.write("   원본: docs/무제체스_강화표_v2.xlsx (tools/upgrade_data.py) */\n")
    js.write("window.PIECES_KO = %s;\n" % json.dumps(PIECES, ensure_ascii=False))
    js.write("window.TIERS = %s;\n" % json.dumps(TIERS))
    js.write("window.PIECE_VALUE_KO = %s;\n" % json.dumps(PIECE_VALUE, ensure_ascii=False))
    js.write("window.UPGRADES = %s;\n" % json.dumps(items, ensure_ascii=False, indent=1))
    js.write("window.UPG_BY_ID = {};\n")
    js.write("window.UPGRADES.forEach(function(a){ window.UPG_BY_ID[a.id] = a; });\n")
    js.write("window.TERM_STYLES = %s;\n" % json.dumps(TERM_STYLES, ensure_ascii=False))
    js.write("window.GLOSSARY = %s;\n" % json.dumps(
        [{"term": t, "desc": d} for t, d in GLOSSARY], ensure_ascii=False, indent=1))
    js.write("window.GLOBAL_RULES = %s;\n" % json.dumps(
        [{"name": n, "body": b, "why": w} for n, b, w in GLOBAL_RULES], ensure_ascii=False, indent=1))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js.getvalue())
    print("saved:", OUT, "-", len(items), "upgrades")


if __name__ == "__main__":
    main()
