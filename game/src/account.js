/* 계정 — 로그인하면 전적이 기기와 상관없이 이어진다.

   서버(relay.py)가 수퍼베이스에 적는다. 브라우저는 토큰 하나만 갖고 있고,
   비밀번호는 보내는 즉시 잊는다. 저장소가 서버에 연결돼 있지 않으면(로컬 실행 등)
   로그인 칸은 그 사실만 알리고 게임은 그대로 돌아간다. */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'mujeChess.account.token';
  const NAME_KEY = 'mujeChess.account.name';

  const Account = {};
  global.Account = Account;

  let name = null;
  // file:// 로 열었으면 서버가 없다. 계정 칸 자체를 안 보여 준다.
  const available = /^https?:$/.test(location.protocol);

  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function remember(t, n) {
    name = n;
    try { localStorage.setItem(TOKEN_KEY, t); localStorage.setItem(NAME_KEY, n); } catch (e) { }
  }
  function forget() {
    name = null;
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(NAME_KEY); } catch (e) { }
  }

  Account.available = () => available;
  Account.name = () => name;
  Account.loggedIn = () => !!(name && token());

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    let r;
    try {
      r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      const err = new Error('서버에 연결할 수 없습니다'); err.status = 0; throw err;
    }
    if (r.status === 204) return null;
    let j = null;
    try { j = await r.json(); } catch (e) { }
    if (!r.ok) {
      const err = new Error((j && j.error) || ('오류 ' + r.status));
      err.status = r.status;
      throw err;
    }
    return j;
  }

  /** 페이지를 열 때. 토큰이 살아 있으면 이름을 되찾는다. */
  Account.restore = async function () {
    if (!available || !token()) return false;
    try { name = localStorage.getItem(NAME_KEY) || null; } catch (e) { }
    try {
      const me = await api('GET', '/api/auth/me');
      name = me.name;
      return true;
    } catch (e) {
      if (e.status === 401) forget();        // 만료됐거나 지워진 토큰
      return false;                          // 서버가 잠깐 안 되면 이름만 보여 주고 다음에 다시 시도
    }
  };

  /** 가입·로그인. 브라우저에 있던 전적을 같이 보내면 계정 것과 합쳐서 돌려준다. */
  Account.signup = async function (n, pw, records) {
    const j = await api('POST', '/api/auth/signup', { name: n, pw, records: records || [] });
    remember(j.token, j.name);
    return j.records || [];
  };
  Account.login = async function (n, pw, records) {
    const j = await api('POST', '/api/auth/login', { name: n, pw, records: records || [] });
    remember(j.token, j.name);
    return j.records || [];
  };
  Account.logout = async function () {
    try { await api('POST', '/api/auth/logout'); } catch (e) { }
    forget();
  };

  /** 전적을 계정과 합친다. 합친 결과(최신순, 최대 100)를 돌려준다. */
  Account.syncRecords = async function (records) {
    const j = await api('POST', '/api/records', { records: records || [] });
    return j.records || [];
  };
  Account.clearRecords = async function () {
    await api('DELETE', '/api/records');
  };
})(window);
