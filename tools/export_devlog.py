# -*- coding: utf-8 -*-
"""세션 대화를 읽을 수 있는 개발 기록으로 뽑아낸다.

세션 원본(jsonl)은 35MB 가 넘고 대부분이 도구 호출·결과다. 그대로 올리면 아무도 못 읽는다.
여기서는 **사람이 쓴 말과 그에 대한 답변**만 남긴다 — 무엇을 요청했고 무엇을 왜 그렇게 고쳤는지가
그 안에 다 들어 있다.

빼는 것
  · 도구 호출과 그 결과 (파일 내용, 명령 출력, 스크린샷)
  · <system-reminder> 같은 하네스가 끼워 넣은 블록
  · 생각(thinking) 블록

쓰는 법:  python tools/export_devlog.py
"""
import io, json, os, re, sys, glob
from datetime import datetime, timezone, timedelta

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
SRC = os.path.expanduser(r"~\.claude\projects\C--Users-USER-Desktop-----")
OUT = os.path.join(ROOT, "docs", "개발_기록.md")

KST = timezone(timedelta(hours=9))

# 하네스가 끼워 넣는 블록들 — 사람이 쓴 말이 아니다
STRIP = [
    re.compile(r"<system-reminder>.*?</system-reminder>", re.S),
    re.compile(r"<task-notification>.*?</task-notification>", re.S),
    re.compile(r"<ci-monitor-event>.*?</ci-monitor-event>", re.S),
    re.compile(r"<local-command-stdout>.*?</local-command-stdout>", re.S),
    re.compile(r"<command-(name|message|args)>.*?</command-\1>", re.S),
]
# 이 문구로 시작하면 사람이 아니라 도구/시스템이 넣은 말이다
NOT_HUMAN = (
    "Caveat:", "[SYSTEM NOTIFICATION", "The user sent a new message while you were working",
    "This session is being continued from a previous conversation",
    "Tool loaded.", "No response requested.",
)


def clean(t):
    for rx in STRIP:
        t = rx.sub("", t)
    return t.strip()


def text_of(content):
    """메시지 본문에서 글자 블록만 모은다. 도구 호출·결과·생각은 버린다."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text" and isinstance(b.get("text"), str):
            out.append(b["text"])
    return "\n".join(out)


def load(path):
    rows = []
    for line in io.open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def collect(path):
    turns = []
    for r in load(path):
        role = (r.get("message") or {}).get("role") or r.get("type")
        if role not in ("user", "assistant"):
            continue
        # 도구 결과는 user 역할로 들어온다 — 사람의 말이 아니다
        content = (r.get("message") or {}).get("content")
        if isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            continue
        t = clean(text_of(content))
        if not t:
            continue
        if role == "user" and t.startswith(NOT_HUMAN):
            continue
        ts = r.get("timestamp")
        turns.append({"role": role, "text": t, "ts": ts})
    return turns


def fmt_ts(ts):
    if not ts:
        return ""
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(KST)
        return d.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


def main():
    files = sorted(glob.glob(os.path.join(SRC, "*.jsonl")), key=os.path.getmtime)
    if not files:
        print("세션 파일을 못 찾았습니다:", SRC)
        return 1

    parts = [
        "# 개발 기록\n",
        "무제체스를 만들면서 주고받은 대화입니다. 무엇을 요청했고, 무엇을 왜 그렇게 고쳤는지가 순서대로 남아 있습니다.\n",
        "> 자동 생성됩니다 — `python tools/export_devlog.py`\n",
        "> 도구 호출·파일 내용·명령 출력은 뺐습니다. 사람이 쓴 말과 그에 대한 답변만 남깁니다.\n",
    ]

    total = 0
    last_day = None
    for f in files:
        turns = collect(f)
        if not turns:
            continue
        for t in turns:
            stamp = fmt_ts(t["ts"])
            day = stamp[:10]
            if day and day != last_day:
                parts.append(f"\n---\n\n## {day}\n")
                last_day = day
            who = "나" if t["role"] == "user" else "Claude"
            head = f"\n### {who}" + (f"  <sub>{stamp[11:]}</sub>" if stamp else "")
            parts.append(head + "\n\n" + t["text"] + "\n")
            total += 1

    io.open(OUT, "w", encoding="utf-8").write("\n".join(parts))
    size = os.path.getsize(OUT)
    print(f"{OUT}\n  대화 {total}개 · {size/1024:.0f}KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
