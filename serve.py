"""本地服务：电脑用 http://localhost:8080 ，手机用 https://<电脑IP>:8443 （摄像头必须 HTTPS）。
用法： python serve.py
"""
import http.server
import os
import ssl
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

TYPES = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}
    timeout = 30  # 空着不说话的连接 30 秒后断开

    def end_headers(self):
        # 开发阶段不缓存页面和脚本，改完刷新就生效
        if not self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path):
        full = super().translate_path(path)
        # 不对外提供证书目录
        if os.path.commonpath([full, os.path.join(ROOT, "certs")]) == os.path.join(ROOT, "certs"):
            return os.path.join(ROOT, "__blocked__")
        return full

    def do_GET(self):
        # 页面把自己遇到的报错发到这里，方便在电脑上看手机出了什么问题
        if self.path.startswith("/__log"):
            from urllib.parse import unquote
            print("PAGE", self.client_address[0], unquote(self.path[7:])[:600], flush=True)
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        print(self.client_address[0], fmt % args, flush=True)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    ctx = None

    def get_request(self):
        sock, addr = self.socket.accept()
        if self.ctx:
            # 握手放到每个连接自己的线程里做。手机浏览器会预先开几条连接但不马上握手，
            # 如果在这里握手，一条卡住的连接会把后面所有请求都堵住（表现为白屏、进度条不动）
            sock = self.ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
        return sock, addr

    def handle_error(self, request, client_address):
        import sys
        e = sys.exc_info()[1]
        print("CONN-ERR", client_address[0], type(e).__name__, str(e)[:200], flush=True)


def run(port, tls):
    srv = Server(("0.0.0.0", port), Handler)
    if tls:
        srv.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        srv.ctx.load_cert_chain(os.path.join(ROOT, "certs", "cert.pem"), os.path.join(ROOT, "certs", "key.pem"))
    srv.serve_forever()


if __name__ == "__main__":
    threading.Thread(target=run, args=(8080, False), daemon=True).start()
    print("电脑: http://localhost:8080")
    print("手机: https://192.168.8.104:8443  （同一个 Wi-Fi，首次打开要点“继续访问”）")
    run(8443, True)
