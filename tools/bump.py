# -*- coding: utf-8 -*-
"""index.html 의 ?v= 캐시 스탬프를 현재 시각으로 갱신한다. 파일을 고친 뒤 실행."""
import io, os, re, time
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game', 'index.html')
s = io.open(p, encoding='utf-8').read()
stamp = str(int(time.time()))
s2 = re.sub(r'\?v=[0-9a-z]+', '?v=' + stamp, s)
io.open(p, 'w', encoding='utf-8').write(s2)
print('stamp', stamp, '-', len(re.findall(r'\?v=' + stamp, s2)), 'refs')
