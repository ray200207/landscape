from pydantic import BaseModel, Field, model_validator
from typing import Optional
from datetime import datetime


class ElementsRatio(BaseModel):
    """6 大景觀元素視覺佔比（加總應為 100）。"""

    植栽元素: float = Field(..., ge=0, le=100, description="喬木、灌木、草皮")
    藍帶元素: float = Field(..., ge=0, le=100, description="河流、噴泉、運河")
    天際元素: float = Field(..., ge=0, le=100, description="天空、雲層")
    人工硬質: float = Field(..., ge=0, le=100, description="建築立面、鋪面、人行道")
    移動與活絡元素: float = Field(..., ge=0, le=100, description="行人、自行車、車輛")
    干擾視覺遮蔽: float = Field(..., ge=0, le=100, description="施工圍欄、廣告看板、電線桿")

    @model_validator(mode="after")
    def check_sum(self) -> "ElementsRatio":
        total = (
            self.植栽元素 + self.藍帶元素 + self.天際元素
            + self.人工硬質 + self.移動與活絡元素 + self.干擾視覺遮蔽
        )
        if not (99.0 <= total <= 101.0):
            raise ValueError(f"元素比例加總應為 100，目前為 {total:.1f}")
        return self


class UploadResponse(BaseModel):
    image_id: str
    image_base64: str
    mime_type: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    message: str = "圖片上傳成功"


class AnalysisResponse(BaseModel):
    id: str
    elements_ratio: ElementsRatio
    description: str
    scene_type: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    created_at: datetime
