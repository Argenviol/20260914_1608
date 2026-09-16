# 브라우저 테스트

중계 서버를 띄운 뒤 헤드리스 크로미움으로 실제 화면을 조작한다. 두 화면을 한 방에 앉혀 온라인 대전까지 돌린다.

```
python server/relay.py                 # 8788
cd tools/test && npm i playwright-core  # 한 번만
node online.js      # 온라인 두 화면 — 예약 수 · 상대 증강 선택 표시 · 시계 · 알림 · 발동 동기화 (26항목)
node augments.js    # 증강 72종 — 조건이 맞는 판을 만들어 훅이 실제로 판을 바꾸는지 (74 시나리오)
```

`harness.js` 의 `EXE` 는 크로미움 경로다. 다른 컴퓨터에서는 `npx playwright install chromium` 뒤 그 경로로 바꾼다.
