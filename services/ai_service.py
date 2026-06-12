"""AI 景觀分析服務（google-genai SDK 版）

此模組提供：
  1. 穩健的 EXIF GPS 提取（extract_gps）
  2. Gemini 景觀元素分析（analyze_landscape）

SDK：google-genai（pip install google-genai）
模型：gemini-3.1-flash-lite
"""

import asyncio
import io
import json
import logging
import os
from typing import Optional

from dotenv import load_dotenv
from google import genai
from google.genai import errors as genai_errors, types
from PIL import Image, ExifTags

load_dotenv(override=True)

log = logging.getLogger("landscape.ai_service")

# 金鑰存放於 .env（已加入 .gitignore，不進版本控制）：GEMINI_API_KEY=...
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

MODEL = "gemini-3.1-flash-lite"

# GPSInfo 的固定 tag ID（0x8825 = 34853）
_GPS_TAG_ID: int = next(
    (tid for tid, name in ExifTags.TAGS.items() if name == "GPSInfo"), 34853
)


def get_client() -> genai.Client:
    return genai.Client(api_key=GEMINI_API_KEY)


# ════════════════════════════════════════════════════════════════════════════════
# GPS EXIF 提取（100% 防禦型，支援多種手機 / 相機格式）
# ════════════════════════════════════════════════════════════════════════════════

def extract_gps(image_data: bytes) -> tuple[Optional[float], Optional[float]]:
    """
    從圖片 bytes 解析 EXIF GPS 座標（度分秒 → 十進位浮點數）。

    支援：
      - Pillow IFDRational（iPhone HEIF/JPEG 常見）
      - (numerator, denominator) tuple（部分 Android / Canon / Nikon 原始格式）
      - 一般 int / float
    任何例外均回傳 (None, None)，絕不帶入任何預設座標。
    """

    def _to_float(val) -> float:
        """IFDRational / (num, den) tuple / 數值 → float。"""
        if isinstance(val, tuple) and len(val) == 2:
            # EXIF Rational 原始格式：(分子, 分母)
            denom = float(val[1])
            return float(val[0]) / denom if denom != 0.0 else 0.0
        return float(val)

    def _dms_to_dd(dms, ref: str) -> float:
        """度（°）分（'）秒（"）→ 十進位度；南緯 'S' / 西經 'W' 取負值。"""
        d = _to_float(dms[0])
        m = _to_float(dms[1])
        s = _to_float(dms[2])
        dd = d + m / 60.0 + s / 3600.0
        return -dd if ref in ("S", "W") else dd

    try:
        img = Image.open(io.BytesIO(image_data))
        gps_ifd: Optional[dict] = None

        # ── 方法 A：getexif() + get_ifd()（Pillow ≥ 6.0，最穩定路徑）────────────
        try:
            exif = img.getexif()
            if exif and _GPS_TAG_ID in exif:
                try:
                    gps_ifd = dict(exif.get_ifd(_GPS_TAG_ID))
                except Exception:
                    raw_val = exif.get(_GPS_TAG_ID)
                    if isinstance(raw_val, dict):
                        gps_ifd = raw_val
        except Exception:
            pass

        # ── 方法 B：_getexif() fallback（部分 JPEG 在方法 A 失效時使用）──────────
        if not gps_ifd:
            try:
                raw_exif = img._getexif()  # type: ignore[attr-defined]
                if raw_exif:
                    raw_gps = raw_exif.get(_GPS_TAG_ID)
                    if isinstance(raw_gps, dict):
                        gps_ifd = {
                            ExifTags.GPSTAGS.get(k, str(k)): v
                            for k, v in raw_gps.items()
                        }
            except Exception:
                pass

        if not gps_ifd:
            log.info("EXIF: 無 GPSInfo 或 IFD 為空")
            return None, None

        # ── 統一：若 key 仍為整數，再對應一次 GPSTAGS 字串 key ───────────────────
        sample_key = next(iter(gps_ifd), None)
        if isinstance(sample_key, int):
            gps = {ExifTags.GPSTAGS.get(k, str(k)): v for k, v in gps_ifd.items()}
        else:
            gps = gps_ifd

        if "GPSLatitude" not in gps or "GPSLongitude" not in gps:
            log.info("EXIF: GPSLatitude / GPSLongitude 欄位缺失")
            return None, None

        lat_ref = str(gps.get("GPSLatitudeRef",  "N")).strip().upper()
        lon_ref = str(gps.get("GPSLongitudeRef", "E")).strip().upper()

        lat = _dms_to_dd(gps["GPSLatitude"],  lat_ref)
        lon = _dms_to_dd(gps["GPSLongitude"], lon_ref)

        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            log.warning(f"EXIF GPS 座標超出合理範圍：lat={lat}, lon={lon}")
            return None, None

        log.info(f"EXIF GPS 提取成功：lat={lat:.6f}, lon={lon:.6f}")
        return round(lat, 7), round(lon, 7)

    except Exception as e:
        log.warning(f"EXIF 解析失敗（不阻斷分析）：{e}")
        return None, None


# ════════════════════════════════════════════════════════════════════════════════
# Gemini 景觀元素分析
# ════════════════════════════════════════════════════════════════════════════════

def build_landscape_prompt(scene_type: Optional[str]) -> str:
    scene_ctx = f"（場域類型：{scene_type}）" if scene_type else ""
    scene_hint = (
        f"\n注意：此場景為「{scene_type}」，請結合該場域的典型空間特徵進行詮釋。"
        if scene_type else ""
    )
    return f"""
你是一位專業的都市景觀環境分析師。請仔細觀察這張{scene_ctx}城市街景照片，
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


async def analyze_landscape(
    image_data: bytes,
    scene_type: Optional[str] = None,
) -> dict:
    """分析景觀元素，回傳 {"elements_ratio": {...}, "description": "..."} 格式。"""
    return await _gemini_analyze(image_data, scene_type)


async def _gemini_analyze(image_data: bytes, scene_type: Optional[str]) -> dict:
    """呼叫 gemini-3.1-flash-lite 進行影像景觀分析。"""
    client = get_client()
    prompt = build_landscape_prompt(scene_type)

    try:
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        if max(img.width, img.height) > 1024:
            img.thumbnail((1024, 1024), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        processed_bytes = buf.getvalue()
    except Exception as e:
        raise RuntimeError(f"圖片前處理失敗：{e}") from e

    try:
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=MODEL,
            contents=[
                types.Part.from_bytes(data=processed_bytes, mime_type="image/jpeg"),
                types.Part.from_text(text=prompt),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
            ),
        )
    except genai_errors.APIError as e:
        if e.code == 429:
            log.warning(f"Gemini 429 超額：{e}")
            raise
        log.error(f"Gemini API 錯誤 {e.code}：{e}")
        raise RuntimeError(f"Gemini API 呼叫失敗（code={e.code}）：{e}") from e
    except Exception as e:
        raise RuntimeError(f"Gemini API 呼叫失敗：{e}") from e

    try:
        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        raw = json.loads(text.strip())

        key_map = {
            "vegetation":        "植栽元素",
            "waterbody":         "藍帶元素",
            "sky":               "天際元素",
            "built_environment": "人工硬質",
            "mobility":          "移動與活絡元素",
            "obstacles":         "干擾視覺遮蔽",
        }
        ratio_raw = {key_map[k]: float(raw[k]) for k in key_map if k in raw}
        total = sum(ratio_raw.values())
        elements_ratio = {k: round(v / total * 100, 1) for k, v in ratio_raw.items()}
        diff = round(100.0 - sum(elements_ratio.values()), 1)
        largest = max(elements_ratio, key=elements_ratio.get)
        elements_ratio[largest] = round(elements_ratio[largest] + diff, 1)

        return {
            "elements_ratio": elements_ratio,
            "description": raw.get("description", ""),
        }

    except Exception as e:
        raise RuntimeError(f"Gemini 回應解析失敗：{e}") from e
