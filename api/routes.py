"""API 路由

POST   /api/upload            — 上傳並驗證圖片，提取 EXIF GPS
POST   /api/analyze           — AI 景觀元素分析（支援 AbortController 取消）
DELETE /api/upload/{image_id} — 清除暫存圖片
"""
import asyncio
import base64
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database.db import get_db
from database.models import AnalysisHistory
from models.schemas import AnalysisResponse, ElementsRatio, UploadResponse
from services.ai_service import analyze_landscape
from services.exif_service import extract_gps_coordinates

router = APIRouter()

# 暫存上傳圖片（正式環境請改用 Redis / S3）
_image_store: dict[str, dict] = {}


def _validate_file(content_type: Optional[str], size: int) -> None:
    """後端安全防線：驗證 MIME 類型與檔案大小（防範繞過前端的惡意請求）。"""
    if content_type not in settings.allowed_mime_types:
        raise HTTPException(
            status_code=415,
            detail=f"不支援的檔案格式（{content_type}）。僅接受 JPG、PNG、WEBP。",
        )
    if size > settings.max_file_size_bytes:
        mb = size / 1024 / 1024
        raise HTTPException(
            status_code=413,
            detail=f"檔案大小 {mb:.1f} MB 超過 4 MB 上限。",
        )


@router.post("/upload", response_model=UploadResponse, summary="上傳並驗證圖片")
async def upload_image(file: UploadFile = File(...)):
    """接收圖片，進行後端二次驗證，提取 EXIF GPS 並暫存。"""
    content = await file.read()
    _validate_file(file.content_type, len(content))

    # 提取 EXIF GPS 座標
    latitude, longitude = extract_gps_coordinates(content)

    image_id = str(uuid.uuid4())
    image_b64 = base64.b64encode(content).decode("utf-8")

    _image_store[image_id] = {
        "base64": image_b64,
        "mime_type": file.content_type,
        "latitude": latitude,
        "longitude": longitude,
    }

    return UploadResponse(
        image_id=image_id,
        image_base64=image_b64,
        mime_type=file.content_type or "image/jpeg",
        latitude=latitude,
        longitude=longitude,
    )


@router.post("/analyze", response_model=AnalysisResponse, summary="AI 景觀元素分析")
async def analyze_image(
    request: Request,
    image_id: str = Form(...),
    scene_type: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
):
    """
    對已上傳圖片進行 AI 景觀元素分析。

    支援前端 AbortController：後端輪詢連接狀態，
    一旦前端取消請求即終止分析，節省運算資源。
    """
    stored = _image_store.get(image_id)
    if not stored:
        raise HTTPException(status_code=404, detail="找不到圖片，請重新上傳。")

    try:
        analyze_task = asyncio.create_task(
            analyze_landscape(
                image_base64=stored["base64"],
                scene_type=scene_type,
            )
        )

        # 輪詢連接狀態，支援提前中斷
        while not analyze_task.done():
            if await request.is_disconnected():
                analyze_task.cancel()
                raise asyncio.CancelledError()
            await asyncio.sleep(0.2)

        result = await analyze_task

    except asyncio.CancelledError:
        raise HTTPException(status_code=499, detail="分析已取消")
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失敗：{e}")

    # 建立 ElementsRatio Pydantic 模型（含加總驗證）
    er_raw = result["elements_ratio"]
    try:
        elements = ElementsRatio(
            植栽元素=er_raw.get("植栽元素", 0),
            藍帶元素=er_raw.get("藍帶元素", 0),
            天際元素=er_raw.get("天際元素", 0),
            人工硬質=er_raw.get("人工硬質", 0),
            移動與活絡元素=er_raw.get("移動與活絡元素", 0),
            干擾視覺遮蔽=er_raw.get("干擾視覺遮蔽", 0),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"元素比例驗證失敗：{e}")

    analysis_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    # 寫入資料庫
    record = AnalysisHistory(
        id=analysis_id,
        image_base64=stored["base64"],
        scene_type=scene_type,
        elements_ratio=er_raw,
        description=result["description"],
        latitude=stored.get("latitude"),
        longitude=stored.get("longitude"),
        created_at=now,
    )
    db.add(record)
    await db.commit()

    return AnalysisResponse(
        id=analysis_id,
        elements_ratio=elements,
        description=result["description"],
        scene_type=scene_type,
        latitude=stored.get("latitude"),
        longitude=stored.get("longitude"),
        created_at=now,
    )


@router.delete("/upload/{image_id}", summary="清除暫存圖片")
async def delete_image(image_id: str):
    _image_store.pop(image_id, None)
    return {"message": "已清除"}
