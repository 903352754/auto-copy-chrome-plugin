'use strict';

/* 语音识别助手 —— 弹窗逻辑 */

const SETTINGS_KEY = 'asr_settings';
const DEFAULT_SETTINGS = { endpoint: '', fieldName: 'file', enabled: true };

let settings = Object.assign({}, DEFAULT_SETTINGS);

let saveTimer = 0;
let toastTimer = 0;

const ui = {};

/* ---------- 初始化 ---------- */

async function init() {
  ui.enabled = document.getElementById('enabled');
  ui.endpoint = document.getElementById('endpoint');
  ui.fieldName = document.getElementById('field-name');
  ui.preview = document.getElementById('request-preview');
  ui.pageStat = document.getElementById('page-stat');
  ui.pageHint = document.getElementById('page-hint');
  ui.rescan = document.getElementById('rescan');
  ui.toast = document.getElementById('toast');

  settings = await loadSettings();

  ui.enabled.checked = settings.enabled;
  ui.endpoint.value = settings.endpoint;
  ui.fieldName.value = settings.fieldName;
  renderPreview();

  bindEvents();
  refreshStats();

  if (!settings.endpoint) {
    setTimeout(() => {
      try {
        ui.endpoint.focus();
      } catch (e) {
        /* ignore */
      }
    }, 60);
  }
}

/* ---------- 存储 ---------- */

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    endpoint: String(source.endpoint || '').trim(),
    fieldName: String(source.fieldName || 'file').trim() || 'file',
    enabled: source.enabled !== false
  };
}

function loadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (data) => {
        if (chrome.runtime.lastError || !data) {
          resolve(Object.assign({}, DEFAULT_SETTINGS));
          return;
        }
        resolve(normalizeSettings(data[SETTINGS_KEY]));
      });
    } catch (e) {
      resolve(Object.assign({}, DEFAULT_SETTINGS));
    }
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;

  settings = normalizeSettings({
    endpoint: ui.endpoint.value,
    fieldName: ui.fieldName.value,
    enabled: ui.enabled.checked
  });

  try {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime.lastError) toast('保存失败：' + chrome.runtime.lastError.message);
    });
  } catch (e) {
    toast('保存失败，请重试');
  }
}

/* ---------- 渲染 ---------- */

function renderPreview() {
  const endpoint = ui.endpoint.value.trim() || '<接口地址>';
  const field = ui.fieldName.value.trim() || 'file';
  ui.preview.textContent =
    'POST ' + endpoint + '\n' +
    'Content-Type: multipart/form-data\n' +
    field + '=<音频文件>';
}

function setPageStat(text, hint) {
  ui.pageStat.textContent = text;

  if (typeof hint === 'string') {
    ui.pageHint.textContent = hint;
    ui.pageHint.style.display = hint ? '' : 'none';
  }
}

/* ---------- 当前页面 ---------- */

function getActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function refreshStats() {
  if (!settings.enabled) {
    setPageStat('插件已停用', '打开右上角开关后，页面中的 audio 播放器下方才会出现按钮。');
    return;
  }

  const tab = await getActiveTab();
  const url = tab ? tab.url || '' : '';

  if (!tab) {
    setPageStat('未找到活动页面', '');
    return;
  }

  if (url && !/^(https?|file):/i.test(url)) {
    setPageStat('当前页面不支持', '请在普通网页中使用；chrome:// 等浏览器内置页面无法注入按钮。');
    return;
  }

  let res;
  try {
    res = await sendToTab(tab.id, { type: 'ASR_STATS' });
  } catch (e) {
    setPageStat('无法连接页面脚本', '请刷新网页后重新打开插件。');
    return;
  }

  if (!res || !res.ok) {
    setPageStat('无法读取页面状态', '请刷新网页后重试。');
    return;
  }

  const total = Number(res.total) || 0;
  const hints = [];

  if (!total) {
    hints.push('本页没有 audio 标签。');
  } else if (res.widgets < total) {
    hints.push('本页 ' + total + ' 个 audio 中 ' + res.widgets + ' 个已注入按钮，其余可能在页面加载后再出现。');
  }

  if (!settings.endpoint) {
    hints.push('还没有填写接口地址，按钮点击后会提示配置。');
  }

  setPageStat(
    total ? '本页检测到 ' + total + ' 个 audio 标签' : '本页没有 audio 标签',
    hints.join(' ')
  );
}

/* ---------- 事件 ---------- */

function bindEvents() {
  ui.enabled.addEventListener('change', () => {
    saveNow();
    refreshStats();
    toast(ui.enabled.checked ? '插件已启用' : '插件已停用');
  });

  for (const input of [ui.endpoint, ui.fieldName]) {
    input.addEventListener('input', () => {
      renderPreview();
      scheduleSave();
    });
    input.addEventListener('change', saveNow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveNow();
        toast('已保存');
      }
    });
  }

  ui.rescan.addEventListener('click', async () => {
    saveNow();

    const tab = await getActiveTab();
    if (!tab) {
      toast('请先打开一个网页');
      return;
    }

    try {
      await sendToTab(tab.id, { type: 'ASR_RESCAN' });
    } catch (e) {
      toast('无法连接页面，请刷新网页后重试');
      return;
    }

    await refreshStats();
    toast('已重新检测页面');
  });

  window.addEventListener('pagehide', () => {
    if (saveTimer) saveNow();
  });
}

function toast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2000);
}

init();
