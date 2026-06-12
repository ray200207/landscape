"""
run_server.py — Urban Landscape Lab 一鍵啟動腳本
執行：python run_server.py
"""
import os
import subprocess
import sys

PYTHON = sys.executable

REQUIRED_PACKAGES = [
    "fastapi",
    "uvicorn",
    "python-multipart",
    "Pillow",
    "python-dotenv",
    "pydantic",
    "google-genai",   # 新版 SDK，取代舊的 google-generativeai
]


# ── 1. 建立 .env（若不存在）──────────────────────────────────────────────────
env_path = os.path.join(os.path.dirname(__file__), ".env")
if not os.path.exists(env_path):
    print("[INFO] 未找到 .env，自動建立預設設定（Mock AI 模式）...")
    with open(env_path, "w", encoding="utf-8") as f:
        f.write("# Urban Landscape Lab 設定\n")
        f.write("DATABASE_URL=sqlite+aiosqlite:///./landscape.db\n")
        f.write("USE_MOCK_AI=true\n")
        f.write("# GEMINI_API_KEY=你的金鑰   # 取消註解並填入金鑰以啟用 Gemini AI\n")
    print("[OK] .env 已建立（目前為 Mock AI 模式）")
else:
    print("[OK] 找到 .env")

# 讀取設定
use_mock = True
api_key = None
with open(env_path, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line.startswith("USE_MOCK_AI="):
            use_mock = line.split("=", 1)[1].strip().lower() not in ("false", "0", "no")
        if line.startswith("GEMINI_API_KEY="):
            api_key = line.split("=", 1)[1].strip()

if use_mock:
    print("[MODE] Mock AI 模式（不需要 GEMINI_API_KEY）")
elif not api_key or api_key in ("你的金鑰", "YOUR_API_KEY", ""):
    print("[WARN] USE_MOCK_AI=false 但 GEMINI_API_KEY 未設定，將回退至 Mock 模式")
else:
    print(f"[MODE] Gemini AI 模式（金鑰前 8 碼：{api_key[:8]}...）")
    pass  # google-genai 已在基礎套件清單中，無需重複添加

# ── 2. 自動安裝套件 ───────────────────────────────────────────────────────────
print("\n[CHECK] 檢查套件依賴...")


def is_installed(pkg: str) -> bool:
    res = subprocess.run(
        [PYTHON, "-m", "pip", "show", pkg],
        capture_output=True, text=True,
    )
    return res.returncode == 0


missing = [p for p in REQUIRED_PACKAGES if not is_installed(p.split("[")[0])]
if missing:
    print(f"[INSTALL] 安裝缺少的套件：{', '.join(missing)}")
    result = subprocess.run(
        [PYTHON, "-m", "pip", "install", "--quiet"] + missing,
        check=False,
    )
    if result.returncode != 0:
        print("[ERROR] 套件安裝失敗，請手動執行：")
        print(f"        pip install {' '.join(missing)}")
        sys.exit(1)
    print("[OK] 套件安裝完成")
else:
    print("[OK] 所有套件已就緒")

# ── 3. 啟動 uvicorn ───────────────────────────────────────────────────────────
project_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(project_dir)

print("\n[START] 啟動後端服務...")
print("        API 文件：http://127.0.0.1:8000/docs")
print("        健康確認：http://127.0.0.1:8000/health")
print("        狀態確認：http://127.0.0.1:8000/status")
print("        前端頁面：用瀏覽器直接開啟 index.html")
print("        停止服務：Ctrl+C\n")

subprocess.run(
    [PYTHON, "-m", "uvicorn", "main:app", "--reload", "--port", "8000"],
    check=False,
)
