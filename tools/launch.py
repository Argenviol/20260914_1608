# -*- coding: utf-8 -*-
"""무제체스 실행기.

로컬 서버를 띄우고 브라우저를 연다.
- Node 와 server/node_modules 가 있으면 Node 중계 서버를 띄운다 (온라인 대전까지 됨).
  없으면 파이썬 정적 서버로 떨어진다 (AI·2인 대전만 됨).
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
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "game"))
SERVER = os.path.normpath(os.path.join(HERE, "..", "server"))
CANDIDATE_PORTS = [8777, 8778, 8779, 8090, 8181, 0]   # 0 = 비어있는 포트 아무거나


def node_ready():
    """Node 중계 서버를 띄울 수 있는 상태인가."""
    node = shutil.which("node")
    if not node:
        return None
    if not os.path.isdir(os.path.join(SERVER, "node_modules", "ws")):
        return None
    return node


def free_port():
    for p in CANDIDATE_PORTS:
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return s.getsockname()[1]
            except OSError:
                continue
    return None


def run_node(node, port, open_browser_fn):
    """Node 서버를 이 창에 붙여서 돌린다. 온라인 대전(방 코드)까지 된다."""
    env = dict(os.environ, PORT=str(port))
    proc = subprocess.Popen([node, "index.js"], cwd=SERVER, env=env)
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
    ap.add_argument("--static", action="store_true", help="Node 가 있어도 정적 서버로만 띄운다")
    args = ap.parse_args()

    index = os.path.join(ROOT, "index.html")
    if not os.path.exists(index):
        print(f"[오류] 게임 파일을 찾지 못했습니다: {index}")
        return 1

    node = None if args.static else node_ready()

    if node:
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
    print(f"   모드   {'온라인 대전까지 가능 (Node 중계 서버)' if node else 'AI · 2인 대전 (정적 서버)'}")
    if not node:
        print("          온라인 대전을 쓰려면 server 폴더에서 npm install 을 한 번 해주세요.")
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

    if node:
        return run_node(node, port, open_browser)

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
