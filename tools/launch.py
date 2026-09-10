# -*- coding: utf-8 -*-
"""무제체스 실행기.

로컬 서버를 띄우고 브라우저를 연다.
- 기본은 server/relay.py (중계 서버). 온라인 대전까지 된다.
  파이썬 표준 라이브러리만 쓰므로 따로 설치할 것이 없다.
- --static 을 주면 온라인 없이 정적 서버로만 띄운다.
- 포트가 이미 쓰이고 있으면 다음 후보로 넘어간다.
- 캐시를 끄기 때문에 파일을 고치고 새로고침하면 바로 반영된다.
- 창을 닫거나 Ctrl+C 를 누르면 서버가 종료된다.

옵션
    --no-browser   브라우저를 열지 않는다 (점검용)
    --port 1234    포트를 직접 지정한다
"""
import argparse
import http.server
import os
import socket
import socketserver
import subprocess
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "game"))
RELAY = os.path.normpath(os.path.join(HERE, "..", "server", "relay.py"))
CANDIDATE_PORTS = [8777, 8778, 8779, 8090, 8181, 0]   # 0 = 비어있는 포트 아무거나


def already_running(port):
    """그 포트에 이미 무제체스 서버가 떠 있는가."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4) as c:
            c.sendall(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            return b"muje-chess" in c.recv(4096)
    except OSError:
        return False


def find_running():
    """이미 떠 있는 무제체스 서버가 있으면 그 포트를 돌려준다.

    실행 버튼을 두 번 누르면 서버가 둘이 된다. 서로 다른 포트에 뜨더라도,
    방은 프로세스 메모리에 있으므로 한쪽에서 만든 방을 다른 쪽에서 찾을 수 없다.
    ("그런 방이 없습니다") 그래서 새로 띄우기 전에 먼저 살펴본다.
    """
    for p in CANDIDATE_PORTS:
        if p and already_running(p):
            return p
    return None


def free_port():
    """정말로 비어 있는 포트를 고른다.

    그냥 bind 해 보는 것만으로는 부족하다 — Windows 에서는 이미 듣고 있는 포트에도
    바인드가 성공해 버려서, 쓰고 있는 포트를 '비었다'고 넘겨주게 된다.
    그러면 서버가 둘이 되고 온라인 대전의 방이 갈린다.
    """
    for p in CANDIDATE_PORTS:
        with socket.socket() as s:
            if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                s.bind(("0.0.0.0", p))
                return s.getsockname()[1]
            except OSError:
                continue
    return None


def run_relay(port, open_browser_fn):
    """중계 서버를 이 창에 붙여서 돌린다. 온라인 대전(방 코드)까지 된다."""
    env = dict(os.environ, PORT=str(port), PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen([sys.executable, RELAY], env=env)
    if open_browser_fn:
        threading.Timer(0.9, open_browser_fn).start()
    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\n   종료합니다.")
    finally:
        if proc.poll() is None:
            proc.terminate()
    return 0


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 고친 파일이 곧바로 반영되도록 캐시를 끈다
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass          # 콘솔을 조용히


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def pick_port(preferred=None):
    ports = ([preferred] if preferred else []) + CANDIDATE_PORTS
    for p in ports:
        try:
            s = Server(("127.0.0.1", p), Handler)
            return s, s.server_address[1]
        except OSError:
            continue
    return None, None


def setup_console():
    """콘솔 제목과 출력 인코딩을 한글이 깨지지 않게 맞춘다.

    line_buffering 이 핵심이다. 출력이 터미널이 아니면(파이프로 감싸는 실행기 등)
    파이썬이 stdout 을 통째로 버퍼링해서, 서버는 떠 있는데 주소가 한 줄도
    안 보여 '실행이 안 된다' 고 오해하게 된다.
    """
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW("무제체스")
        except Exception:
            pass


def main():
    setup_console()
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--static", action="store_true", help="온라인 없이 정적 서버로만 띄운다")
    args = ap.parse_args()

    index = os.path.join(ROOT, "index.html")
    if not os.path.exists(index):
        print(f"[오류] 게임 파일을 찾지 못했습니다: {index}")
        return 1

    relay = (not args.static) and os.path.exists(RELAY)

    # 이미 떠 있으면 새로 띄우지 않고 그 주소를 연다 (서버가 둘이 되면 방이 갈린다)
    if relay and not args.port:
        running = find_running()
        if running:
            url = f"http://localhost:{running}/index.html"
            print()
            print(f"   이미 무제체스가 떠 있습니다 → {url}")
            print("   그 창을 그대로 쓰시면 됩니다. (서버를 또 띄우면 온라인 대전의 방이 갈립니다)")
            print()
            if not args.no_browser:
                try:
                    webbrowser.open(url)
                except Exception:
                    pass
            return 0

    if relay:
        port = args.port or free_port()
        if port is None:
            print("[오류] 사용할 수 있는 포트를 찾지 못했습니다.")
            return 1
        httpd = None
    else:
        httpd, port = pick_port(args.port)
        if httpd is None:
            print("[오류] 사용할 수 있는 포트를 찾지 못했습니다.")
            return 1

    url = f"http://localhost:{port}/index.html"
    print()
    print("  ┌────────────────────────────────────┐")
    print("  │            무 제 체 스             │")
    print("  └────────────────────────────────────┘")
    print()
    print(f"   주소   {url}")
    print(f"   모드   {'온라인 대전까지 가능 (중계 서버)' if relay else 'AI · 2인 대전 (정적 서버)'}")
    if not relay:
        print("          온라인 대전은 server/relay.py 가 있어야 합니다.")
    print("   종료   이 창을 닫거나 Ctrl+C")
    print()

    open_browser = None
    if not args.no_browser:
        def open_browser():
            try:
                if not webbrowser.open(url):
                    print("   브라우저를 자동으로 열지 못했습니다. 위 주소를 직접 열어주세요.", flush=True)
            except Exception as e:
                print(f"   브라우저 자동 실행 실패({e}). 위 주소를 직접 열어주세요.", flush=True)

    if relay:
        return run_relay(port, open_browser)

    if open_browser:
        threading.Timer(0.4, open_browser).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n   종료합니다.")
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
