#!/usr/bin/env python3
"""
簡易本地開發伺服器
使用方式：python server.py
預設開啟 http://localhost:8080

雲端環境自動支援 PORT 環境變數（Render、Heroku 等）
"""
import http.server
import socketserver
import webbrowser
import os

# 優先讀取環境變數，預設值為 8080
PORT = int(os.getenv('PORT', 8080))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        print(f"  [{self.address_string()}] {format % args}")

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"\n  Urban Landscape Lab — 本地伺服器已啟動")
        print(f"  ➜  {url}\n")
        print(f"  按 Ctrl+C 停止伺服器\n")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  伺服器已停止。")
