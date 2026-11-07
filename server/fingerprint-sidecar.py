# 浏览器级 TLS 指纹的本地代理（native 传输层的执行体）。
#
# 为什么需要它：容器/手机上跑不了 Chromium（本机实测 SIGTRAP），但「TLS ClientHello + HTTP/2 帧」
# 完全可以由 curl_cffi（BoringSSL impersonate）原样复刻 —— 实测 JA4 = t13d1516h2_8daaf6152771_02713d6af862
# （Chrome 131），HTTP/2 Akamai 指纹也与 Chrome 一致。它只需要 CPU，不需要显示器、不需要 /dev/shm、
# 不需要能跑的浏览器，所以在任何 DSH 客户端上都能用。
#
# 协议（只监听 127.0.0.1，随机端口）：
#   GET  /__ping                → {"ok":true,"curl_cffi":"0.17.0","impersonate":"chrome131"}
#   POST /__fetch  {"path","headers","body","timeout"} → 上游状态码 + 原样 body（chunked 直通，SSE 不缓冲）
# 只允许 /api/* 路径，避免变成一个通用代理。
import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.environ.get('DSW_TARGET_BASE', 'https://chat.deepseek.com')
IMPERSONATE = os.environ.get('DSW_IMPERSONATE', 'chrome131')

try:
    from curl_cffi import requests as creq
    import curl_cffi
except Exception as e:  # 依赖没装好时，让 Node 侧拿到明确原因，而不是一个静默空进程
    print(json.dumps({'error': 'curl_cffi import failed: %s' % (type(e).__name__ + ': ' + str(e))}), flush=True)
    sys.exit(2)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        if self.path == '/__ja4':
            # 自检用：用同一条通道去指纹检测站，把真实 JA4 / JA3 / h2 指纹打回来（只读，不碰站点）
            try:
                r = creq.get('https://tls.peet.ws/api/all', impersonate=IMPERSONATE, timeout=25)
                j = r.json() or {}
                t = j.get('tls') or {}
                return self._json(200, {
                    'ok': True,
                    'ja4': t.get('ja4'),
                    'ja3': t.get('ja3_hash'),
                    'h2': (j.get('http2') or {}).get('akamai_fingerprint_hash'),
                    'http_version': j.get('http_version'),
                })
            except Exception as e:
                return self._json(502, {'ok': False, 'error': (type(e).__name__ + ': ' + str(e))[:200]})
        if self.path == '/__ping':
            return self._json(200, {'ok': True, 'curl_cffi': getattr(curl_cffi, '__version__', ''), 'impersonate': IMPERSONATE})
        return self._json(404, {'error': 'unknown route'})

    def do_POST(self):
        if self.path != '/__fetch':
            return self._json(404, {'error': 'unknown route'})
        try:
            n = int(self.headers.get('content-length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:
            return self._json(400, {'error': 'bad json: ' + str(e)[:200]})
        path = str(req.get('path') or '')
        if not path.startswith('/api/'):
            return self._json(400, {'error': 'only /api/* is allowed'})
        headers = {str(k): str(v) for k, v in (req.get('headers') or {}).items()}
        body = req.get('body')
        if isinstance(body, str):
            body = body.encode()
        try:
            r = creq.post(
                BASE + path,
                headers=headers,
                data=body,
                impersonate=IMPERSONATE,
                timeout=float(req.get('timeout') or 120),
                stream=True,
            )
        except Exception as e:
            return self._json(502, {'error': (type(e).__name__ + ': ' + str(e))[:300]})
        try:
            self.send_response(r.status_code)
            self.send_header('content-type', r.headers.get('content-type') or 'application/json')
            self.send_header('transfer-encoding', 'chunked')
            self.end_headers()
            for chunk in r.iter_content(2048):
                if not chunk:
                    continue
                self.wfile.write(b'%x\r\n' % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b'\r\n')
                self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
        except Exception:
            # 客户端断开 / 上游截断：尽力收尾，不让异常冒到线程日志
            try:
                self.wfile.write(b'0\r\n\r\n')
            except Exception:
                pass
        finally:
            try:
                r.close()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    srv.daemon_threads = True
    port = srv.server_address[1]
    print(json.dumps({'port': port, 'pid': os.getpid(), 'impersonate': IMPERSONATE}), flush=True)
    try:
        srv.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            srv.server_close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
