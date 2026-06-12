"""EXIF 資訊提取服務

解析上傳圖片的 GPS 經緯度。
若圖片無 EXIF 或無 GPS 資訊，回傳 (None, None)，不阻斷上傳流程。
"""
from io import BytesIO
from typing import Optional, Tuple

from PIL import Image
import piexif


def extract_gps_coordinates(image_data: bytes) -> Tuple[Optional[float], Optional[float]]:
    """
    從圖片二進位資料中提取 GPS 座標。

    Returns:
        (latitude, longitude) — 若無 GPS 資訊則回傳 (None, None)
    """
    try:
        img = Image.open(BytesIO(image_data))
        exif_raw = img.info.get("exif")
        if not exif_raw:
            return None, None

        exif_data = piexif.load(exif_raw)
        gps_ifd = exif_data.get("GPS", {})
        if not gps_ifd:
            return None, None

        lat_data = gps_ifd.get(piexif.GPSIFD.GPSLatitude)
        lat_ref_raw = gps_ifd.get(piexif.GPSIFD.GPSLatitudeRef, b"N")
        lon_data = gps_ifd.get(piexif.GPSIFD.GPSLongitude)
        lon_ref_raw = gps_ifd.get(piexif.GPSIFD.GPSLongitudeRef, b"E")

        if not lat_data or not lon_data:
            return None, None

        lat_ref = lat_ref_raw.decode() if isinstance(lat_ref_raw, bytes) else lat_ref_raw
        lon_ref = lon_ref_raw.decode() if isinstance(lon_ref_raw, bytes) else lon_ref_raw

        latitude = _dms_to_decimal(lat_data, lat_ref)
        longitude = _dms_to_decimal(lon_data, lon_ref)
        return latitude, longitude

    except Exception:
        # 任何 EXIF 解析錯誤都不阻斷上傳
        return None, None


def _dms_to_decimal(dms: tuple, ref: str) -> float:
    """將 DMS（度分秒）轉換為十進位度數。"""
    degrees = dms[0][0] / dms[0][1]
    minutes = dms[1][0] / dms[1][1] / 60.0
    seconds = dms[2][0] / dms[2][1] / 3600.0
    result = degrees + minutes + seconds
    if ref in ("S", "W"):
        result = -result
    return round(result, 7)
