# 컨텍스트

Last Updated: 2026-09-10

## 건드리는 파일
| 파일 | 무엇 |
|---|---|
| `game/src/stats.js` | 새 파일. 수집통 + 전송 |
| `game/index.html` | 스크립트 태그, 메인 푸터 스위치 |
| `game/src/game.js` | `doMove` 이동·처치, `runDrafts` AI 선택 |
| `game/src/ui.js` | `draft()` 고민시간·시간초과, `showEnd()` 전송 |
| `server/relay.py` | `POST /api/stat` |
| `render.yaml` | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (값은 대시보드에서) |

## 정한 것
- **사람 단위 행** (`plays`) — 대국 단위가 아니다. 온라인에서 id 를 맞출 필요가 없어진다.
- **릴레이 경유** — service_role 키는 브라우저에 절대 안 내려간다.
- **화이트리스트** — service_role 은 RLS 를 무시하므로, 서버가 아는 칸만 골라 담는다.
- **환경변수가 없으면 조용히 넘긴다** — 로컬에서 돌릴 때 오류가 안 나야 한다.
- 버전은 `stats.js` 의 `?v=` 스탬프를 그대로 읽는다 (bump.py 가 이미 갱신한다).

## 의존
- 렌더에 이미 배포됨. 게임 화면도 릴레이가 서빙하므로 `/api/stat` 은 같은 출처.
- 수퍼베이스 프로젝트는 아직 없음 — 사용자가 만들어야 한다 (docs 참고).
