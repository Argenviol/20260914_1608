# 온라인 대전 — 컨텍스트

Last Updated: 2026-09-09 (구현 완료, 배포 전)

## 핵심 사실 (코드에서 확인함)

- **게임 흐름에 무작위가 없다.** `Math.random` 은 `ai.js`(AI 전용) · `sfx.js` · `ui.js`(종료 연출)에만.
  `game.js` 의 `sample()` 은 예전 드래프트 잔재로 아무 데서도 안 불린다.
- **사람 입력은 5곳으로만 들어온다.** `Game.play`, `Game.api.draft / pickSquare / pickOption / confirm`.
  증강 41곳이 전부 이 api 를 거친다.
- **턴 경계는 `doMove()` 끝의 `await beginTurn(G.turn)`.** 이 앞은 둔 사람, 이 뒤는 상대.
- `onOppMoved` 구현은 `B1b` 하나뿐이고 프롬프트가 없다(자동). 그래서 경계를 `beginTurn` 앞에 둘 수 있다.
- `beginTurn` 안의 `onSched`(B3a/B3b/B3c) · `onCheck`(B11a) 는 사람에게 묻는다 → 받는 쪽이 돌려야 한다.
- **상대 증강 목록을 읽는 코드는 `B11c` 하나.** `global.AUG_BY_ID[id].piece` 를 본다.
  → 가면 id 에 `piece` 를 넣어야 한다. (`augCountFor` 도 `piece` 기준)
- `augCard(id, dimSecret)` 은 숨김일 때 `piece` + `tier` 만 보여준다. 가면이 공개해도 되는 범위가 딱 이만큼.
- 판 뒤집기(`flip`)와 `bottomSide()` 가 이미 있어서 각자 자기 색을 아래로 두는 건 공짜.
- `G` 안에 함수를 넣지 않는다는 기존 규칙 덕분에 상태가 그대로 JSON 이 된다.

## 의존성 / 계정

- Render MCP 연결됨 — 워크스페이스 `My Workspace` (`tea-d7rgpc28qa3s73dgljf0`, steldatabase@gmail.com).
  계정 새로 만들 필요 없음. **배포는 사용자 확인 후에만.**
- Cloudflare 는 계정이 없어 보류. 옮기게 되면 클라이언트 프로토콜은 그대로 두고 서버만 교체.

## 건드리면 안 되는 것

- `tools/augment_data.py` 가 증강의 단일 소스. `data.js` · xlsx 직접 수정 금지.
  데이터를 고쳤으면 `build_xlsx.py → build_js.py → build_impl_xlsx.py → bump.py` 순서.
- JS/CSS 를 고쳤으면 **반드시 `tools/bump.py`** (index.html 의 `?v=` 갱신).
- `main` 브랜치 금지, PR 금지. 작업은 `김준영_날짜_시각` 브랜치.
- `docs/원본_무제체스_증강표.xlsx` 는 절대 커밋하지 않는다 (.gitignore 에 있음).

## 현재 브랜치

`김준영_20260909_1129` (온라인 작업은 새 브랜치에서)


## 구현 후 확정된 사실

- 프로토콜은 사실상 `state` 하나다. 그 외는 `create/join/rejoin/note/resign/rematch`.
  `note` 는 시계 멈춤/재개만 알린다 (상대가 증강 고르는 동안 내 화면의 상대 시계를 멈추려고).
- `G.begunPly` 가 재접속 시 예약 증강 중복 발동을 막는다. 이게 없으면 새로고침할 때마다 또 터진다.
- 상태에 `snaps` 는 안 보낸다. 받는 쪽이 `Game.recordSnapshot` 으로 직접 만든다.
  대신 **재접속하면 그 이전 국면 되돌려 보기 기록은 없다** (알려진 한계).
- 로컬에서 `tools/launch.py` 가 Node 서버를 우선 띄운다. 기존 실행 버튼 그대로 온라인까지 된다.
