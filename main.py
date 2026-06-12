"""
Urban Landscape Lab — FastAPI 後端
Gemini 3.1 Flash-Lite + Structured Outputs + EXIF GPS 提取

啟動指令：
    uvicorn main:app --reload --port 8000
或：
    python main.py
"""

import base64
import io
import json
import logging
import math
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field, model_validator

from google import genai
from google.genai import errors as genai_errors, types

from services.ai_service import extract_gps

# ── 載入環境變數 (.env) ────────────────────────────────────────────────────────
load_dotenv(override=True)

# ── Logging 設定 ───────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)-8s]  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("landscape")

# ── Gemini API Key 與客戶端 ───────────────────────────────────────────────────
# 金鑰存放於 .env（已加入 .gitignore，不進版本控制）：GEMINI_API_KEY=...
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

MODEL  = "gemini-3.1-flash-lite"
client = genai.Client(api_key=GEMINI_API_KEY)

log.info(f"Gemini 客戶端初始化完成，使用模型：{MODEL}")

# ── FastAPI 初始化 ─────────────────────────────────────────────────────────────
app = FastAPI(
    title="Urban Landscape Lab API",
    description=(
        "城市街景景觀元素分析 API\n\n"
        "上傳照片 → Gemini 3.1 Flash-Lite 結構化輸出 → 6 大元素比例 + 環境特性說明"
    ),
    version="3.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/js", StaticFiles(directory="js"), name="js")


# ════════════════════════════════════════════════════════════════════════════════
# SQLite 地圖記錄資料庫
# ════════════════════════════════════════════════════════════════════════════════

DB_PATH = Path("landscape.db")


def _db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _db_connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS map_records (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                latitude         REAL    NOT NULL,
                longitude        REAL    NOT NULL,
                hex_color        TEXT    NOT NULL,
                dominant_emotion TEXT    NOT NULL,
                emotion_scores   TEXT    NOT NULL,
                description      TEXT,
                scene_type       TEXT,
                thumbnail_b64    TEXT,
                created_at       TEXT    NOT NULL
            )
        """)
        conn.commit()
    log.info("SQLite 地圖資料庫初始化完成")


init_db()


def save_map_record(
    *,
    latitude:         float,
    longitude:        float,
    hex_color:        str,
    dominant_emotion: str,
    emotion_scores:   dict,
    description:      Optional[str],
    scene_type:       Optional[str],
    thumbnail_b64:    Optional[str],
    created_at:       str,
) -> None:
    with _db_connect() as conn:
        conn.execute(
            """INSERT INTO map_records
               (latitude, longitude, hex_color, dominant_emotion, emotion_scores,
                description, scene_type, thumbnail_b64, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                latitude, longitude, hex_color, dominant_emotion,
                json.dumps(emotion_scores, ensure_ascii=False),
                description, scene_type, thumbnail_b64, created_at,
            ),
        )
        conn.commit()
    log.info(f"  ✓ 地圖記錄已儲存｜({latitude:.5f}, {longitude:.5f}) {hex_color} [{dominant_emotion}]")


# ════════════════════════════════════════════════════════════════════════════════
# Pydantic 資料結構
# ════════════════════════════════════════════════════════════════════════════════

class LandscapeAnalysis(BaseModel):
    """Gemini 結構化輸出的目標 Schema。"""
    vegetation: float = Field(..., ge=0.0, le=1.0, description="綠化元素比例（喬木、灌木、草皮）")
    waterbody: float = Field(..., ge=0.0, le=1.0, description="藍帶元素比例（河流、噴泉、運河）")
    sky: float = Field(..., ge=0.0, le=1.0, description="天際元素比例（天空、雲層）")
    built_environment: float = Field(..., ge=0.0, le=1.0, description="人工硬質比例（建築立面、鋪面、人行道）")
    mobility: float = Field(..., ge=0.0, le=1.0, description="移動與活絡元素比例（行人、自行車、車輛）")
    obstacles: float = Field(..., ge=0.0, le=1.0, description="干擾/視覺遮蔽比例（廣告看板、圍欄、電線桿）")
    description: str = Field(..., description="環境特性說明短評（100–150 字繁體中文）")

    @model_validator(mode="after")
    def check_ratio_sum(self) -> "LandscapeAnalysis":
        total = (
            self.vegetation + self.waterbody + self.sky
            + self.built_environment + self.mobility + self.obstacles
        )
        if not (0.98 <= total <= 1.02):
            raise ValueError(
                f"景觀元素比例加總應為 1.0，目前為 {total:.4f}。請確認各欄位數值。"
            )
        return self


class UploadResponse(BaseModel):
    image_id:     str
    image_base64: str
    mime_type:    str
    latitude:     Optional[float] = None
    longitude:    Optional[float] = None


class AnalysisResponse(BaseModel):
    elements_ratio: dict
    description:    str
    has_gps:        bool            = False
    latitude:       Optional[float] = None
    longitude:      Optional[float] = None
    scene_type:     Optional[str]   = None
    created_at:     Optional[str]   = None


class EmotionItem(BaseModel):
    score:  int = Field(..., ge=1, le=5, description="情緒強度（1=極弱，5=極強）")
    reason: str = Field(..., description="30–50 字繁體中文評分理由")


class EmotionRaw(BaseModel):
    """Gemini 情緒分析結構化輸出 Schema。"""
    surprise:     EmotionItem
    joy:          EmotionItem
    satisfaction: EmotionItem
    relaxation:   EmotionItem
    fatigue:      EmotionItem
    sadness:      EmotionItem
    tension:      EmotionItem
    fear:         EmotionItem


class EmotionColor(BaseModel):
    hsl:         str
    hex:         str
    coordinates: dict
    distance:    float


class EmotionResponse(BaseModel):
    surprise:     EmotionItem
    joy:          EmotionItem
    satisfaction: EmotionItem
    relaxation:   EmotionItem
    fatigue:      EmotionItem
    sadness:      EmotionItem
    tension:      EmotionItem
    fear:         EmotionItem
    color:        EmotionColor


# ════════════════════════════════════════════════════════════════════════════════
# 工具函式
# ════════════════════════════════════════════════════════════════════════════════
# extract_gps() 已移至 services/ai_service.py（雙方法 + tuple-rational 支援）

# ── Russell 8 情緒的 Valence-Arousal 座標 ─────────────────────────────────────
EMOTION_VA_COORDS: dict[str, tuple[float, float]] = {
    "surprise":     ( 0.5,  1.0),
    "joy":          ( 1.0,  0.5),
    "satisfaction": ( 1.0, -0.5),
    "relaxation":   ( 0.5, -1.0),
    "fatigue":      (-0.5, -1.0),
    "sadness":      (-1.0, -0.5),
    "tension":      (-1.0,  0.5),
    "fear":         (-0.5,  1.0),
}

EMOTION_BLEND_RGB: dict[str, tuple[int, int, int]] = {
    "surprise":     (180, 100, 250),
    "joy":          (255, 200,  30),
    "satisfaction": (100, 200,  80),
    "relaxation":   ( 50, 180, 100),
    "fatigue":      (150, 150, 170),
    "sadness":      ( 80, 100, 160),
    "tension":      (230,  80,  20),
    "fear":         (220,  40,  40),
}


def _hsl_to_hex(h: int, s: int, l: int) -> str:
    """HSL（h:0-360, s:0-100, l:0-100）→ #rrggbb。"""
    s /= 100.0
    l /= 100.0
    c = (1.0 - abs(2 * l - 1)) * s
    x = c * (1.0 - abs((h / 60.0) % 2 - 1))
    m = l - c / 2.0
    if   0   <= h < 60:  r, g, b = c, x, 0
    elif 60  <= h < 120: r, g, b = x, c, 0
    elif 120 <= h < 180: r, g, b = 0, c, x
    elif 180 <= h < 240: r, g, b = 0, x, c
    elif 240 <= h < 300: r, g, b = x, 0, c
    else:                r, g, b = c, 0, x
    return "#{:02x}{:02x}{:02x}".format(
        round((r + m) * 255),
        round((g + m) * 255),
        round((b + m) * 255),
    )


def _rgb_to_hsl(r: int, g: int, b: int) -> tuple[int, int, int]:
    """RGB (0-255) → HSL (h:0-360, s:0-100, l:0-100)。"""
    r_, g_, b_ = r / 255.0, g / 255.0, b / 255.0
    cmax  = max(r_, g_, b_)
    cmin  = min(r_, g_, b_)
    delta = cmax - cmin
    l     = (cmax + cmin) / 2.0

    if delta == 0:
        h, s = 0, 0.0
    else:
        s = delta / (1.0 - abs(2 * l - 1))
        if cmax == r_:
            h = 60.0 * (((g_ - b_) / delta) % 6)
        elif cmax == g_:
            h = 60.0 * ((b_ - r_) / delta + 2)
        else:
            h = 60.0 * ((r_ - g_) / delta + 4)

    return int(h % 360), int(s * 100), int(l * 100)


def calculate_emotion_color(emotion: EmotionRaw) -> EmotionColor:
    """景觀情緒色彩演算法（語義混色 + 平方權重）。"""
    scores = {
        "surprise":     emotion.surprise.score,
        "joy":          emotion.joy.score,
        "satisfaction": emotion.satisfaction.score,
        "relaxation":   emotion.relaxation.score,
        "fatigue":      emotion.fatigue.score,
        "sadness":      emotion.sadness.score,
        "tension":      emotion.tension.score,
        "fear":         emotion.fear.score,
    }

    if all(s == 1 for s in scores.values()):
        return EmotionColor(
            hsl="hsl(0, 0%, 50%)",
            hex="#808080",
            coordinates={"valence": 0.0, "arousal": 0.0},
            distance=0.0,
        )

    total_weight = 0.0
    sum_r = sum_g = sum_b = 0.0
    sum_v = sum_a_coord = 0.0

    for key, score in scores.items():
        weight = float((score - 1) ** 2)
        if weight == 0:
            continue
        r, g, b     = EMOTION_BLEND_RGB[key]
        v, a        = EMOTION_VA_COORDS[key]
        sum_r       += r * weight
        sum_g       += g * weight
        sum_b       += b * weight
        sum_v       += v * weight
        sum_a_coord += a * weight
        total_weight += weight

    blend_r = int(round(sum_r / total_weight))
    blend_g = int(round(sum_g / total_weight))
    blend_b = int(round(sum_b / total_weight))

    avg_v = sum_v       / total_weight
    avg_a = sum_a_coord / total_weight

    hue, saturation, lightness = _rgb_to_hsl(blend_r, blend_g, blend_b)
    lightness = max(30, min(70, lightness))

    distance  = round(min(1.0, math.sqrt(avg_v ** 2 + avg_a ** 2)), 3)
    hex_color = _hsl_to_hex(hue, saturation, lightness)

    log.info(
        f"  色彩混色｜blend_rgb=({blend_r},{blend_g},{blend_b})"
        f" → hsl({hue},{saturation}%,{lightness}%) {hex_color}"
        f" | VA=({avg_v:+.3f},{avg_a:+.3f})"
    )

    return EmotionColor(
        hsl=f"hsl({hue}, {saturation}%, {lightness}%)",
        hex=hex_color,
        coordinates={"valence": round(avg_v, 3), "arousal": round(avg_a, 3)},
        distance=distance,
    )


def build_prompt(scene_type: Optional[str]) -> str:
    """根據場域類型生成景觀分析 Prompt。"""
    scene_context = f"（場域類型：{scene_type}）" if scene_type else ""
    scene_hint = (
        f"\n注意：此場景為「{scene_type}」，請結合該場域的典型空間特徵進行詮釋"
        f"（例如歷史街區的石板路、水岸的親水步道等）。"
        if scene_type else ""
    )
    return f"""
你是一位專業的都市景觀環境分析師。請仔細觀察這張{scene_context}城市街景照片，
精確估算以下 6 大景觀元素在畫面中的視覺佔比（所有數值加總必須精確等於 1.0）：

- vegetation        : 綠化元素（喬木、灌木、草皮）
- waterbody         : 藍帶元素（河流、噴泉、運河、水體）
- sky               : 天際元素（天空、雲層）
- built_environment : 人工硬質（建築立面、牆面、鋪面、人行道）
- mobility          : 移動與活絡元素（行人、自行車、車輛）
- obstacles         : 干擾/視覺遮蔽（廣告看板、施工圍欄、電線桿、橋梁結構）

同時生成一段 100–150 字的繁體中文「環境特性說明」(description)，
聚焦於各元素比例消長關係所呈現的環境氛圍、空間質感與情緒恢復潛力。{scene_hint}
""".strip()


def build_emotion_prompt(scene_type: Optional[str], landscape_desc: Optional[str]) -> str:
    """生成 Russell 環形情緒分析 Prompt。"""
    scene_ctx = f"（場域類型：{scene_type}）" if scene_type else ""
    desc_hint = (
        f"\n\n參考資訊：此場景的景觀特性說明為——「{landscape_desc}」\n"
        "請結合此描述進行情緒評估，保持與景觀分析一致的情境認知。"
        if landscape_desc else ""
    )
    return f"""
你是一位專業的環境心理學家，擅長分析城市視覺場景對觀察者情緒的潛在影響。
請仔細觀察這張{scene_ctx}城市街景照片，
根據 Russell 環形情緒模型（Circumplex Model of Affect），
評估此空間場景對一般觀察者可能引發的 8 種情緒的強度。

評分說明：
- 1 分 = 幾乎感受不到
- 5 分 = 非常強烈
- 評估依據：照片的色彩、光線、空間開闊度、元素密度、自然/人工比例等視覺特徵

請為每項情緒提供 30–50 字的繁體中文理由，
說明照片的哪些具體視覺元素觸發了此情緒。
{desc_hint}

情緒指標定義：
- surprise（驚奇）：視覺意外性、不尋常元素、突出焦點
- joy（愉快）：色彩豐富度、活力、正向視覺密度
- satisfaction（滿足）：秩序感、完整性、功能性環境的妥適感
- relaxation（放鬆）：開闊感、自然元素主導、低刺激強度
- fatigue（疲憊）：視覺複雜度、資訊過載、缺乏視覺休息點
- sadness（沮喪）：灰暗色調、荒廢感、缺乏生命活力
- tension（緊張）：擁擠、高密度人工元素、不和諧視覺衝突
- fear（驚恐）：封閉壓迫感、陰暗、潛在威脅性元素
""".strip()


# ════════════════════════════════════════════════════════════════════════════════
# API 路由
# ════════════════════════════════════════════════════════════════════════════════

@app.get("/", tags=["頁面"])
async def serve_index():
    return FileResponse("index.html")


@app.get("/result.html", tags=["頁面"])
async def serve_result():
    return FileResponse("result.html")


@app.get("/emotion.html", tags=["頁面"])
async def serve_emotion():
    return FileResponse("emotion.html")


@app.get("/map.html", tags=["頁面"])
async def serve_map():
    return FileResponse("map.html")


# 暫存圖片（供 /api/upload 使用）
_image_store: dict[str, dict] = {}


@app.get("/status", tags=["系統"])
async def status():
    key = os.getenv("GEMINI_API_KEY", "")
    return {
        "api_key_set": bool(key),
        "api_key_preview": f"{key[:8]}..." if key else "（未設定）",
        "model": MODEL,
    }


@app.post("/api/upload", response_model=UploadResponse, tags=["景觀分析"])
async def upload_image(
    file: UploadFile = File(..., description="城市街景照片（JPG / PNG / WEBP）"),
):
    """Step 1：上傳並驗證圖片，提取 EXIF GPS，回傳 image_id 與 base64 供後續頁面使用。"""
    log.info(f"► 收到上傳請求｜檔案：{file.filename}｜MIME：{file.content_type}")

    allowed_mime = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_mime:
        raise HTTPException(
            status_code=415,
            detail=f"不支援的檔案格式（{file.content_type}）。請上傳 JPG、PNG 或 WEBP。",
        )

    image_data = await file.read()
    size_mb = len(image_data) / 1024 / 1024
    if size_mb > 4.0:
        raise HTTPException(
            status_code=413,
            detail=f"檔案大小 {size_mb:.1f} MB 超過 4 MB 上限，請壓縮後重試。",
        )

    latitude, longitude = extract_gps(image_data)
    image_id = str(uuid.uuid4())
    _image_store[image_id] = {
        "bytes": image_data,
        "mime":  file.content_type or "image/jpeg",
        "lat":   latitude,
        "lon":   longitude,
    }

    log.info(f"  ✓ 圖片暫存完成｜id={image_id[:8]}… GPS={'有' if latitude else '無'}")
    return UploadResponse(
        image_id=image_id,
        image_base64=base64.b64encode(image_data).decode(),
        mime_type=file.content_type or "image/jpeg",
        latitude=latitude,
        longitude=longitude,
    )


@app.delete("/api/upload/{image_id}", tags=["景觀分析"])
async def delete_upload(image_id: str):
    """刪除暫存圖片（前端清除或取消時呼叫）。"""
    _image_store.pop(image_id, None)
    return {"message": "已清除"}


@app.post("/api/analyze", response_model=AnalysisResponse, tags=["景觀分析"])
async def analyze(
    file:       UploadFile    = File(...,  description="城市街景照片（JPG / PNG / WEBP）"),
    scene_type: Optional[str]   = Form(None, description="場域類型（選填，如：歷史街區、水岸空間）"),
    latitude:   Optional[float] = Form(None, description="GPS 緯度（來自 EXIF，選填）"),
    longitude:  Optional[float] = Form(None, description="GPS 經度（來自 EXIF，選填）"),
):
    """
    Step 2：接收街景照片 + GPS + 場域類型，呼叫 Gemini 進行結構化景觀元素分析。
    """
    log.info(f"► 收到分析請求｜檔案：{file.filename}｜場域：{scene_type or '（未指定）'}")

    allowed_mime = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_mime:
        raise HTTPException(
            status_code=415,
            detail=f"不支援的檔案格式（{file.content_type}）。請上傳 JPG、PNG 或 WEBP。",
        )

    image_data = await file.read()
    size_mb = len(image_data) / 1024 / 1024
    if size_mb > 4.0:
        raise HTTPException(
            status_code=413,
            detail=f"檔案大小 {size_mb:.1f} MB 超過 4 MB 上限，請壓縮後重試。",
        )

    if latitude is None or longitude is None:
        log.info("  無 GPS 參數，has_gps=false，將回傳 lat/lng null")

    # ── 圖片前處理（縮圖以降低 token 消耗）─────────────────────────────────────
    try:
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        log.info(f"  原始尺寸：{img.width}×{img.height}")

        if max(img.width, img.height) > 1024:
            img.thumbnail((1024, 1024), Image.LANCZOS)
            log.info(f"  縮圖後尺寸：{img.width}×{img.height}")

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        processed_bytes = buf.getvalue()

    except Exception as e:
        log.error(f"  ✗ 圖片處理失敗：{e}")
        raise HTTPException(status_code=400, detail=f"圖片處理失敗：{e}")

    # ── 呼叫 Gemini（結構化輸出）────────────────────────────────────────────────
    prompt = build_prompt(scene_type)
    log.info(f"  正在呼叫 {MODEL}（Structured Output）…")

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=[
                types.Part.from_bytes(data=processed_bytes, mime_type="image/jpeg"),
                types.Part.from_text(text=prompt),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=LandscapeAnalysis,
            ),
        )
        log.info(f"  Gemini 回應完成｜Token 用量：{response.usage_metadata}")

    except genai_errors.APIError as e:
        if e.code == 429:
            log.warning(f"  ✗ Gemini 429 超額：{e}")
            raise HTTPException(
                status_code=429,
                detail="今日免費分析額度已達上限，請稍後或明日再試。",
            )
        log.error(f"  ✗ Gemini API 錯誤 {e.code}：{e}")
        raise HTTPException(status_code=502, detail=f"Gemini API 呼叫失敗：{e}")
    except Exception as e:
        log.error(f"  ✗ Gemini API 呼叫失敗：{type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail=f"Gemini API 呼叫失敗：{e}")

    # ── 解析並驗證結構化回應 ──────────────────────────────────────────────────
    try:
        analysis: LandscapeAnalysis = response.parsed  # type: ignore[assignment]
        if analysis is None:
            analysis = LandscapeAnalysis.model_validate_json(response.text)

        log.info(
            f"  ✓ 分析完成｜"
            f"vegetation={analysis.vegetation:.2f} sky={analysis.sky:.2f} "
            f"built={analysis.built_environment:.2f} water={analysis.waterbody:.2f} "
            f"mobility={analysis.mobility:.2f} obstacles={analysis.obstacles:.2f}"
        )
        log.info(f"  說明：{analysis.description[:60]}…")

    except Exception as e:
        log.error(f"  ✗ 回應解析失敗：{e}｜原始文字：{response.text[:200]}")
        raise HTTPException(status_code=502, detail=f"AI 回應格式異常：{e}")

    # ── 組裝回傳結果 ──────────────────────────────────────────────────────────
    raw = {
        "植栽元素":       analysis.vegetation,
        "藍帶元素":       analysis.waterbody,
        "天際元素":       analysis.sky,
        "人工硬質":       analysis.built_environment,
        "移動與活絡元素": analysis.mobility,
        "干擾視覺遮蔽":   analysis.obstacles,
    }
    total = sum(raw.values())
    elements_ratio = {k: round(v / total * 100, 1) for k, v in raw.items()}
    diff = round(100.0 - sum(elements_ratio.values()), 1)
    largest_key = max(elements_ratio, key=elements_ratio.get)
    elements_ratio[largest_key] = round(elements_ratio[largest_key] + diff, 1)

    result = AnalysisResponse(
        elements_ratio=elements_ratio,
        description=analysis.description,
        has_gps=latitude is not None and longitude is not None,
        latitude=latitude,
        longitude=longitude,
        scene_type=scene_type,
        created_at=datetime.now(timezone.utc).isoformat(),
    )

    log.info(f"► 回傳成功｜GPS={'有' if latitude else '無'}｜場域：{scene_type or '—'}\n")
    return result


# ════════════════════════════════════════════════════════════════════════════════
# 情緒分析 API 路由
# ════════════════════════════════════════════════════════════════════════════════

@app.post("/api/emotion", tags=["情緒分析"])
async def analyze_emotion(
    file:                  UploadFile    = File(...,  description="街景照片（JPG / PNG / WEBP）"),
    scene_type:            Optional[str]   = Form(None, description="場域類型（選填）"),
    landscape_description: Optional[str]   = Form(None, description="景觀特性說明（選填，來自第二頁分析）"),
    latitude:              Optional[float] = Form(None, description="GPS 緯度（選填，來自 EXIF）"),
    longitude:             Optional[float] = Form(None, description="GPS 經度（選填，來自 EXIF）"),
):
    """對街景照片進行 Russell 環形情緒模型分析，回傳 8 項情緒評分與情緒色彩。"""
    log.info(f"► 收到情緒分析請求｜檔案：{file.filename}｜場域：{scene_type or '（未指定）'}")

    allowed_mime = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_mime:
        raise HTTPException(status_code=415, detail=f"不支援的格式：{file.content_type}")

    image_data = await file.read()
    size_mb = len(image_data) / 1024 / 1024
    if size_mb > 4.0:
        raise HTTPException(status_code=413, detail=f"檔案 {size_mb:.1f} MB 超過 4 MB 上限")

    log.info(f"  檔案大小：{size_mb:.2f} MB")

    # ── 圖片前處理 ────────────────────────────────────────────────────────────
    try:
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        if max(img.width, img.height) > 1024:
            img.thumbnail((1024, 1024), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        processed_bytes = buf.getvalue()
        log.info(f"  圖片處理完成：{img.width}×{img.height}")
    except Exception as e:
        log.error(f"  ✗ 圖片處理失敗：{e}")
        raise HTTPException(status_code=400, detail=f"圖片處理失敗：{e}")

    # ── 呼叫 Gemini 情緒分析（結構化輸出）──────────────────────────────────────
    prompt = build_emotion_prompt(scene_type, landscape_description)
    log.info(f"  正在呼叫 {MODEL} 進行情緒分析…")

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=[
                types.Part.from_bytes(data=processed_bytes, mime_type="image/jpeg"),
                types.Part.from_text(text=prompt),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=EmotionRaw,
            ),
        )
        log.info(f"  Gemini 回應完成｜Token：{response.usage_metadata}")
    except genai_errors.APIError as e:
        if e.code == 429:
            log.warning(f"  ✗ Gemini 429 超額：{e}")
            raise HTTPException(
                status_code=429,
                detail="今日免費分析額度已達上限，請稍後或明日再試。",
            )
        log.error(f"  ✗ Gemini API 錯誤 {e.code}：{e}")
        raise HTTPException(status_code=502, detail=f"Gemini API 呼叫失敗：{e}")
    except Exception as e:
        log.error(f"  ✗ Gemini API 失敗：{type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail=f"Gemini API 呼叫失敗：{e}")

    # ── 解析情緒結果 ──────────────────────────────────────────────────────────
    try:
        emotion: EmotionRaw = response.parsed  # type: ignore[assignment]
        if emotion is None:
            emotion = EmotionRaw.model_validate_json(response.text)

        log.info(
            f"  ✓ 情緒解析完成｜"
            f"surprise={emotion.surprise.score} joy={emotion.joy.score} "
            f"satisfaction={emotion.satisfaction.score} relaxation={emotion.relaxation.score} | "
            f"fatigue={emotion.fatigue.score} sadness={emotion.sadness.score} "
            f"tension={emotion.tension.score} fear={emotion.fear.score}"
        )
    except Exception as e:
        log.error(f"  ✗ 回應解析失敗：{e}")
        raise HTTPException(status_code=502, detail=f"情緒回應格式異常：{e}")

    # ── 計算情緒色彩 ──────────────────────────────────────────────────────────
    color = calculate_emotion_color(emotion)
    log.info(f"  情緒色彩：{color.hsl} | V={color.coordinates['valence']:+.3f} A={color.coordinates['arousal']:+.3f}")

    # ── 若有 GPS，生成縮圖並寫入地圖資料庫 ──────────────────────────────────────
    if latitude is not None and longitude is not None:
        thumb_b64: Optional[str] = None
        try:
            thumb_img = Image.open(io.BytesIO(image_data)).convert("RGB")
            thumb_img.thumbnail((200, 150), Image.LANCZOS)
            buf_t = io.BytesIO()
            thumb_img.save(buf_t, format="JPEG", quality=55)
            thumb_b64 = base64.b64encode(buf_t.getvalue()).decode()
        except Exception as te:
            log.warning(f"  縮圖生成失敗（不阻斷回傳）：{te}")

        scores_zh = {
            "驚奇": emotion.surprise.score,
            "愉快": emotion.joy.score,
            "滿足": emotion.satisfaction.score,
            "放鬆": emotion.relaxation.score,
            "疲憊": emotion.fatigue.score,
            "沮喪": emotion.sadness.score,
            "緊張": emotion.tension.score,
            "驚恐": emotion.fear.score,
        }
        dominant = max(scores_zh, key=scores_zh.get)

        try:
            save_map_record(
                latitude=latitude,
                longitude=longitude,
                hex_color=color.hex,
                dominant_emotion=dominant,
                emotion_scores=scores_zh,
                description=landscape_description,
                scene_type=scene_type,
                thumbnail_b64=thumb_b64,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        except Exception as dbe:
            log.error(f"  ✗ 地圖記錄寫入失敗（不阻斷回傳）：{dbe}")
    else:
        log.info("  無 GPS 座標，跳過地圖記錄寫入\n")

    return {
        "驚奇": emotion.surprise.model_dump(),
        "愉快": emotion.joy.model_dump(),
        "滿足": emotion.satisfaction.model_dump(),
        "放鬆": emotion.relaxation.model_dump(),
        "疲憊": emotion.fatigue.model_dump(),
        "沮喪": emotion.sadness.model_dump(),
        "緊張": emotion.tension.model_dump(),
        "驚恐": emotion.fear.model_dump(),
        "color": color.model_dump(),
    }


# ════════════════════════════════════════════════════════════════════════════════
# 地圖 API
# ════════════════════════════════════════════════════════════════════════════════

@app.get("/api/map-points", tags=["地圖"])
async def get_map_points():
    """回傳所有含 GPS 座標的歷史情緒分析紀錄，供地圖渲染。"""
    with _db_connect() as conn:
        rows = conn.execute(
            "SELECT * FROM map_records ORDER BY created_at DESC"
        ).fetchall()

    result = []
    for row in rows:
        d = dict(row)
        try:
            d["emotion_scores"] = json.loads(d["emotion_scores"])
        except (json.JSONDecodeError, TypeError):
            d["emotion_scores"] = {}
        result.append(d)

    log.info(f"► /api/map-points 回傳 {len(result)} 筆點位")
    return result


@app.delete("/api/map-points", tags=["地圖"])
async def clear_map_points():
    """清除資料庫中所有地圖點位記錄（不可復原）。"""
    with _db_connect() as conn:
        conn.execute("DELETE FROM map_records")
        conn.commit()
    log.info("► 已清除所有地圖點位記錄")
    return {"message": "所有點位已清除"}


class UpdateLocationRequest(BaseModel):
    latitude:         float
    longitude:        float
    hex_color:        str
    dominant_emotion: str
    emotion_scores:   dict
    description:      Optional[str] = None
    scene_type:       Optional[str] = None


@app.post("/api/update-location", tags=["地圖"])
async def update_location(req: UpdateLocationRequest):
    """接收前端手動拖曳確認的 GPS 座標，將情緒分析結果寫入地圖資料庫。"""
    try:
        save_map_record(
            latitude=req.latitude,
            longitude=req.longitude,
            hex_color=req.hex_color,
            dominant_emotion=req.dominant_emotion,
            emotion_scores=req.emotion_scores,
            description=req.description,
            scene_type=req.scene_type,
            thumbnail_b64=None,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
    except Exception as e:
        log.error(f"  ✗ 手動座標儲存失敗：{e}")
        raise HTTPException(status_code=500, detail=f"座標儲存失敗：{e}")

    log.info(f"► /api/update-location 儲存成功｜({req.latitude:.5f}, {req.longitude:.5f})")
    return {"message": "位置已儲存", "latitude": req.latitude, "longitude": req.longitude}


# ════════════════════════════════════════════════════════════════════════════════
# 直接執行入口
# ════════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
