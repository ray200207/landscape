/* =========================================================
   map.js — 第四頁：Russell 情緒色彩地圖
   ========================================================= */

const API_BASE = (
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === 'localhost' ||
  window.location.protocol === 'file:'
) ? 'http://127.0.0.1:8000' : 'https://landscape-mci8.onrender.com';

const EMOTION_ICONS = {
  '驚奇': '✨', '愉快': '😊', '滿足': '😌', '放鬆': '🌿',
  '疲憊': '😴', '沮喪': '😔', '緊張': '😬', '驚恐': '😨',
};

const DEFAULT_CENTER = [23.8, 121.0];
const DEFAULT_ZOOM   = 8;

// ── 工具：#rrggbb → [r, g, b] ─────────────────────────────
function hexToRgb(hex) {
  const h = (hex || '#5c8aff').replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

let leafletMap       = null;
let draggablePin     = null;
let GradientLayerCls = null;

// 所有非底圖圖層（漸層色塊、透明圓、大頭針）統一在此追蹤，方便一鍵清除
let _managedLayers = [];

function _trackLayer(layer) {
  layer.addTo(leafletMap);
  _managedLayers.push(layer);
  return layer;
}

// ════════════════════════════════════════════════════════
// 情緒漸層色塊 Canvas Layer
// ════════════════════════════════════════════════════════
function buildGradientLayerClass() {
  return L.Layer.extend({

    initialize(points) {
      this._points = points;
      this._redraw = this._redraw.bind(this);
    },

    onAdd(map) {
      this._map    = map;
      this._canvas = document.createElement('canvas');
      this._canvas.style.cssText = 'position:absolute;pointer-events:none;';
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('move zoom resize viewreset', this._redraw);
      this._redraw();
    },

    onRemove(map) {
      try { map.getPanes().overlayPane.removeChild(this._canvas); } catch (_) {}
      map.off('move zoom resize viewreset', this._redraw);
    },

    _redraw() {
      try {
        const map     = this._map;
        const size    = map.getSize();
        const canvas  = this._canvas;
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        canvas.width  = size.x;
        canvas.height = size.y;
        L.DomUtil.setPosition(canvas, topLeft);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size.x, size.y);
        for (const pt of this._points) {
          try { this._drawGradient(ctx, map, pt, topLeft); } catch (_) {}
        }
      } catch (e) { console.error('色塊渲染出錯:', e); }
    },

    _drawGradient(ctx, map, pt, topLeft) {
      const layerPt = map.latLngToLayerPoint([pt.latitude, pt.longitude]);
      const cx = layerPt.x - topLeft.x;
      const cy = layerPt.y - topLeft.y;
      const r  = this._metersToPx(map, pt.latitude, 100);
      if (r < 4) return;
      const [red, grn, blu] = hexToRgb(pt.hex_color);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0,    `rgba(${red},${grn},${blu},0.88)`);
      grad.addColorStop(0.40, `rgba(${red},${grn},${blu},0.55)`);
      grad.addColorStop(0.75, `rgba(${red},${grn},${blu},0.18)`);
      grad.addColorStop(1,    `rgba(${red},${grn},${blu},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    },

    _metersToPx(map, lat, meters) {
      const p1 = map.latLngToLayerPoint([lat, 0]);
      const p2 = map.latLngToLayerPoint([lat + meters / 111320, 0]);
      return Math.max(8, Math.abs(p1.y - p2.y));
    },
  });
}

// ════════════════════════════════════════════════════════
// 地圖初始化
// ════════════════════════════════════════════════════════
function initMap() {
  try {
    GradientLayerCls = buildGradientLayerClass();

    leafletMap = L.map('map', {
      center:      DEFAULT_CENTER,
      zoom:        DEFAULT_ZOOM,
      zoomControl: false,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' +
          ' &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
        subdomains: 'abcd',
        maxZoom:    19,
      }
    ).addTo(leafletMap);

    L.control.zoom({ position: 'bottomright' }).addTo(leafletMap);

    const refresh = () => { try { leafletMap.invalidateSize(); } catch (_) {} };
    refresh();
    setTimeout(refresh, 200);
    setTimeout(refresh, 500);

    loadMapPoints();

  } catch (e) {
    console.error('地圖初始化出錯:', e);
    setLoading(false);
  }
}

// ════════════════════════════════════════════════════════
// 載入歷史點位 + 處理情緒焦點請求
// ════════════════════════════════════════════════════════
async function loadMapPoints() {
  setLoading(true);
  try {
    const res = await fetch(`${API_BASE}/api/map-points`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const points = await res.json();

    const countEl = document.getElementById('point-count');
    if (countEl) countEl.textContent = points.length;
    setLoading(false);

    if (points.length === 0) {
      const hasFocus = !!sessionStorage.getItem('emotionFocusRequest');
      if (!hasFocus) showEmpty();
    } else {
      try {
        _trackLayer(new GradientLayerCls(points));
        points.forEach(pt => { try { addClickCircle(pt); } catch (_) {} });
        if (!sessionStorage.getItem('emotionFocusRequest')) {
          const bounds = L.latLngBounds(points.map(p => [p.latitude, p.longitude]));
          leafletMap.fitBounds(bounds.pad(0.3));
        }
      } catch (e) {
        console.error('點位渲染出錯:', e);
      }
    }

  } catch (err) {
    console.error('地圖點位載入失敗:', err);
    setLoading(false);
    if (!sessionStorage.getItem('emotionFocusRequest')) showEmpty();
  }

  checkEmotionFocusRequest();
}

// ════════════════════════════════════════════════════════
// 第三頁「投放」焦點請求處理
// ════════════════════════════════════════════════════════
function checkEmotionFocusRequest() {
  const raw = sessionStorage.getItem('emotionFocusRequest');
  if (!raw) return;

  let req;
  try { req = JSON.parse(raw); } catch { return; }
  sessionStorage.removeItem('emotionFocusRequest');
  if (!req) return;

  // ── 無 GPS：顯示 banner + 啟用點擊放置大頭針 ───────────────
  if (!req.hasRealGps) {
    showNoGpsBanner();
    spawnDraggablePin(req);
    return;
  }

  // ── 有 GPS：flyTo + 渲染色塊 + Popup ──────────────────────
  if (!req.latitude || !req.longitude) return;

  try {
    const emptyEl = document.getElementById('map-empty');
    if (emptyEl) emptyEl.style.display = 'none';

    leafletMap.invalidateSize();
    leafletMap.flyTo([req.latitude, req.longitude], 16, {
      animate: true, duration: 1.8,
    });

    const hexColor = req.hex_color || '#5c8aff';

    _trackLayer(new GradientLayerCls([{
      latitude:  req.latitude,
      longitude: req.longitude,
      hex_color: hexColor,
    }]));

    let imgHtml = '';
    try {
      const sess = JSON.parse(sessionStorage.getItem('analysisResult') || '{}');
      if (sess.imageBase64) {
        const mime = sess.mime_type || 'image/jpeg';
        const src  = sess.imageBase64.startsWith('data:')
          ? sess.imageBase64
          : `data:${mime};base64,${sess.imageBase64}`;
        imgHtml = `<img src="${src}"
          style="width:100%;height:110px;object-fit:cover;border-radius:8px;
                 margin-bottom:10px;display:block">`;
      }
    } catch (_) {}

    _trackLayer(
      L.circle([req.latitude, req.longitude], {
        radius: 100, fillOpacity: 0, opacity: 0, interactive: true,
      })
        .bindPopup(buildFocusPopupHtml(req, imgHtml), {
          maxWidth: 250, className: 'emotion-popup', closeButton: true,
        })
    ).openPopup();

  } catch (e) {
    console.error('地圖焦點定位出錯:', e);
  }
}

// ════════════════════════════════════════════════════════
// 無 GPS 拖曳釘選（同時支援地圖點擊放置）
// ════════════════════════════════════════════════════════
function showNoGpsBanner() {
  const banner = document.getElementById('no-gps-banner');
  if (banner) banner.style.display = 'block';
}

function spawnDraggablePin(req) {
  const pinIcon = L.divIcon({
    className: '',
    html: `<div style="cursor:grab;filter:drop-shadow(0 4px 10px rgba(0,0,0,.7))">
      <svg width="30" height="42" viewBox="0 0 30 42" fill="none">
        <path d="M15 0C6.72 0 0 6.72 0 15c0 10 15 27 15 27S30 25 30 15C30 6.72 23.28 0 15 0z"
              fill="#5c8aff"/>
        <circle cx="15" cy="15" r="7" fill="white"/>
      </svg>
    </div>`,
    iconSize:   [30, 42],
    iconAnchor: [15, 42],
  });

  const center = leafletMap.getCenter();
  draggablePin = L.marker([center.lat, center.lng], {
    draggable: true,
    icon:      pinIcon,
  }).addTo(leafletMap);

  draggablePin.bindTooltip('拖曳至拍照地點，或點擊地圖移動', {
    permanent: false, direction: 'top', offset: [0, -44],
  });

  let pendingLat = null;
  let pendingLng = null;

  function updateCoords(lat, lng) {
    pendingLat = lat;
    pendingLng = lng;
    const coordEl     = document.getElementById('pin-coords');
    const confirmArea = document.getElementById('pin-confirm-area');
    if (coordEl)     coordEl.textContent = `${lat.toFixed(5)}°N,  ${lng.toFixed(5)}°E`;
    if (confirmArea) confirmArea.style.display = 'flex';
  }

  // 拖曳大頭針
  draggablePin.on('dragend', (e) => {
    const ll = e.target.getLatLng();
    updateCoords(ll.lat, ll.lng);
  });

  // 點擊地圖 → 移動大頭針到點擊位置
  const mapClickHandler = (e) => {
    draggablePin.setLatLng([e.latlng.lat, e.latlng.lng]);
    updateCoords(e.latlng.lat, e.latlng.lng);
  };
  leafletMap.on('click', mapClickHandler);

  const confirmBtn = document.getElementById('pin-confirm-btn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (pendingLat === null) return;
      leafletMap.off('click', mapClickHandler);
      await saveLocation(pendingLat, pendingLng, req);
    });
  }
}

async function saveLocation(lat, lng, req) {
  const savingEl    = document.getElementById('pin-saving-msg');
  const successEl   = document.getElementById('pin-success-msg');
  const confirmBtn  = document.getElementById('pin-confirm-btn');
  const confirmArea = document.getElementById('pin-confirm-area');

  if (confirmArea) confirmArea.style.display = 'none';
  if (savingEl)   savingEl.style.display = 'block';

  try {
    const res = await fetch(`${API_BASE}/api/update-location`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        latitude:         lat,
        longitude:        lng,
        hex_color:        req.hex_color        || '#5c8aff',
        dominant_emotion: req.dominant_emotion || '—',
        emotion_scores:   req.emotion_scores   || {},
        description:      req.description      || null,
        scene_type:       req.scene_type       || null,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (savingEl)  savingEl.style.display  = 'none';
    if (successEl) successEl.style.display = 'block';

    if (draggablePin) {
      leafletMap.removeLayer(draggablePin);
      draggablePin = null;
    }

    const hexColor = req.hex_color || '#5c8aff';
    _trackLayer(new GradientLayerCls([{
      latitude: lat, longitude: lng, hex_color: hexColor,
    }]));

    leafletMap.flyTo([lat, lng], 16, { animate: true, duration: 1.8 });

    const newPt = {
      latitude:         lat,
      longitude:        lng,
      hex_color:        hexColor,
      dominant_emotion: req.dominant_emotion || '—',
      emotion_scores:   req.emotion_scores   || {},
      description:      req.description      || null,
      scene_type:       req.scene_type       || null,
      thumbnail_b64:    null,
      created_at:       new Date().toISOString(),
    };
    addClickCircle(newPt);

    const countEl = document.getElementById('point-count');
    if (countEl) {
      const cur = parseInt(countEl.textContent, 10) || 0;
      countEl.textContent = String(cur + 1);
    }

    setTimeout(() => {
      const banner = document.getElementById('no-gps-banner');
      if (banner) {
        banner.style.transition = 'opacity .4s ease';
        banner.style.opacity    = '0';
        setTimeout(() => {
          banner.style.display  = 'none';
          banner.style.opacity  = '';
          banner.style.transition = '';
        }, 420);
      }
    }, 3000);

  } catch (e) {
    console.error('儲存位置失敗:', e);
    if (savingEl)    savingEl.style.display    = 'none';
    if (confirmArea) confirmArea.style.display = 'flex';
    if (confirmBtn) {
      confirmBtn.disabled    = false;
      confirmBtn.textContent = '重試';
    }
    const msgEl = document.getElementById('no-gps-msg');
    if (msgEl) msgEl.innerHTML =
      `<span style="color:#f87171">儲存失敗：${e.message}，請重試</span>`;
  }
}

// ════════════════════════════════════════════════════════
// 透明點擊圓 + Popup（歷史點位）
// ════════════════════════════════════════════════════════
function addClickCircle(pt) {
  _trackLayer(
    L.circle([pt.latitude, pt.longitude], {
      radius:      100,
      fillOpacity: 0,
      opacity:     0,
      interactive: true,
    }).bindPopup(buildPopupHtml(pt), {
      maxWidth:    250,
      className:   'emotion-popup',
      closeButton: true,
    })
  );
}

// ════════════════════════════════════════════════════════
// 一鍵清除所有點位（視覺 + 資料庫）
// ════════════════════════════════════════════════════════
async function clearAllMarks() {
  const count = parseInt(
    (document.getElementById('point-count') || {}).textContent || '0', 10
  );
  const msg = count > 0
    ? `確認清除地圖上所有 ${count} 個點位？\n此操作同時移除資料庫記錄且無法復原。`
    : '確認清除地圖並重置視圖？';

  if (!window.confirm(msg)) return;

  // 1. 清除資料庫
  try {
    const res = await fetch(`${API_BASE}/api/map-points`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error('清除 DB 失敗:', e);
    alert('清除點位失敗：' + e.message);
    return;
  }

  // 2. 移除所有已追蹤的圖層
  for (const layer of _managedLayers) {
    try { leafletMap.removeLayer(layer); } catch (_) {}
  }
  _managedLayers = [];

  // 3. 移除拖曳大頭針
  if (draggablePin) {
    try { leafletMap.removeLayer(draggablePin); } catch (_) {}
    draggablePin = null;
  }

  // 4. 隱藏 banner
  const banner = document.getElementById('no-gps-banner');
  if (banner) {
    banner.style.display  = 'none';
    banner.style.opacity  = '';
    banner.style.transition = '';
  }

  // 5. 重置計數
  const countEl = document.getElementById('point-count');
  if (countEl) countEl.textContent = '0';

  // 6. 回到台灣全景
  leafletMap.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true });

  // 7. 清除 session 焦點請求（避免下次開頁觸發舊請求）
  sessionStorage.removeItem('emotionFocusRequest');
}

// ════════════════════════════════════════════════════════
// Popup HTML 建構
// ════════════════════════════════════════════════════════
function buildFocusPopupHtml(req, imgHtml = '') {
  const icon     = EMOTION_ICONS[req.dominant_emotion] || '●';
  const hexColor = req.hex_color || '#5c8aff';
  return `
    <div style="font-family:'Noto Sans TC',sans-serif;color:#e0e0f0;min-width:200px">
      ${imgHtml}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="width:11px;height:11px;border-radius:50%;background:${hexColor};
                     flex-shrink:0;display:inline-block;box-shadow:0 0 7px ${hexColor}99"></span>
        <span style="font-weight:700;font-size:14px">${icon} ${req.dominant_emotion || '—'}</span>
        <span style="margin-left:auto;font-size:11px;color:#8888aa;font-family:monospace">
          ${req.score ?? '—'} / 5
        </span>
      </div>
      <p style="font-size:10px;color:#8888aa;font-family:monospace">
        ${Number(req.latitude).toFixed(5)}°N, ${Number(req.longitude).toFixed(5)}°E
      </p>
      ${req.scene_type
        ? `<span style="display:inline-block;margin-top:6px;font-size:10px;padding:2px 8px;
                        border-radius:10px;background:#2e2e42;color:#8888aa">
             ${req.scene_type}
           </span>`
        : ''}
    </div>`;
}

function buildPopupHtml(pt) {
  const icon     = EMOTION_ICONS[pt.dominant_emotion] || '●';
  const scores   = pt.emotion_scores || {};
  const score    = scores[pt.dominant_emotion] ?? '–';
  const hexColor = pt.hex_color || '#5c8aff';
  const dateStr  = pt.created_at
    ? new Date(pt.created_at).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      })
    : '';

  const imgHtml = pt.thumbnail_b64
    ? `<img src="data:image/jpeg;base64,${pt.thumbnail_b64}"
            style="width:100%;height:130px;object-fit:cover;border-radius:8px;
                   margin-bottom:10px;display:block">`
    : '';

  const descHtml = pt.description
    ? `<p style="font-size:11px;color:#c0c0d0;line-height:1.6;margin:0 0 8px">
         ${pt.description.slice(0, 90)}${pt.description.length > 90 ? '…' : ''}
       </p>`
    : '';

  const sceneHtml = pt.scene_type
    ? `<span style="font-size:10px;padding:2px 8px;border-radius:10px;
                    background:#2e2e42;color:#8888aa">${pt.scene_type}</span>`
    : '';

  return `
    <div style="font-family:'Noto Sans TC',sans-serif;color:#e0e0f0">
      ${imgHtml}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="width:12px;height:12px;border-radius:50%;background:${hexColor};
                     flex-shrink:0;display:inline-block;box-shadow:0 0 8px ${hexColor}88"></span>
        <span style="font-weight:700;font-size:14px">${icon} ${pt.dominant_emotion || '—'}</span>
        <span style="margin-left:auto;font-size:11px;color:#8888aa;font-family:monospace">
          ${score} / 5
        </span>
      </div>
      ${descHtml}
      <div style="display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#666">
        ${sceneHtml}
        <span style="font-family:monospace">${dateStr}</span>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════
// UI 狀態控制
// ════════════════════════════════════════════════════════
function setLoading(on) {
  const el = document.getElementById('map-loading');
  if (el) el.style.display = on ? 'flex' : 'none';
}

function showEmpty() {
  const el = document.getElementById('map-empty');
  if (el) el.style.display = 'flex';
}

// ── 啟動 ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('map')) {
    initMap();
  }

  // 清除點位按鈕
  const clearBtn = document.getElementById('clear-map-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearAllMarks);
  }
});
