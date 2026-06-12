/* =========================================================
   result.js — 第二頁：分析結果展示與圓環圖渲染
   ========================================================= */

// ── 元素設定（顏色 + 圖示）───────────────────────────────
const ELEMENT_CONFIG = {
  '植栽元素':      { color: '#5cff8c', label: '植栽元素', icon: '🌳', desc: '喬木、灌木、草皮' },
  '藍帶元素':      { color: '#5cc8ff', label: '藍帶元素', icon: '💧', desc: '河流、噴泉、運河' },
  '天際元素':      { color: '#5c8aff', label: '天際元素', icon: '☁️', desc: '天空、雲層' },
  '人工硬質':      { color: '#a0a0cc', label: '人工硬質', icon: '🏗️', desc: '建築立面、鋪面' },
  '移動與活絡元素': { color: '#ffcc5c', label: '移動與活絡元素', icon: '🚶', desc: '行人、車輛' },
  '干擾視覺遮蔽':  { color: '#ff6b6b', label: '干擾視覺遮蔽', icon: '⚠️', desc: '廣告、圍欄、電線' },
};

// ── DOM 參考 ──────────────────────────────────────────────
const noData        = document.getElementById('no-data');
const resultContent = document.getElementById('result-content');
const originalImg   = document.getElementById('original-img');
const sceneBadge    = document.getElementById('scene-badge');
const gpsBadge      = document.getElementById('gps-badge');
const gpsCard       = document.getElementById('gps-card');
const gpsCoords     = document.getElementById('gps-coords');
const createdAtEl   = document.getElementById('created-at');
const elementsList  = document.getElementById('elements-list');
const descText      = document.getElementById('description-text');
const dominantPct   = document.getElementById('dominant-pct');
const dominantName  = document.getElementById('dominant-name');

// ── 讀取 sessionStorage 並初始化 ─────────────────────────
function loadResult() {
  const raw = sessionStorage.getItem('analysisResult');
  if (!raw) {
    noData.classList.remove('hidden');
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    noData.classList.remove('hidden');
    return;
  }

  resultContent.classList.remove('hidden');
  renderResult(data);
}

// ── 主渲染函式 ────────────────────────────────────────────
function renderResult(data) {

  // 原始圖片
  if (data.imageBase64) {
    // 嘗試判斷 MIME，預設 jpeg
    const mime = data.mime_type || 'image/jpeg';
    originalImg.src = `data:${mime};base64,${data.imageBase64}`;
  }

  // 場域標籤
  const sceneType = data.sceneType || data.scene_type;
  if (sceneType) {
    sceneBadge.textContent = sceneType;
    sceneBadge.classList.remove('hidden');
  }

  // GPS 資訊
  const lat = data.latitude;
  const lon = data.longitude;
  if (lat != null && lon != null) {
    gpsBadge.classList.remove('hidden');
    gpsCard.classList.remove('hidden');
    gpsCoords.textContent = `${lat.toFixed(6)}°N,  ${lon.toFixed(6)}°E`;
  }

  // 建立時間
  if (data.created_at) {
    const d = new Date(data.created_at);
    createdAtEl.textContent = d.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // 環境特性說明
  descText.textContent = data.description || '（無法取得景觀說明）';

  // 元素比例
  const er = data.elements_ratio;
  if (!er) return;

  // 排序（由高至低）
  const entries = Object.entries(er).sort(([, a], [, b]) => b - a);

  // 環形圖中心：最高比例元素
  const [topName, topVal] = entries[0];
  dominantPct.textContent  = `${topVal}%`;
  dominantName.textContent = topName;

  renderElementsList(entries);
  renderPieChart(entries);
}

// ── 元素列表 + 進度條 ─────────────────────────────────────
function renderElementsList(entries) {
  elementsList.innerHTML = '';

  entries.forEach(([name, pct]) => {
    const cfg = ELEMENT_CONFIG[name] || { color: '#8888aa', icon: '●', desc: '' };

    const li = document.createElement('li');
    li.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:5px;">
        <div style="display:flex; align-items:center; gap:8px; font-size:.83rem;">
          <span>${cfg.icon}</span>
          <span style="color:#d4d4e8">${name}</span>
          <span style="color:#8888aa; font-size:.72rem; font-family:monospace">${cfg.desc}</span>
        </div>
        <span style="font-family:monospace; font-size:.83rem; font-weight:700; color:${cfg.color}">${pct}%</span>
      </div>
      <div style="width:100%; background:#2e2e42; border-radius:4px; height:5px; overflow:hidden;">
        <div class="bar-fill" style="height:100%; width:0%; border-radius:4px; background:${cfg.color};"
             data-target="${pct}"></div>
      </div>
    `;
    elementsList.appendChild(li);
  });

  // 觸發進度條動畫（等兩個 frame 確保 CSS transition 生效）
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.bar-fill').forEach(bar => {
      bar.style.width = bar.dataset.target + '%';
    });
  }));
}

// ── 圓環圖 (Chart.js Doughnut) ────────────────────────────
function renderPieChart(entries) {
  const labels  = entries.map(([n]) => n);
  const values  = entries.map(([, v]) => v);
  const colors  = entries.map(([n]) => (ELEMENT_CONFIG[n] || {}).color || '#8888aa');

  const ctx = document.getElementById('pie-chart').getContext('2d');

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => hexAlpha(c, 0.78)),
        borderColor: colors,
        borderWidth: 2,
        hoverOffset: 10,
      }],
    },
    options: {
      cutout: '62%',
      animation: { animateRotate: true, duration: 950 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(26,26,36,.95)',
          borderColor: '#2e2e42',
          borderWidth: 1,
          callbacks: {
            label: (ctx) => `  ${ctx.label}：${ctx.parsed}%`,
          },
          bodyFont: { family: '"Noto Sans TC", "Segoe UI", sans-serif', size: 13 },
          padding: 10,
        },
      },
    },
  });
}

// ── 工具：Hex 轉 rgba ─────────────────────────────────────
function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── 初始化 ────────────────────────────────────────────────
loadResult();
