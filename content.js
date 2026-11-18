/* 语音识别助手 —— 内容脚本
 * 1. 扫描页面中所有 <audio> 播放器，在每个播放器下方插入「语音识别」按钮
 * 2. 点击按钮时取出播放源（currentSrc / src / <source>），交给后台调用接口
 * 3. 把接口返回的文本与逐词时间戳表格追加到该播放器下方
 */
(() => {
  'use strict';
  if (window.__audioAsrLoaded) return;
  window.__audioAsrLoaded = true;

  const SETTINGS_KEY = 'asr_settings';
  const WIDGET_ATTR = 'data-asr-widget';
  const BTN_TEXT = '语音识别';
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;
  const SCAN_DELAY = 180;

  const DEFAULT_SETTINGS = { endpoint: '', fieldName: 'file', enabled: true };

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  /**
   * @type {Map<HTMLAudioElement, {
   *   host: HTMLElement,
   *   button: HTMLButtonElement,
   *   hint: HTMLElement,
   *   results: HTMLElement,
   *   busy: boolean
   * }>}
   */
  const widgets = new Map();

  let scanTimer = 0;
  let observer = null;

  const MIME_EXT = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/aacp': 'aac',
    'audio/amr': 'amr',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
    'audio/webm': 'webm'
  };

  const WIDGET_CSS = `
    .wrap {
      box-sizing: border-box;
      max-width: 100%;
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      font-size: 12px;
      line-height: 1.5;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin: 0;
      padding: 4px 12px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(135deg, #8b5cf6, #7c3aed);
      color: #fff;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: .2px;
      line-height: 1.6;
      white-space: nowrap;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(124, 58, 237, .35);
      transition: box-shadow .15s ease, background .15s ease;
    }
    .btn:hover { background: linear-gradient(135deg, #7c3aed, #6d28d9); box-shadow: 0 4px 14px rgba(124, 58, 237, .45); }
    .btn:active { background: linear-gradient(135deg, #6d28d9, #5b21b6); }
    .btn[disabled] { cursor: progress; opacity: .85; box-shadow: none; }
    .btn.busy::before {
      content: "";
      width: 9px;
      height: 9px;
      border: 2px solid rgba(255, 255, 255, .45);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .hint { color: #b45309; font-size: 11px; }
    .hint:empty { display: none; }

    .results { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .results:empty { display: none; }

    .res {
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #f8fafc;
    }
    .res.err { border-color: #fecaca; background: #fef2f2; }
    .res-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      color: #94a3b8;
      font-size: 11px;
    }
    .res.err .res-head { color: #b91c1c; }
    .meta { color: #94a3b8; font-size: 11px; }
    .copy {
      margin-left: auto;
      padding: 1px 8px;
      border: 1px solid #e2e8f0;
      border-radius: 999px;
      background: #fff;
      color: #475569;
      font-family: inherit;
      font-size: 11px;
      line-height: 1.6;
      cursor: pointer;
    }
    .copy:hover { border-color: #c4b5fd; color: #6d28d9; }
    .res-text {
      color: #0f172a;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }
    .res.err .res-text { color: #b91c1c; }
    .table-cap {
      margin: 8px 0 4px;
      color: #64748b;
      font-size: 11px;
    }
    .table-wrap {
      max-height: 260px;
      overflow: auto;
      border: 1px solid #e2e8f0;
      border-radius: 7px;
      background: #fff;
    }
    .ts-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .ts-table th,
    .ts-table td {
      padding: 4px 8px;
      font-size: 11.5px;
      line-height: 1.5;
      text-align: left;
      vertical-align: top;
    }
    .ts-table thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      border-bottom: 1px solid #e2e8f0;
      background: #f1f5f9;
      color: #475569;
      font-weight: 600;
      white-space: nowrap;
    }
    .ts-table thead th:nth-child(n + 3) { text-align: right; }
    .ts-table td {
      border-bottom: 1px solid #f1f5f9;
      color: #0f172a;
    }
    .ts-table tbody tr:last-child td { border-bottom: none; }
    .ts-table tbody tr:hover { background: #f8fafc; }
    .ts-table .idx {
      width: 44px;
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
    }
    .ts-table .tk { word-break: break-word; user-select: text; }
    .ts-table .num {
      width: 64px;
      color: #475569;
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .raw {
      margin: 6px 0 0;
      padding: 6px 8px;
      max-height: 220px;
      overflow: auto;
      border-radius: 6px;
      background: rgba(15, 23, 42, .04);
      color: #475569;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      user-select: text;
    }
  `;

  /* ---------- 基础工具 ---------- */

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      endpoint: String(source.endpoint || '').trim(),
      fieldName: String(source.fieldName || 'file').trim() || 'file',
      enabled: source.enabled !== false
    };
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              stage: 'connect',
              error: '无法连接插件后台：' + chrome.runtime.lastError.message
            });
            return;
          }
          resolve(res || { ok: false, stage: 'unknown', error: '插件后台没有返回结果' });
        });
      } catch (e) {
        resolve({ ok: false, stage: 'connect', error: '无法连接插件后台，请刷新页面后重试' });
      }
    });
  }

  function getAudioUrl(audio) {
    if (!audio) return '';

    const candidates = [audio.currentSrc, audio.src];
    for (const source of Array.from(audio.querySelectorAll('source'))) {
      candidates.push(source.src, source.getAttribute('src'));
    }
    candidates.push(audio.getAttribute('src'));

    for (const raw of candidates) {
      const value = String(raw || '').trim();
      if (!value) continue;
      if (/^(blob:|data:|https?:|file:)/i.test(value)) return value;
      try {
        return new URL(value, location.href).href;
      } catch (e) {
        /* ignore */
      }
    }
    return '';
  }

  function guessFilename(url, mime) {
    let name = '';
    try {
      const pathname = new URL(url, location.href).pathname;
      name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    } catch (e) {
      name = '';
    }
    if (/^[\w\-.]{1,80}\.(mp3|wav|m4a|aac|amr|ogg|opus|flac|webm|mp4)$/i.test(name)) {
      return name;
    }
    const cleanMime = String(mime || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_EXT[cleanMime] || '';
    return ext ? 'audio.' + ext : 'audio.mp3';
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('读取音频失败'));
      reader.readAsDataURL(blob);
    });
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* fallthrough */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 按钮与结果区 ---------- */

  let widgetSheet = null;

  function getWidgetSheet() {
    if (widgetSheet) return widgetSheet;
    try {
      widgetSheet = new CSSStyleSheet();
      widgetSheet.replaceSync(WIDGET_CSS);
    } catch (e) {
      widgetSheet = null;
    }
    return widgetSheet;
  }

  function createWidget(audio) {
    const host = document.createElement('div');
    host.setAttribute(WIDGET_ATTR, '');
    host.style.cssText =
      'all: initial !important;' +
      ' display: block !important;' +
      ' margin: 6px 0 10px !important;' +
      ' box-sizing: border-box !important;';

    const root = host.attachShadow({ mode: 'open' });

    const sheet = getWidgetSheet();
    if (sheet) {
      root.adoptedStyleSheets = [sheet];
    } else {
      const style = document.createElement('style');
      style.textContent = WIDGET_CSS;
      root.appendChild(style);
    }

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const bar = document.createElement('div');
    bar.className = 'bar';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = BTN_TEXT;
    button.title = '把该播放器的音频提交到识别接口';

    const hint = document.createElement('span');
    hint.className = 'hint';

    bar.append(button, hint);

    const results = document.createElement('div');
    results.className = 'results';

    wrap.append(bar, results);
    root.appendChild(wrap);

    const entry = { host, button, hint, results, busy: false };

    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRecognize(audio, entry);
    });

    return entry;
  }

  function attachWidget(audio) {
    const entry = createWidget(audio);
    try {
      audio.insertAdjacentElement('afterend', entry.host);
    } catch (e) {
      (audio.parentElement || document.body).appendChild(entry.host);
    }
    widgets.set(audio, entry);
    refreshHint(entry);
    return entry;
  }

  function refreshHint(entry) {
    entry.hint.textContent = settings.endpoint ? '' : '请先点击插件图标填写接口地址';
  }

  function removeAllWidgets() {
    for (const entry of widgets.values()) entry.host.remove();
    widgets.clear();
  }

  function scan() {
    if (!settings.enabled) {
      removeAllWidgets();
      return;
    }

    const audios = Array.from(document.querySelectorAll('audio'));
    const alive = new Set();

    for (const audio of audios) {
      alive.add(audio);
      const entry = widgets.get(audio);
      if (!entry) {
        attachWidget(audio);
      } else if (!entry.host.isConnected) {
        // 页面重渲染把按钮移除了，重新挂回播放器下方
        try {
          audio.insertAdjacentElement('afterend', entry.host);
        } catch (e) {
          /* ignore */
        }
      }
    }

    for (const [audio, entry] of Array.from(widgets.entries())) {
      if (!alive.has(audio) || !audio.isConnected) {
        entry.host.remove();
        widgets.delete(audio);
      }
    }
  }

  function scheduleScan(delay = SCAN_DELAY) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, delay);
  }

  /* ---------- 识别流程 ---------- */

  async function readAudioInline(url) {
    let response;
    try {
      response = await fetch(url, { credentials: 'include' });
    } catch (e) {
      return { ok: false, error: '页面内读取音频失败：' + (e && e.message ? e.message : e) };
    }

    if (!response.ok) {
      return { ok: false, error: '页面内读取音频失败（HTTP ' + response.status + '）' };
    }

    let blob;
    try {
      blob = await response.blob();
    } catch (e) {
      return { ok: false, error: '读取音频内容失败' };
    }

    if (!blob.size) return { ok: false, error: '音频内容为空' };
    if (blob.size > MAX_INLINE_BYTES) {
      return { ok: false, error: '音频超过 20MB，无法上传' };
    }

    let base64;
    try {
      base64 = await blobToBase64(blob);
    } catch (e) {
      return { ok: false, error: '读取音频内容失败' };
    }

    const mime = blob.type || response.headers.get('content-type') || '';
    return {
      ok: true,
      base64,
      mime,
      filename: guessFilename(url, mime)
    };
  }

  async function requestRecognition(url) {
    // 普通 http(s) 地址先交给后台下载，可携带页面 Cookie
    const remote = await sendMessage({ type: 'ASR_RECOGNIZE', url });

    if (remote && remote.ok) return remote;
    // 只在下载阶段失败时，退回页面内读取（blob: / data: 或需要页面内请求的地址）
    if (remote && remote.stage && remote.stage !== 'fetch' && remote.stage !== 'inline') {
      return remote;
    }

    const inline = await readAudioInline(url);
    if (!inline.ok) {
      if (remote && remote.error) {
        return { ok: false, stage: 'fetch', error: inline.error + '；' + remote.error };
      }
      return { ok: false, stage: 'fetch', error: inline.error };
    }

    return sendMessage({
      type: 'ASR_RECOGNIZE',
      base64: inline.base64,
      mime: inline.mime,
      filename: inline.filename
    });
  }

  function setBusy(entry, busy) {
    entry.busy = busy;
    entry.button.disabled = busy;
    entry.button.classList.toggle('busy', busy);
    entry.button.textContent = busy ? '识别中…' : BTN_TEXT;
  }

  function formatSeconds(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return value.toFixed(2) + 's';
  }

  function formatToken(token) {
    const text = String(token == null ? '' : token);
    if (text && !text.trim()) return '␣';
    return text;
  }

  function buildTimestampTable(timestamps) {
    const table = document.createElement('table');
    table.className = 'ts-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['序号', '文字', '开始', '结束']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    timestamps.forEach((item, index) => {
      const row = document.createElement('tr');

      const cellIndex = document.createElement('td');
      cellIndex.className = 'idx';
      cellIndex.textContent = String(index + 1);

      const cellToken = document.createElement('td');
      cellToken.className = 'tk';
      cellToken.textContent = formatToken(item.token);

      const cellStart = document.createElement('td');
      cellStart.className = 'num';
      cellStart.textContent = formatSeconds(item.start);

      const cellEnd = document.createElement('td');
      cellEnd.className = 'num';
      cellEnd.textContent = formatSeconds(item.end);

      row.append(cellIndex, cellToken, cellStart, cellEnd);
      tbody.appendChild(row);
    });

    table.append(thead, tbody);
    return table;
  }

  function appendTimestampTable(card, timestamps) {
    const cap = document.createElement('div');
    cap.className = 'table-cap';

    const starts = [];
    const ends = [];
    for (const item of timestamps) {
      if (typeof item.start === 'number' && isFinite(item.start)) starts.push(item.start);
      if (typeof item.end === 'number' && isFinite(item.end)) ends.push(item.end);
    }

    let caption = '时间戳 · 共 ' + timestamps.length + ' 个片段';
    if (starts.length && ends.length) {
      caption += ' · ' + formatSeconds(Math.min.apply(null, starts)) + ' → ' + formatSeconds(Math.max.apply(null, ends));
    }
    cap.textContent = caption;

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.appendChild(buildTimestampTable(timestamps));

    card.append(cap, wrap);
  }

  function appendResult(entry, payload) {
    const ok = !!(payload && payload.ok);
    const timestamps = ok && Array.isArray(payload.timestamps) ? payload.timestamps : [];

    const card = document.createElement('div');
    card.className = 'res' + (ok ? '' : ' err');

    const head = document.createElement('div');
    head.className = 'res-head';

    const label = document.createElement('span');
    label.textContent = ok ? '识别结果' : '识别失败';
    head.appendChild(label);

    const metaParts = [];
    if (payload && payload.status) metaParts.push('HTTP ' + payload.status);
    if (payload && payload.elapsed) {
      metaParts.push((payload.elapsed / 1000).toFixed(2) + 's');
    }
    if (payload && payload.apiElapsed != null && isFinite(Number(payload.apiElapsed))) {
      metaParts.push('接口 ' + Number(payload.apiElapsed).toFixed(2) + 's');
    }
    if (payload && payload.filename) metaParts.push(String(payload.filename));
    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = metaParts.join(' · ');
      head.appendChild(meta);
    }

    if (ok && payload.text) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const done = await copyText(payload.text);
        copyBtn.textContent = done ? '已复制' : '复制失败';
        setTimeout(() => {
          copyBtn.textContent = '复制';
        }, 1400);
      });
      head.appendChild(copyBtn);
    }

    const text = ok
      ? String(payload.text || '').trim() || (timestamps.length ? '' : '（接口没有返回文本）')
      : String((payload && payload.error) || '识别失败，请重试');

    card.appendChild(head);

    if (text) {
      const body = document.createElement('div');
      body.className = 'res-text';
      body.textContent = text;
      card.appendChild(body);
    }

    if (timestamps.length) appendTimestampTable(card, timestamps);

    const raw = payload && payload.raw ? String(payload.raw) : '';
    const showRaw = raw && (ok ? !text && !timestamps.length : raw.trim() !== text.trim());
    if (showRaw) {
      const pre = document.createElement('pre');
      pre.className = 'raw';
      pre.textContent = raw;
      card.appendChild(pre);
    }

    entry.results.appendChild(card);
  }

  async function onRecognize(audio, entry) {
    if (entry.busy) return;

    if (!settings.endpoint) {
      appendResult(entry, {
        ok: false,
        error: '还没有配置接口地址：点击浏览器工具栏中的插件图标填写后重试'
      });
      return;
    }

    const url = getAudioUrl(audio);
    if (!url) {
      appendResult(entry, {
        ok: false,
        error: '没有找到音频地址，请确认该 audio 标签已设置 src 或已加载播放源'
      });
      return;
    }

    setBusy(entry, true);
    const startedAt = Date.now();

    let result;
    try {
      result = await requestRecognition(url);
    } catch (e) {
      result = {
        ok: false,
        error: '语音识别失败：' + (e && e.message ? e.message : e)
      };
    } finally {
      setBusy(entry, false);
    }

    if (!result || !result.ok) {
      appendResult(entry, {
        ok: false,
        error: (result && result.error) || '语音识别失败，请重试',
        raw: result && result.raw ? result.raw : '',
        status: result && result.status ? result.status : 0
      });
      return;
    }

    appendResult(entry, Object.assign({}, result, { elapsed: Date.now() - startedAt }));
  }

  /* ---------- 存储与消息 ---------- */

  function applySettings(raw) {
    const wasEnabled = settings.enabled;
    settings = normalizeSettings(raw);

    if (!settings.enabled) {
      removeAllWidgets();
      return;
    }

    if (!wasEnabled) scan();

    for (const entry of widgets.values()) refreshHint(entry);
    scan();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (data) => {
        if (chrome.runtime.lastError) return;
        applySettings(data[SETTINGS_KEY]);
      });
    } catch (e) {
      /* 扩展被重新加载时可能抛错，忽略 */
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      applySettings(changes[SETTINGS_KEY].newValue);
    });
  } catch (e) {
    /* ignore */
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ASR_STATS' || msg.type === 'ASR_RESCAN') {
        if (msg.type === 'ASR_RESCAN' && settings.enabled) scan();
        sendResponse({
          ok: true,
          total: document.querySelectorAll('audio').length,
          widgets: widgets.size,
          enabled: settings.enabled,
          configured: !!settings.endpoint
        });
        return;
      }
    });
  } catch (e) {
    /* ignore */
  }

  /* ---------- DOM 监听 ---------- */

  function isOwnNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute && node.hasAttribute(WIDGET_ATTR)) return true;
    return !!(node.querySelector && node.querySelector('[' + WIDGET_ATTR + ']'));
  }

  try {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue;

        const nodes = [];
        for (const node of record.addedNodes) nodes.push(node);
        for (const node of record.removedNodes) nodes.push(node);

        let relevant = false;
        for (const node of nodes) {
          if (node.nodeType !== 1) continue;
          if (isOwnNode(node)) continue;
          relevant = true;
          break;
        }

        if (relevant) {
          scheduleScan();
          return;
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) {
    /* ignore */
  }

  loadSettings();
})();
