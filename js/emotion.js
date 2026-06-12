/* =========================================================
   emotion.js — 第三頁：Russell 環形情感模型情緒分析
   ========================================================= */

const API_BASE = (
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === 'localhost' ||
  window.location.protocol === 'file:'
) ? 'http://127.0.0.1:8000' : 'https://landscape-mci8.onrender.com';

// ── Russell 8 情緒設定 ────────────────────────────────────
const EMOTION_CONFIG = {
  '驚奇': { icon: '✨', v:  0.5, a:  1.0, color: '#a78bfa', def: '評估街景是否充滿視覺衝擊、新奇建築或動態事件，引發高昂的心理激發狀態。' },
  '愉快': { icon: '😊', v:  1.0, a:  0.5, color: '#fbbf24', def: '評估街景的視覺比例、美學價值與空間尺度是否和諧宜人，帶來正向喜悅感。' },
  '滿足': { icon: '😌', v:  1.0, a: -0.5, color: '#34d399', def: '評估空間的明亮度、通透度與安全感，是否具備高度的領域感與安心舒適感。' },
  '放鬆': { icon: '🌿', v:  0.5, a: -1.0, color: '#5c8aff', def: '評估空間中的自然元素（綠化、水體）比例，是否能啟動大腦注意力恢復機制以釋放壓力。' },
  '疲憊': { icon: '😴', v: -0.5, a: -1.0, color: '#94a3b8', def: '評估街景是否高度單調乏味（如大面積死板水泥牆、無生機空地），導致視覺與心理疲勞。' },
  '沮喪': { icon: '😔', v: -1.0, a: -0.5, color: '#6b7280', def: '評估環境是否呈現衰退破敗、破舊或被遺棄的荒涼狀態，引發心理低落感。' },
  '緊張': { icon: '😬', v: -1.0, a:  0.5, color: '#f97316', def: '評估是否屬於高壓都市峽谷（建築高聳逼近、天空開闊度極低），車流喧鬧導致感官超載。' },
  '驚恐': { icon: '😨', v: -0.5, a:  1.0, color: '#ef4444', def: '評估空間視覺是否極度混亂失控（雜亂霓虹看板、施工遮蔽、錯綜電線），引發內心煩躁。' },
};
const EMOTION_KEYS = ['驚奇', '愉快', '滿足', '放鬆', '疲憊', '沮喪', '緊張', '驚恐'];

// 後端回傳的情緒色彩遺失時的安全預設值
const DEFAULT_COLOR = { hsl: 'hsl(0, 0%, 50%)', hex: '#7f8c8d', distance: 0, coordinates: null };

// ── DOM 參考 ──────────────────────────────────────────────
const loadingState   = document.getElementById('loading-state');
const errorState     = document.getElementById('error-state');
const resultContent  = document.getElementById('result-content');
const errorMsg       = document.getElementById('error-msg');
const retryBtn       = document.getElementById('retry-btn');
const previewImg     = document.getElementById('preview-img');
const sceneBadge     = document.getElementById('scene-badge');
const colorSwatch    = document.getElementById('color-swatch');
const colorHsl       = document.getElementById('color-hsl');
const colorHex       = document.getElementById('color-hex');
const colorDistance  = document.getElementById('color-distance');
const emotionGrid    = document.getElementById('emotion-grid');
const vaCanvas       = document.getElementById('va-canvas');
const emotionHalo    = document.getElementById('emotion-halo');
const mapCastBtn     = document.getElementById('map-cast-btn');

let abortController    = null;
let radarChartInstance = null;

// ── sessionStorage 讀取 ───────────────────────────────────
function getSessionData() {
  const raw = sessionStorage.getItem('analysisResult');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Base64 → Blob ─────────────────────────────────────────
function base64ToBlob(base64, mimeType) {
  const b64    = base64.includes(',') ? base64.split(',')[1] : base64;
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// ── 主流程：呼叫後端 /api/emotion ────────────────────────
async function runEmotionAnalysis() {
  const data = getSessionData();
  if (!data?.imageBase64) {
    showError('找不到圖片資料，請返回第一頁重新上傳。');
    return;
  }

  loadingState.classList.remove('hidden');
  errorState.classList.add('hidden');
  resultContent.classList.add('hidden');

  const mimeType = data.mime_type || 'image/jpeg';
  const blob     = base64ToBlob(data.imageBase64, mimeType);

  const fd = new FormData();
  fd.append('file', blob, 'image.jpg');
  if (data.sceneType)   fd.append('scene_type',            data.sceneType);
  if (data.description) fd.append('landscape_description', data.description);
  // 只有真實 EXIF GPS 才傳給後端（避免用預設座標污染地圖資料庫）
  if (data.hasRealGps && data.latitude  != null) fd.append('latitude',  data.latitude);
  if (data.hasRealGps && data.longitude != null) fd.append('longitude', data.longitude);

  abortController = new AbortController();

  try {
    const res = await fetch(`${API_BASE}/api/emotion`, {
      method: 'POST',
      body:   fd,
      signal: abortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const result = await res.json();
    loadingState.classList.add('hidden');
    renderResult(data, result);
    resultContent.classList.remove('hidden');

  } catch (e) {
    if (e.name === 'AbortError') return;
    showError(e.message || '情緒分析失敗，請稍後再試。');
  }
}

// ════════════════════════════════════════════════════════
// 渲染整頁結果（含防禦性 fallback）
// ════════════════════════════════════════════════════════
function renderResult(sessionData, result) {

  // 照片預覽
  if (sessionData.imageBase64) {
    const mime = sessionData.mime_type || 'image/jpeg';
    const src  = sessionData.imageBase64.startsWith('data:')
      ? sessionData.imageBase64
      : `data:${mime};base64,${sessionData.imageBase64}`;
    previewImg.src = src;
    previewImg.classList.remove('hidden');
  }

  // 場域標籤
  if (sessionData.sceneType) {
    sceneBadge.textContent = sessionData.sceneType;
    sceneBadge.classList.remove('hidden');
  }

  // ── 情緒色彩（有 fallback，不崩潰）──────────────────────
  let c = DEFAULT_COLOR;
  try {
    if (result.color && result.color.hsl && result.color.hex) {
      c = result.color;
    }
    colorSwatch.style.background = c.hsl;
    colorSwatch.style.boxShadow  = `0 0 60px 15px ${c.hex}55`;
    colorHsl.textContent         = c.hsl;
    colorHex.textContent         = c.hex.toUpperCase();
    colorDistance.textContent    = c.distance != null
      ? `強度 ${(c.distance * 100).toFixed(0)}%`
      : '強度 —%';
  } catch (e) {
    console.error('情緒色彩渲染出錯:', e);
    colorSwatch.style.background = DEFAULT_COLOR.hsl;
    colorHsl.textContent         = DEFAULT_COLOR.hsl;
    colorHex.textContent         = DEFAULT_COLOR.hex.toUpperCase();
    colorDistance.textContent    = '強度 —%';
  }

  // 動態背景光暈
  try {
    if (emotionHalo) {
      const hsla = c.hsl.replace('hsl(', 'hsla(').replace(')', ', 0.15)');
      emotionHalo.style.background =
        `radial-gradient(ellipse at 50% 25%, ${hsla} 0%, transparent 65%)`;
    }
  } catch (_) {}

  // ── 8 項卡片 / 雷達圖 / V-A 圖（各自隔離，不互相拖累）──
  try { renderEmotionCards(result); } catch (e) { console.error('情緒卡片渲染出錯:', e); }
  try { renderRadarChart(result);   } catch (e) { console.error('雷達圖渲染出錯:', e); }
  try { renderVAMap(result, c.coordinates); } catch (e) { console.error('V-A 圖渲染出錯:', e); }

  // ── 投放按鈕：無論有無 GPS 都顯示；hasRealGps 旗標傳給地圖頁 ──
  try {
    const dominant = EMOTION_KEYS.reduce((best, key) => {
      const bestScore = result[best]?.score ?? 0;
      const thisScore = result[key]?.score  ?? 0;
      return thisScore > bestScore ? key : best;
    }, EMOTION_KEYS[0]);

    const hasRealGps = !!sessionData.hasRealGps;

    sessionStorage.setItem('emotionFocusRequest', JSON.stringify({
      latitude:         sessionData.latitude,
      longitude:        sessionData.longitude,
      hex_color:        c.hex,
      dominant_emotion: dominant,
      score:            result[dominant]?.score ?? 1,
      scene_type:       sessionData.sceneType   || null,
      hasRealGps,
      // 地圖頁手動釘選時需要的完整資料
      emotion_scores: Object.fromEntries(
        EMOTION_KEYS.map(k => [k, result[k]?.score ?? 1])
      ),
      description: sessionData.description || null,
    }));

    if (mapCastBtn) mapCastBtn.classList.remove('hidden');
  } catch (e) {
    console.error('投放按鈕邏輯出錯:', e);
  }
}

// ── 8 項情緒卡片 ──────────────────────────────────────────
function renderEmotionCards(result) {
  emotionGrid.innerHTML = '';
  EMOTION_KEYS.forEach(key => {
    const cfg   = EMOTION_CONFIG[key];
    // 防禦：result[key] 遺失時使用預設值
    const item  = (result[key] && typeof result[key].score === 'number')
      ? result[key]
      : { score: 1, reason: '無法取得評分資料。' };
    const score = Math.max(1, Math.min(5, item.score || 1));

    const dots = Array.from({ length: 5 }, (_, i) => {
      const filled = i < score;
      return `<span class="inline-block w-3 h-3 rounded-full transition-all ${filled ? 'scale-110' : 'opacity-30'}"
              style="background:${filled ? cfg.color : '#4a4a6a'}"></span>`;
    }).join('');

    const card = document.createElement('div');
    card.className = 'bg-surface border border-border rounded-xl p-5 flex flex-col gap-3 animate-fadeUp';
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-xl">${cfg.icon}</span>
          <span class="font-semibold text-white text-sm">${key}</span>
        </div>
        <span class="font-mono text-xs px-2 py-0.5 rounded-full border"
              style="color:${cfg.color}; border-color:${cfg.color}44; background:${cfg.color}11">
          ${score} / 5
        </span>
      </div>
      <div class="flex items-center gap-1.5">${dots}</div>
      <p class="text-white/70 text-xs leading-relaxed">${item.reason || ''}</p>
      <p class="text-muted/55 text-[0.68rem] leading-relaxed border-t border-border/50 pt-2">${cfg.def}</p>
    `;
    emotionGrid.appendChild(card);
  });
}

// ── Radar Chart ───────────────────────────────────────────
function renderRadarChart(result) {
  const canvas = document.getElementById('radar-chart');
  if (!canvas) return;

  // 防禦：score 遺失時預設為 1
  const scores = EMOTION_KEYS.map(k => result[k]?.score ?? 1);
  const colors = EMOTION_KEYS.map(k => EMOTION_CONFIG[k].color);

  if (radarChartInstance) { radarChartInstance.destroy(); radarChartInstance = null; }

  radarChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'radar',
    data: {
      labels: EMOTION_KEYS,
      datasets: [{
        data:                 scores,
        backgroundColor:      'rgba(92,138,255,0.12)',
        borderColor:          '#5c8aff',
        borderWidth:          2,
        pointBackgroundColor: colors,
        pointBorderColor:     colors,
        pointRadius:          5,
        pointHoverRadius:     7,
      }],
    },
    options: {
      scales: {
        r: {
          min: 0, max: 5,
          ticks:      { stepSize: 1, display: false },
          grid:       { color: '#2e2e42' },
          angleLines: { color: '#3e3e5a' },
          pointLabels: {
            color: colors,
            font: { size: 13, family: '"Noto Sans TC", "Segoe UI", sans-serif', weight: '600' },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(26,26,36,.95)',
          borderColor:     '#2e2e42',
          borderWidth:     1,
          callbacks: { label: (ctx) => `  ${EMOTION_KEYS[ctx.dataIndex]}：${ctx.parsed.r} / 5` },
          bodyFont: { family: '"Noto Sans TC", "Segoe UI", sans-serif', size: 13 },
          padding: 10,
        },
      },
      animation: { duration: 900 },
    },
  });
}

// ── V-A 座標圖（SVG）─────────────────────────────────────
function renderVAMap(result, centroid) {
  const SIZE  = vaCanvas.clientWidth || 320;
  const CX    = SIZE / 2;
  const CY    = SIZE / 2;
  const SCALE = SIZE * 0.38;

  vaCanvas.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  vaCanvas.innerHTML = '';

  for (let r = 1; r <= 3; r++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', CX); c.setAttribute('cy', CY);
    c.setAttribute('r', SCALE * r / 3);
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', '#2e2e42'); c.setAttribute('stroke-width', '1');
    vaCanvas.appendChild(c);
  }

  [[[CX, CY - SCALE - 10], [CX, CY + SCALE + 10]],
   [[CX - SCALE - 10, CY], [CX + SCALE + 10, CY]]].forEach(([[x1,y1],[x2,y2]]) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', '#3e3e5a'); line.setAttribute('stroke-width', '1');
    vaCanvas.appendChild(line);
  });

  [
    { text: '高喚醒', x: CX,              y: CY - SCALE - 14, anchor: 'middle' },
    { text: '低喚醒', x: CX,              y: CY + SCALE + 22, anchor: 'middle' },
    { text: '正向',   x: CX + SCALE + 14, y: CY + 4,          anchor: 'start'  },
    { text: '負向',   x: CX - SCALE - 14, y: CY + 4,          anchor: 'end'    },
  ].forEach(({ text, x, y, anchor }) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('text-anchor', anchor);
    t.setAttribute('fill', '#8888aa'); t.setAttribute('font-size', '10');
    t.setAttribute('font-family', 'Noto Sans TC, sans-serif');
    t.textContent = text;
    vaCanvas.appendChild(t);
  });

  EMOTION_KEYS.forEach(key => {
    const cfg     = EMOTION_CONFIG[key];
    const score   = result[key]?.score ?? 1;
    const px      = CX + cfg.v * SCALE;
    const py      = CY - cfg.a * SCALE;
    const r       = 4 + score * 1.5;
    const opacity = 0.3 + score * 0.14;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', px); circle.setAttribute('cy', py);
    circle.setAttribute('r', r); circle.setAttribute('fill', cfg.color);
    circle.setAttribute('opacity', opacity);
    vaCanvas.appendChild(circle);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', px); label.setAttribute('y', py - r - 3);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', cfg.color); label.setAttribute('font-size', '9');
    label.setAttribute('font-family', 'Noto Sans TC, sans-serif');
    label.setAttribute('opacity', Math.min(1, opacity + 0.2));
    label.textContent = key;
    vaCanvas.appendChild(label);
  });

  // centroid 來自 result.color.coordinates，可能為 null
  if (centroid && centroid.valence != null && centroid.arousal != null) {
    const px = CX + centroid.valence * SCALE;
    const py = CY - centroid.arousal * SCALE;

    const dashLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    dashLine.setAttribute('x1', CX); dashLine.setAttribute('y1', CY);
    dashLine.setAttribute('x2', px); dashLine.setAttribute('y2', py);
    dashLine.setAttribute('stroke', '#5c8aff'); dashLine.setAttribute('stroke-width', '1.5');
    dashLine.setAttribute('stroke-dasharray', '4 3'); dashLine.setAttribute('opacity', '0.6');
    vaCanvas.appendChild(dashLine);

    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    outer.setAttribute('cx', px); outer.setAttribute('cy', py); outer.setAttribute('r', '10');
    outer.setAttribute('fill', 'none'); outer.setAttribute('stroke', '#5c8aff');
    outer.setAttribute('stroke-width', '2'); outer.setAttribute('opacity', '0.5');
    vaCanvas.appendChild(outer);

    const inner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    inner.setAttribute('cx', px); inner.setAttribute('cy', py);
    inner.setAttribute('r', '5'); inner.setAttribute('fill', '#5c8aff');
    vaCanvas.appendChild(inner);

    const centLbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    centLbl.setAttribute('x', px + 13); centLbl.setAttribute('y', py + 4);
    centLbl.setAttribute('fill', '#5c8aff'); centLbl.setAttribute('font-size', '10');
    centLbl.setAttribute('font-weight', 'bold');
    centLbl.setAttribute('font-family', 'Noto Sans TC, sans-serif');
    centLbl.textContent = '情緒重心';
    vaCanvas.appendChild(centLbl);
  }
}

// ── 錯誤顯示 ──────────────────────────────────────────────
function showError(msg) {
  loadingState.classList.add('hidden');
  resultContent.classList.add('hidden');
  errorMsg.textContent = msg;
  errorState.classList.remove('hidden');
}

// ── 啟動 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!loadingState) return;

  // 投放按鈕：確認 map 有無實例後再導航（防止 undefined 報錯）
  mapCastBtn?.addEventListener('click', () => {
    try {
      // 若頁面上有 leafletMap 實例（嵌入模式下），先更新尺寸
      if (typeof leafletMap !== 'undefined' && leafletMap) {
        leafletMap.invalidateSize();
      }
    } catch (_) {}
    window.location.href = 'map.html';
  });

  retryBtn?.addEventListener('click', runEmotionAnalysis);
  runEmotionAnalysis();
});
