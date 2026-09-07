# -*- coding: utf-8 -*-
"""Montage(WDS) 디자인 토큰 → CSS 커스텀 프로퍼티 생성.

원티드랩 Montage 의 토큰 소스를 그대로 받아와 CSS 변수로 옮긴다.
컴포넌트(@wanteddev/wds)는 React 패키지라 쓸 수 없으므로 **토큰 레이어만** 가져오고,
컴포넌트는 이 토큰만으로 직접 만든다.

출처: github.com/wanteddev/montage-web
      packages/wds-theme/src/theme/{atomic,opacity,spacing,semantic}

  python build_tokens.py   ->  game/wds-tokens.css
"""
import io
import json
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "game", "wds-tokens.css"))
BASE = ("https://raw.githubusercontent.com/wanteddev/montage-web/main/"
        "packages/wds-theme/src/theme")

PALETTES = ["blue", "common", "coolNeutral", "cyan", "green", "lightBlue", "lime",
            "neutral", "orange", "pink", "purple", "red", "redOrange", "violet"]


def fetch(path):
    with urllib.request.urlopen(f"{BASE}/{path}", timeout=30) as r:
        return r.read().decode("utf-8")


def parse_flat(src):
    """`const x = { 10: '#001536', ... }` 형태를 dict 로."""
    out = {}
    for k, v in re.findall(r"(\d+(?:\.\d+)?)\s*:\s*'([^']*)'", src):
        out[k] = v
    for k, v in re.findall(r"(\d+(?:\.\d+)?)\s*:\s*([\d.]+),", src):
        out.setdefault(k, v)
    return out


def add_hex_opacity(hex_color, value):
    """Montage 의 addHexOpacity 와 동일하게 8자리 hex 알파를 붙인다."""
    return hex_color[:7] + format(round(float(value) * 255), "02X")


def main():
    atomic = {name: parse_flat(fetch(f"atomic/{name}.ts")) for name in PALETTES}
    opacity = parse_flat(fetch("opacity/index.ts"))
    spacing = parse_flat(fetch("spacing/index.ts"))
    semantic_src = fetch("semantic/index.ts")

    def resolve(expr):
        """semantic 소스의 값 표현식을 실제 색으로 바꾼다."""
        expr = expr.strip().rstrip(",")
        m = re.fullmatch(r"atomic\.(\w+)\[([\d.]+)\]", expr)
        if m:
            return atomic[m.group(1)][m.group(2)]
        m = re.fullmatch(
            r"addHexOpacity\(atomic\.(\w+)\[([\d.]+)\],\s*(?:opacity\[([\d.]+)\]|([\d.]+))\)", expr)
        if m:
            fam, step, op_key, raw = m.groups()
            val = float(opacity[op_key]) if op_key else float(raw)
            return add_hex_opacity(atomic[fam][step], val)
        return None

    def extract_theme(name):
        """light / dark 블록에서 '경로 → 값' 을 평평하게 뽑는다."""
        start = semantic_src.index(f"export const {name} = {{")
        depth, i = 0, semantic_src.index("{", start)
        j = i
        while j < len(semantic_src):
            if semantic_src[j] == "{":
                depth += 1
            elif semantic_src[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = semantic_src[i + 1:j]

        flat, path = {}, []
        for line in body.split("\n"):
            s = line.strip()
            if not s or s.startswith("//"):
                continue
            if s.endswith("{"):
                path.append(s.split(":")[0].strip())
                continue
            if s.startswith("}"):
                if path:
                    path.pop()
                continue
            if ":" in s:
                key, _, expr = s.partition(":")
                # elevation.shadow 는 템플릿 문자열이라 색 해석 대상이 아니다
                if "`" in expr:
                    continue
                val = resolve(expr)
                if val:
                    flat["-".join(path + [key.strip()])] = val
        return flat

    light, dark = extract_theme("light"), extract_theme("dark")

    css = io.StringIO()
    css.write("""/* ============================================================
   Montage (WDS) 디자인 토큰 — 자동 생성 파일
   tools/build_tokens.py 로 생성됨. 직접 수정하지 말 것.

   출처: github.com/wanteddev/montage-web
         packages/wds-theme/src/theme/{atomic,opacity,spacing,semantic}

   Montage 는 React 패키지(@wanteddev/wds)로 배포되어 컴포넌트를 그대로
   쓸 수 없다. 그래서 **토큰 레이어만** 같은 이름으로 옮겨오고,
   컴포넌트는 이 토큰만 써서 직접 만들었다.

   - atomic 팔레트 / semantic 매핑 / spacing / opacity : 원문 그대로
   - radius, 타이포그래피 : Montage 미공개 → 이 프로젝트에서 자체 정의
   ============================================================ */

:root {
""")

    css.write("  /* ── spacing (원문 그대로) ── */\n")
    for k in sorted(spacing, key=float):
        css.write(f"  --wds-space-{k.replace('.', '_')}: {spacing[k]};\n")

    css.write("\n  /* ── opacity (원문 그대로) ── */\n")
    for k in sorted(opacity, key=float):
        css.write(f"  --wds-opacity-{k}: {opacity[k]};\n")

    css.write("\n  /* ── atomic 팔레트 (원문 그대로) ── */\n")
    for fam in PALETTES:
        for step in sorted(atomic[fam], key=float):
            css.write(f"  --wds-{fam}-{step}: {atomic[fam][step]};\n")

    css.write("""
  /* ── radius (Montage 미공개 → 자체 정의) ── */
  --wds-radius-2: 2px;
  --wds-radius-4: 4px;
  --wds-radius-6: 6px;
  --wds-radius-8: 8px;
  --wds-radius-10: 10px;
  --wds-radius-12: 12px;
  --wds-radius-16: 16px;
  --wds-radius-20: 20px;
  --wds-radius-full: 9999px;

  /* ── 타이포그래피 (Montage 미공개 → 자체 정의) ── */
  --wds-font: "Pretendard", "Pretendard Variable", -apple-system,
              "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
  --wds-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;

  --wds-title1-size: 28px;   --wds-title1-height: 38px;  --wds-title1-weight: 700;
  --wds-title2-size: 22px;   --wds-title2-height: 30px;  --wds-title2-weight: 700;
  --wds-title3-size: 18px;   --wds-title3-height: 26px;  --wds-title3-weight: 700;
  --wds-heading1-size: 16px; --wds-heading1-height: 24px; --wds-heading1-weight: 600;
  --wds-heading2-size: 15px; --wds-heading2-height: 22px; --wds-heading2-weight: 600;
  --wds-body1-size: 15px;    --wds-body1-height: 24px;   --wds-body1-weight: 400;
  --wds-body2-size: 14px;    --wds-body2-height: 22px;   --wds-body2-weight: 400;
  --wds-label1-size: 13px;   --wds-label1-height: 18px;  --wds-label1-weight: 500;
  --wds-label2-size: 12px;   --wds-label2-height: 16px;  --wds-label2-weight: 500;
  --wds-caption-size: 11px;  --wds-caption-height: 14px; --wds-caption-weight: 500;
}
""")

    def emit(theme, selector, comment):
        css.write(f"\n/* ── semantic · {comment} (원문 그대로) ── */\n{selector} {{\n")
        for k in sorted(theme):
            css.write(f"  --wds-{k}: {theme[k]};\n")
        css.write("}\n")

    emit(light, ":root, [data-theme='light']", "라이트")
    emit(dark, "[data-theme='dark']", "다크")

    css.write("""
/* ── elevation (원문 그대로) ── */
:root {
  --wds-shadow-xsmall: 0px 1px 2px -1px #17171919;
  --wds-shadow-small: 0px 2px 4px -2px #1717190F, 0px 4px 6px -1px #1717190F;
  --wds-shadow-medium: 0px 4px 6px -2px #17171912, 0px 10px 15px -3px #17171912;
  --wds-shadow-large: 0px 6px 10px -4px #17171914, 0px 16px 24px -6px #17171914;
  --wds-shadow-xlarge: 0px 10px 15px -5px #17171919, 0px 24px 38px -10px #1717191F;
}

/* ============================================================
   차트 · 범주형 색상 램프

   status 색(빨강 negative / 초록 positive / 주황 cautionary)은
   이 램프에 넣지 않는다. 이 UI 에서 빨강과 초록은 이미 뜻을 갖기
   때문에(빨강=처치·체크·잠김, 초록=대상 지정), 평범한 범주 항목이
   그 색으로 칠해지면 경고나 성공으로 오독된다.
   ============================================================ */
:root {
  --wds-cat-1: var(--wds-accent-foreground-blue);
  --wds-cat-2: var(--wds-accent-foreground-violet);
  --wds-cat-3: var(--wds-accent-foreground-cyan);
  --wds-cat-4: var(--wds-accent-foreground-purple);
  --wds-cat-5: var(--wds-accent-foreground-lightBlue);
  --wds-cat-6: var(--wds-accent-foreground-pink);
}
""")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(css.getvalue())
    print("saved:", OUT)
    print(f"  atomic 팔레트 {len(PALETTES)}종, "
          f"semantic 라이트 {len(light)}개 / 다크 {len(dark)}개, "
          f"spacing {len(spacing)}단계, opacity {len(opacity)}단계")
    for probe in ["primary-normal", "label-normal", "background-normal-normal",
                  "line-normal-normal", "status-negative", "status-positive"]:
        print(f"  {probe:28s} 라이트 {light.get(probe):9s}  다크 {dark.get(probe)}")


if __name__ == "__main__":
    main()
