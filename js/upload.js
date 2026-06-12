/* =========================================================
   upload.js — 第一頁：照片上傳與分析觸發邏輯
   ========================================================= */

const API_BASE = (
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === 'localhost' ||
  window.location.protocol === 'file:'
) ? 'http://127.0.0.1:8000' : 'https://landscape-mci8.onrender.com';

// ── DOM 參考 ──────────────────────────────────────────────
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const dropDefault  = document.getElementById('drop-default');
const dropHover    = document.getElementById('drop-hover');
const dropPreview  = document.getElementById('drop-preview');
const previewImg   = document.getElementById('preview-img');
const clearBtn     = document.getElementById('clear-btn');
const fileLabel    = document.getElementById('file-name-label');
const gpsBadge     = document.getElementById('gps-badge');
const sceneGroup   = document.getElementById('scene-group');
const analyzeBtn   = document.getElementById('analyze-btn');
const loadingArea  = document.getElementById('loading-area');
const loadingText  = document.getElementById('loading-text');
const cancelBtn    = document.getElementById('cancel-btn');
const toastCont    = document.getElementById('toast-container');

// ── 狀態 ──────────────────────────────────────────────────
let uploadedImageId = null;
let uploadedBase64  = null;
let uploadedFile    = null;
let selectedScene   = null;
let abortController = null;
let uploadedGPS     = { lat: null, lon: null };

// ── Toast 通知 ────────────────────────────────────────────
function showToast(message, type = 'error') {
  const styles = {
    error:   'bg-red-900/90 border-red-700/60',
    success: 'bg-green-900/90 border-green-700/60',
    info:    'bg-[#1a1a40]/90 border-[#5c8aff]/40',
  };
  const icons = { error: '⚠️', success: '✅', info: 'ℹ️' };

  const el = document.createElement('div');
  el.style.animation = 'toastIn 0.3s ease';
  el.style.cssText = `
    display:flex; align-items:flex-start; gap:8px;
    padding:12px 16px; border-radius:12px; font-size:0.83rem;
    color:#fff; pointer-events:auto; border:1px solid;
    box-shadow:0 4px 20px rgba(0,0,0,.45); backdrop-filter:blur(8px);
  `;
  el.className = `border rounded-xl ${styles[type] || styles.error}`;
  el.innerHTML = `<span style="margin-top:1px;flex-shrink:0">${icons[type] || icons.error}</span><span>${message}</span>`;
  toastCont.appendChild(el);

  setTimeout(() => {
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateX(8px)';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ── 拖曳區狀態切換 ───────────────────────────────────────
function setZoneState(state) {
  // state: 'default' | 'hover' | 'preview'
  const show  = (el, visible) => el.classList.toggle('hidden', !visible);
  const flex  = (el, visible) => el.classList.toggle('flex', visible);

  show(dropDefault, state === 'default');
  show(dropHover,   state === 'hover');
  flex(dropHover,   state === 'hover');
  show(dropPreview, state === 'preview');
}

// ── 前端檔案驗證 ──────────────────────────────────────────
function validateFile(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    showToast('格式不支援，請上傳 JPG、PNG 或 WEBP 圖片。');
    return false;
  }
  if (file.size > 4 * 1024 * 1024) {
    showToast('⚠️ 檔案大小已超過 4 MB 限制，請壓縮後再試。');
    return false;
  }
  return true;
}

// ── 處理選定的檔案 ────────────────────────────────────────
async function handleFile(file) {
  if (!validateFile(file)) return;

  uploadedFile = file;

  // 本地預覽
  const reader = new FileReader();
  reader.onload = (e) => {
    previewImg.src = e.target.result;
    setZoneState('preview');
    fileLabel.textContent = truncate(file.name, 28);
  };
  reader.readAsDataURL(file);

  // 上傳至後端（取得 GPS + base64）
  await uploadToBackend(file);
}

function truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// ── 上傳 API ──────────────────────────────────────────────
async function uploadToBackend(file) {
  const fd = new FormData();
  fd.append('file', file);

  try {
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.detail || '上傳失敗，請重試。');
      resetUpload();
      return;
    }

    uploadedImageId = data.image_id;
    uploadedBase64  = data.image_base64;
    uploadedGPS     = { lat: data.latitude, lon: data.longitude };

    if (data.latitude !== null && data.longitude !== null) {
      gpsBadge.classList.remove('hidden');
    }

    analyzeBtn.disabled = false;
    showToast('圖片上傳成功！', 'success');

  } catch (err) {
    showToast('無法連線至分析伺服器，請確認已執行 run_server.py。');
    resetUpload();
  }
}

// ── 重設上傳狀態 ──────────────────────────────────────────
function resetUpload() {
  uploadedImageId = null;
  uploadedBase64  = null;
  uploadedFile    = null;
  uploadedGPS     = { lat: null, lon: null };
  fileInput.value = '';
  previewImg.src  = '';
  gpsBadge.classList.add('hidden');
  analyzeBtn.disabled = true;
  setZoneState('default');
}

// ── 場域類型選擇 ──────────────────────────────────────────
sceneGroup.querySelectorAll('.scene-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const scene = btn.dataset.scene;
    if (selectedScene === scene) {
      selectedScene = null;
      btn.classList.remove('active');
    } else {
      sceneGroup.querySelectorAll('.scene-pill').forEach(b => b.classList.remove('active'));
      selectedScene = scene;
      btn.classList.add('active');
    }
  });
});

// ── 開始分析 ──────────────────────────────────────────────
analyzeBtn.addEventListener('click', async () => {
  if (!uploadedFile) return;

  // 切換 UI 至「分析中」
  analyzeBtn.classList.add('hidden');
  loadingArea.classList.remove('hidden');
  loadingArea.classList.add('flex');

  abortController = new AbortController();

  // 輪播提示文字
  const messages = [
    '正在分析景觀元素…',
    '識別植栽與藍帶分佈…',
    '計算各元素視覺佔比…',
    '生成環境特性說明…',
  ];
  let msgIdx = 0;
  const msgTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % messages.length;
    loadingText.textContent = messages[msgIdx];
  }, 1800);

  try {
    const fd = new FormData();
    fd.append('file', uploadedFile, uploadedFile.name);
    if (selectedScene)          fd.append('scene_type', selectedScene);
    if (uploadedGPS.lat !== null) fd.append('latitude',   String(uploadedGPS.lat));
    if (uploadedGPS.lon !== null) fd.append('longitude',  String(uploadedGPS.lon));

    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      body: fd,
      signal: abortController.signal,
    });

    clearInterval(msgTimer);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = Array.isArray(err.detail)
        ? err.detail.map(e => e.msg || JSON.stringify(e)).join('; ')
        : (typeof err.detail === 'string' ? err.detail : `HTTP ${res.status}`);
      throw new Error(detail);
    }

    const data = await res.json();

    // 儲存結果至 sessionStorage 供結果頁讀取
    sessionStorage.setItem('analysisResult', JSON.stringify({
      ...data,
      imageBase64: uploadedBase64,
      sceneType:   selectedScene,
      hasRealGps:  uploadedGPS.lat !== null,   // 區分真實 EXIF GPS 與預設座標
    }));

    // 跳轉至結果頁
    window.location.href = 'result.html';

  } catch (err) {
    clearInterval(msgTimer);
    if (err.name === 'AbortError') {
      showToast('分析已取消。', 'info');
    } else {
      showToast(`分析失敗：${err.message}`);
    }
    resetAnalyzeUI();
  }
});

// ── 取消分析（AbortController）────────────────────────────
cancelBtn.addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
});

function resetAnalyzeUI() {
  analyzeBtn.classList.remove('hidden');
  loadingArea.classList.add('hidden');
  loadingArea.classList.remove('flex');
}

// ── 清除按鈕 ──────────────────────────────────────────────
clearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (uploadedImageId) {
    // 通知後端刪除暫存（fire-and-forget）
    fetch(`${API_BASE}/api/upload/${uploadedImageId}`, { method: 'DELETE' }).catch(() => {});
  }
  resetUpload();
});

// ── 拖曳事件 ──────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-active');
  if (!uploadedImageId) setZoneState('hover');
});

dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-active');
    if (!uploadedImageId) setZoneState('default');
  }
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-active');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ── 點擊選擇檔案 ──────────────────────────────────────────
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('#clear-btn')) return;  // 避開清除按鈕
  if (!uploadedImageId) fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

// ── 初始化 ────────────────────────────────────────────────
setZoneState('default');
