/* 快速复制助手 —— 内容脚本
 * 1. 扫描页面中匹配规则的输入框，在下方悬浮显示「快速复制」按钮
 * 2. 扫描匹配规则的 audio 播放器，在下方显示「识别语音」按钮（腾讯云录音文件识别极速版）
 * 3. 点击按钮时把内容填入用户指定的目标输入框，并尝试写入剪贴板（语音规则只填入）
 * 4. 支持从插件弹窗进入「拾取模式」，直接在页面上点选输入框或 audio 播放器
 */
(() => {
  'use strict';
  if (window.__quickCopyHelperLoaded) return;
  window.__quickCopyHelperLoaded = true;

  const KEY_RULES = 'qc_rules';
  const KEY_ENABLED = 'qc_enabled';
  const KEY_PENDING = 'qc_pending_pick';
  const HOST_ID = 'quick-copy-helper-host';

  const BTN_TEXT = '快速复制';
  const AUDIO_BTN_TEXT = '识别语音';
  const PICK_TIMEOUT_MS = 60000;
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;

  let rules = [];
  let enabled = true;

  /** @type {Map<HTMLElement, {btn: HTMLButtonElement, rule: object}>} */
  const items = new Map();

  let host = null;
  let shadow = null;
  let layer = null;
  let highlight = null;
  let banner = null;
  let toastEl = null;
  let toastTimer = 0;

  let rafId = 0;
  let scanTimer = 0;
  let observer = null;

  let pickState = null;
  let hoverEl = null;
  let pickOverlay = null;
  let cursorSheet = null;
  let savedAdoptedSheets = null;

  const NON_TEXT_TYPES = new Set([
    'hidden', 'button', 'submit', 'reset', 'checkbox', 'radio',
    'file', 'image', 'range', 'color', 'date', 'time', 'datetime-local',
    'month', 'week'
  ]);

  const UI_CSS = `
    .qc-layer { position: fixed; inset: 0; pointer-events: none; }
    .qc-btn {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin: 0;
      padding: 3px 10px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #fff;
      font: 500 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      letter-spacing: .2px;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      pointer-events: auto;
      box-shadow: 0 2px 8px rgba(37, 99, 235, .45);
      transition: box-shadow .15s ease, background .15s ease;
      will-change: transform;
    }
    .qc-btn:hover { background: linear-gradient(135deg, #2563eb, #1d4ed8); box-shadow: 0 4px 14px rgba(37, 99, 235, .55); }
    .qc-btn.qc-ok { background: linear-gradient(135deg, #22c55e, #16a34a); box-shadow: 0 2px 8px rgba(22, 163, 74, .45); }
    .qc-btn.qc-error { background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 2px 8px rgba(220, 38, 38, .45); }
    .qc-btn.qc-audio { background: linear-gradient(135deg, #8b5cf6, #7c3aed); box-shadow: 0 2px 8px rgba(124, 58, 237, .45); }
    .qc-btn.qc-audio:hover { background: linear-gradient(135deg, #7c3aed, #6d28d9); box-shadow: 0 4px 14px rgba(124, 58, 237, .55); }
    .qc-btn.qc-busy { cursor: progress; opacity: .88; }
    .qc-btn.qc-busy::before {
      content: "";
      width: 9px;
      height: 9px;
      border: 2px solid rgba(255, 255, 255, .45);
      border-top-color: #fff;
      border-radius: 50%;
      animation: qc-spin .7s linear infinite;
    }
    @keyframes qc-spin { to { transform: rotate(360deg); } }

    .qc-pick-overlay {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483647;
      display: none;
      background: transparent;
      border: none;
      cursor: crosshair;
      pointer-events: auto;
    }

    .qc-highlight {
      position: fixed;
      top: 0;
      left: 0;
      display: none;
      z-index: 2147483646;
      border: 2px solid #3b82f6;
      border-radius: 4px;
      background: rgba(59, 130, 246, .15);
      box-shadow: 0 0 0 9999px rgba(15, 23, 42, .06);
      pointer-events: none;
    }
    .qc-banner {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      padding: 8px 16px;
      border-radius: 999px;
      background: rgba(17, 24, 39, .92);
      color: #fff;
      font: 500 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .22);
    }
    .qc-toast {
      position: fixed;
      left: 50%;
      bottom: 32px;
      transform: translateX(-50%) translateY(10px);
      z-index: 2147483647;
      max-width: 70vw;
      padding: 9px 16px;
      border-radius: 10px;
      background: rgba(17, 24, 39, .94);
      color: #fff;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      text-align: center;
      word-break: break-all;
      pointer-events: none;
      opacity: 0;
      transition: opacity .2s ease, transform .2s ease;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
    }
    .qc-toast.qc-show { opacity: 1; transform: translateX(-50%) translateY(0); }
  `;

  /* ---------- 基础工具 ---------- */

  function xpathLiteral(value) {
    const str = String(value);
    if (!str.includes('"')) return '"' + str + '"';
    if (!str.includes("'")) return "'" + str + "'";
    return 'concat(' + str.split('"').map((part) => '"' + part + '"').join(', \'"\', ') + ')';
  }

  function uniqueIdXPath(el) {
    if (!el || !el.id) return '';
    const expr = '//*[@id=' + xpathLiteral(el.id) + ']';
    try {
      const result = document.evaluate(
        expr,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      if (result.snapshotLength === 1) return expr;
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  function uniqueAttrXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    const attrs = ['data-testid', 'data-test', 'name', 'aria-label'];

    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const expr = '//' + tag + '[@' + attr + '=' + xpathLiteral(value) + ']';
      try {
        const result = document.evaluate(
          expr,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        if (result.snapshotLength === 1) return expr;
      } catch (e) {
        /* ignore */
      }
    }
    return '';
  }

  function queryXPath(expression) {
    const expr = String(expression || '').trim();
    if (!expr) return [];
    const out = [];
    const result = document.evaluate(
      expr,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    for (let i = 0; i < result.snapshotLength; i += 1) {
      out.push(result.snapshotItem(i));
    }
    return out;
  }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !NON_TEXT_TYPES.has(type);
  }

  function ruleKind(rule) {
    return rule && rule.kind === 'audio' ? 'audio' : 'input';
  }

  function isAudioElement(el) {
    return !!el && el.nodeType === 1 && el.tagName === 'AUDIO';
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function getFieldValue(el) {
    return String(el && el.value != null ? el.value : '');
  }

  /* ---------- 页面 UI（Shadow DOM 隔离样式） ---------- */

  function ensureUi() {
    if (host && host.isConnected) return;
    if (host) {
      items.clear();
      host = shadow = layer = null;
      pickOverlay = null;
    }

    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all: initial; position: fixed !important; top: 0 !important; left: 0 !important;' +
      ' width: 0 !important; height: 0 !important; overflow: visible !important;' +
      ' z-index: 2147483647 !important; pointer-events: none !important;';

    shadow = host.attachShadow({ mode: 'open' });

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(UI_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      const style = document.createElement('style');
      style.textContent = UI_CSS;
      shadow.appendChild(style);
    }

    layer = document.createElement('div');
    layer.className = 'qc-layer';
    shadow.appendChild(layer);

    (document.documentElement || document.body).appendChild(host);
  }

  function showToast(message, duration = 2600) {
    ensureUi();
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = 'qc-toast';
      shadow.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('qc-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove('qc-show');
    }, duration);
  }

  /* ---------- 扫描与按钮管理 ---------- */

  function scan() {
    ensureUi();

    if (!enabled) {
      clearAllButtons();
      return;
    }

    /** @type {Map<HTMLElement, object>} */
    const matched = new Map();

    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      const expression = String(rule.source || '').trim();
      if (!expression) continue;

      const kind = ruleKind(rule);
      let nodes;
      try {
        nodes = queryXPath(expression);
      } catch (e) {
        continue; // 用户填了非法 XPath，跳过
      }

      for (const el of nodes) {
        if (matched.has(el)) continue;
        if (kind === 'audio') {
          if (!isAudioElement(el)) continue;
        } else if (!isTextField(el)) {
          continue;
        }
        matched.set(el, rule);
      }
    }

    // 移除失效或规则已变化的按钮
    for (const [el, entry] of Array.from(items.entries())) {
      const rule = matched.get(el);
      const same =
        rule &&
        entry.rule &&
        entry.rule.id === rule.id &&
        entry.rule.kind === rule.kind &&
        entry.rule.source === rule.source &&
        entry.rule.target === rule.target;

      if (!el.isConnected || !rule || !same) {
        entry.btn.remove();
        items.delete(el);
      }
    }

    // 补充新按钮
    for (const [el, rule] of matched) {
      if (items.has(el)) continue;
      const btn = createButton(el, rule);
      layer.appendChild(btn);
      items.set(el, { btn, rule });
    }

    updatePositions();
    startPositionLoop();
  }

  function createButton(sourceEl, rule) {
    const kind = ruleKind(rule);
    const isAudio = kind === 'audio';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qc-btn' + (isAudio ? ' qc-audio' : '');
    btn.textContent = isAudio ? AUDIO_BTN_TEXT : BTN_TEXT;
    btn.title = rule.target
      ? (isAudio ? '识别语音并填入：' : '复制到：') + rule.target
      : '尚未设置目标输入框';

    // 保持源元素焦点，避免页面因失焦收起内容
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isAudio) onAudioClick(sourceEl, rule, btn);
      else onCopyClick(sourceEl, rule, btn);
    });

    return btn;
  }

  function clearAllButtons() {
    for (const entry of items.values()) entry.btn.remove();
    items.clear();
  }

  function updatePositions() {
    for (const [input, entry] of Array.from(items.entries())) {
      if (!input.isConnected) {
        entry.btn.remove();
        items.delete(input);
        continue;
      }

      const rect = input.getBoundingClientRect();
      const offscreen =
        (rect.width === 0 && rect.height === 0) ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth;

      if (offscreen) {
        entry.btn.style.display = 'none';
        continue;
      }

      entry.btn.style.display = '';

      let top = rect.bottom + 4;
      if (top + 26 > window.innerHeight) top = rect.top - 28;

      let left = rect.left;
      left = Math.max(4, Math.min(left, window.innerWidth - 96));

      entry.btn.style.transform =
        'translate(' + Math.round(left) + 'px, ' + Math.round(Math.max(0, top)) + 'px)';
    }
  }

  function startPositionLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!items.size) return;
      if (document.visibilityState === 'visible') updatePositions();
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
  }

  function scheduleScan(delay = 250) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  /* ---------- 复制逻辑 ---------- */

  function setFieldValue(el, value) {
    try {
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      try {
        el.value = value;
      } catch (err) {
        /* ignore */
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
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

  function findTargetElement(xpath) {
    const expression = String(xpath || '').trim();
    if (!expression) return null;

    let nodes;
    try {
      nodes = queryXPath(expression);
    } catch (e) {
      return null;
    }

    let fallback = null;
    for (const node of nodes) {
      if (!node || node.nodeType !== 1) continue;

      if (isTextField(node)) {
        if (isVisible(node)) return node;
        if (!fallback) fallback = node;
        continue;
      }
      // 允许 XPath 选中包裹输入框的容器
      let nested = null;
      try {
        nested = node.querySelector('input:not([type="hidden"]), textarea');
      } catch (e) {
        nested = null;
      }
      if (nested && isTextField(nested)) {
        if (isVisible(nested)) return nested;
        if (!fallback) fallback = nested;
      }
    }

    return fallback;
  }

  function flashButton(btn, text, isError) {
    if (btn.__qcTimer) clearTimeout(btn.__qcTimer);
    if (!btn.__qcOrigText) btn.__qcOrigText = btn.textContent || BTN_TEXT;
    btn.textContent = text;
    btn.classList.toggle('qc-error', !!isError);
    btn.classList.toggle('qc-ok', !isError);
    btn.__qcTimer = setTimeout(() => {
      btn.textContent = btn.__qcOrigText;
      btn.classList.remove('qc-error', 'qc-ok');
      btn.__qcTimer = 0;
    }, 1300);
  }

  async function onCopyClick(input, rule, btn) {
    const value = getFieldValue(input);

    const target = findTargetElement(rule.target);
    if (!target) {
      flashButton(btn, '未找到目标', true);
      showToast(
        rule.target
          ? '未找到目标输入框，请检查目标 XPath：' + rule.target
          : '该规则还没有设置目标输入框，请在插件中填写或拾取'
      );
      return;
    }

    setFieldValue(target, value);
    try {
      target.focus({ preventScroll: true });
    } catch (e) {
      try { target.focus(); } catch (err) { /* ignore */ }
    }
    try {
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) {
      /* ignore */
    }

    const copied = await copyText(value);

    if (copied) flashButton(btn, '已复制 ✓', false);
    else flashButton(btn, '已填入', false);

    showToast(copied ? '已复制，并填入目标输入框' : '已填入目标输入框（浏览器未允许写入剪贴板）');
  }

  /* ---------- 语音识别 ---------- */

  function sendRuntimeMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
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

  const MIME_TO_FORMAT = {
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
    'audio/ogg': 'ogg-opus',
    'audio/opus': 'ogg-opus',
    'audio/pcm': 'pcm',
    'audio/silk': 'silk',
    'audio/speex': 'speex'
  };

  const EXT_TO_FORMAT = {
    mp3: 'mp3',
    wav: 'wav',
    wave: 'wav',
    m4a: 'm4a',
    mp4: 'm4a',
    aac: 'aac',
    amr: 'amr',
    ogg: 'ogg-opus',
    opus: 'ogg-opus',
    pcm: 'pcm',
    silk: 'silk',
    speex: 'speex'
  };

  function guessAudioFormat(url, mime) {
    const cleanMime = String(mime || '').split(';')[0].trim().toLowerCase();
    if (MIME_TO_FORMAT[cleanMime]) return MIME_TO_FORMAT[cleanMime];

    try {
      const pathname = new URL(url, location.href).pathname;
      const match = pathname.match(/\.([a-z0-9]+)$/i);
      if (match && EXT_TO_FORMAT[match[1].toLowerCase()]) {
        return EXT_TO_FORMAT[match[1].toLowerCase()];
      }
    } catch (e) {
      /* ignore */
    }

    return '';
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

  async function readAudioInline(url) {
    let response;
    try {
      response = await fetch(url, { credentials: 'include' });
    } catch (e) {
      return { ok: false, error: '读取音频失败：' + (e && e.message ? e.message : e) };
    }

    if (!response.ok) {
      return { ok: false, error: '读取音频失败（HTTP ' + response.status + '）' };
    }

    let blob;
    try {
      blob = await response.blob();
    } catch (e) {
      return { ok: false, error: '读取音频内容失败' };
    }

    if (!blob.size) return { ok: false, error: '音频内容为空' };
    if (blob.size > MAX_INLINE_BYTES) {
      return { ok: false, error: '音频超过 20MB，无法在页面内读取' };
    }

    let base64;
    try {
      base64 = await blobToBase64(blob);
    } catch (e) {
      return { ok: false, error: '读取音频内容失败' };
    }

    return {
      ok: true,
      base64,
      mime: blob.type || response.headers.get('content-type') || ''
    };
  }

  async function requestRecognition(audio) {
    const url = getAudioUrl(audio);

    // 普通 http(s) 地址优先交给后台下载，可携带页面 Cookie
    if (url && !/^(blob:|data:)/i.test(url)) {
      const remote = await sendRuntimeMessage({
        type: 'QC_ASR_RECOGNIZE',
        url,
        format: guessAudioFormat(url, '')
      });
      if (remote && (remote.ok || remote.stage !== 'fetch')) return remote;
    }

    if (!url) {
      return { ok: false, stage: 'audio', error: '没有找到音频地址，请确认 audio 标签已设置 src' };
    }

    // blob: / data: 或后台下载失败时，改在页面里读取后发给后台
    const inline = await readAudioInline(url);
    if (!inline.ok) return { ok: false, stage: 'audio', error: inline.error };

    return sendRuntimeMessage({
      type: 'QC_ASR_RECOGNIZE',
      base64: inline.base64,
      mime: inline.mime,
      format: guessAudioFormat(url, inline.mime)
    });
  }

  function setButtonBusy(btn, busy) {
    if (busy) {
      if (btn.__qcTimer) {
        clearTimeout(btn.__qcTimer);
        btn.__qcTimer = 0;
      }
      btn.classList.remove('qc-ok', 'qc-error');
      btn.__qcBusy = true;
      btn.classList.add('qc-busy');
      btn.disabled = true;
      btn.textContent = '识别中…';
      return;
    }
    btn.__qcBusy = false;
    btn.classList.remove('qc-busy');
    btn.disabled = false;
    btn.textContent = btn.__qcOrigText || AUDIO_BTN_TEXT;
  }

  async function onAudioClick(audio, rule, btn) {
    if (btn.__qcBusy) return;

    const target = findTargetElement(rule.target);
    if (!target) {
      flashButton(btn, '未找到目标', true);
      showToast(
        rule.target
          ? '未找到目标输入框，请检查目标 XPath：' + rule.target
          : '该规则还没有设置目标输入框，请在插件中填写或拾取'
      );
      return;
    }

    btn.__qcOrigText = AUDIO_BTN_TEXT;
    setButtonBusy(btn, true);
    showToast('正在识别语音，请稍候…', 12000);

    let result;
    try {
      result = await requestRecognition(audio);
    } catch (e) {
      result = { ok: false, error: '语音识别失败：' + (e && e.message ? e.message : e) };
    } finally {
      setButtonBusy(btn, false);
    }

    if (!result || !result.ok) {
      flashButton(btn, '识别失败', true);
      showToast((result && result.error) || '语音识别失败，请重试', 5200);
      return;
    }

    setFieldValue(target, result.text);
    try {
      target.focus({ preventScroll: true });
    } catch (e) {
      try { target.focus(); } catch (err) { /* ignore */ }
    }
    try {
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) {
      /* ignore */
    }

    flashButton(btn, '已填入 ✓', false);
    showToast('已识别语音并填入目标输入框', 3200);
  }

  /* ---------- 拾取输入框 ---------- */

  function findFieldAt(el) {
    if (!el) return null;
    if (isTextField(el)) return el;

    const closest = el.closest && el.closest('input, textarea');
    if (closest && isTextField(closest)) return closest;

    const label = el.closest && el.closest('label');
    if (label) {
      const inner = label.querySelector('input:not([type="hidden"]), textarea');
      if (isTextField(inner)) return inner;
    }
    return null;
  }

  function findAudioAt(el) {
    if (!el) return null;
    if (isAudioElement(el)) return el;
    return (el.closest && el.closest('audio')) || null;
  }

  function findPickTarget(el, kind) {
    return kind === 'audio' ? findAudioAt(el) : findFieldAt(el);
  }

  function buildXPath(el) {
    if (!el || el.nodeType !== 1) return '';

    const selfId = uniqueIdXPath(el);
    if (selfId) return selfId;

    const selfAttr = uniqueAttrXPath(el);
    if (selfAttr) return selfAttr;

    const parts = [];
    let node = el;

    while (node && node.nodeType === 1) {
      const idExpr = uniqueIdXPath(node);
      if (idExpr) {
        parts.unshift(idExpr);
        break;
      }

      const tag = node.tagName.toLowerCase();
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + '[' + index + ']');

      if (node === document.documentElement) break;
      node = node.parentElement;
    }

    if (!parts.length) return '';
    return parts[0].startsWith('//') ? parts.join('/') : '/' + parts.join('/');
  }

  function applyPickCursor() {
    const css = 'html.qc-picking, html.qc-picking * { cursor: crosshair !important; }';
    try {
      cursorSheet = new CSSStyleSheet();
      cursorSheet.replaceSync(css);
      savedAdoptedSheets = document.adoptedStyleSheets ? Array.from(document.adoptedStyleSheets) : [];
      document.adoptedStyleSheets = savedAdoptedSheets.concat(cursorSheet);
    } catch (e) {
      cursorSheet = null;
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      cursorSheet = style;
    }
    document.documentElement.classList.add('qc-picking');
  }

  function removePickCursor() {
    document.documentElement.classList.remove('qc-picking');
    if (!cursorSheet) return;
    try {
      if (cursorSheet instanceof CSSStyleSheet && savedAdoptedSheets) {
        document.adoptedStyleSheets = savedAdoptedSheets;
      } else if (cursorSheet.remove) {
        cursorSheet.remove();
      }
    } catch (e) {
      /* ignore */
    }
    cursorSheet = null;
    savedAdoptedSheets = null;
  }

  function positionHighlight(rect) {
    if (!highlight) return;
    if (!rect || (!rect.width && !rect.height)) {
      highlight.style.display = 'none';
      return;
    }
    highlight.style.display = 'block';
    highlight.style.transform =
      'translate(' + Math.round(rect.left) + 'px, ' + Math.round(rect.top) + 'px)';
    highlight.style.width = Math.round(rect.width) + 'px';
    highlight.style.height = Math.round(rect.height) + 'px';
  }

  function positionOverlay(rect) {
    if (!pickOverlay) return;
    if (!rect || (!rect.width && !rect.height)) {
      pickOverlay.style.display = 'none';
      return;
    }
    pickOverlay.style.display = 'block';
    pickOverlay.style.transform =
      'translate(' + Math.round(rect.left) + 'px, ' + Math.round(rect.top) + 'px)';
    pickOverlay.style.width = Math.round(rect.width) + 'px';
    pickOverlay.style.height = Math.round(rect.height) + 'px';
  }

  function eventFromPlugin(e) {
    if (!host) return false;
    if (e.target === host) return true;
    return !!(e.composedPath && e.composedPath().includes(host));
  }

  function onPickMove(e) {
    if (!pickState) return;
    // 指针在拾取覆盖层上时，保持当前选中的 audio 不重新计算
    if (eventFromPlugin(e)) return;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const field = findPickTarget(el, pickState.kind);
    hoverEl = field;
    positionHighlight(field ? field.getBoundingClientRect() : null);

    if (pickState.kind === 'audio') {
      // 原生 audio 控件会吞掉点击，覆盖一层透明元素来接收拾取点击
      positionOverlay(isAudioElement(field) ? field.getBoundingClientRect() : null);
    }
  }

  function onPickScroll() {
    if (!pickState) return;
    const rect = hoverEl ? hoverEl.getBoundingClientRect() : null;
    positionHighlight(rect);
    if (pickState.kind === 'audio') {
      positionOverlay(isAudioElement(hoverEl) ? rect : null);
    }
  }

  function onPickDown(e) {
    if (!pickState) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // pointerdown 只拦截页面逻辑，不 preventDefault，避免影响后续 click 事件
  function onPickPointerDown(e) {
    if (!pickState) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function finishPick(field) {
    if (!pickState) return;

    const xpath = buildXPath(field);
    const ruleId = pickState.ruleId;
    const fieldName = pickState.field;
    const kind = pickState.kind;
    exitPick();

    if (!xpath) {
      showToast(
        kind === 'audio' ? '无法识别这个播放器，请换一个试试' : '无法识别这个输入框，请换一个试试'
      );
      return;
    }

    try {
      chrome.storage.local.set({
        [KEY_PENDING]: { ruleId, field: fieldName, kind, xpath, ts: Date.now() }
      });
    } catch (err) {
      /* ignore */
    }

    showToast('已拾取 XPath，点击插件图标完成设置', 3500);
  }

  function onOverlayClick(e) {
    if (!pickState) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let field = isAudioElement(hoverEl) ? hoverEl : null;
    if (!field) {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const node of stack) {
        if (host && (node === host || host.contains(node))) continue;
        field = findAudioAt(node);
        if (field) break;
      }
    }

    if (!field) {
      showToast('请点击一个 audio 播放器');
      return;
    }

    finishPick(field);
  }

  function onPickClick(e) {
    if (!pickState) return;
    // 点击落在插件覆盖层上，交给 onOverlayClick 处理
    if (eventFromPlugin(e)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const field =
      hoverEl || findPickTarget(document.elementFromPoint(e.clientX, e.clientY), pickState.kind);
    if (!field) {
      showToast(pickState.kind === 'audio' ? '请点击一个 audio 播放器' : '请点击一个输入框');
      return;
    }

    finishPick(field);
  }

  function onPickKey(e) {
    if (!pickState) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exitPick();
      showToast('已取消拾取');
    }
  }

  function startPick(ruleId, field, kind) {
    ensureUi();
    exitPick();

    const fieldName = field === 'source' ? 'source' : 'target';
    pickState = {
      ruleId: String(ruleId || ''),
      field: fieldName,
      kind: fieldName === 'source' && kind === 'audio' ? 'audio' : 'input',
      timer: 0
    };

    banner = document.createElement('div');
    banner.className = 'qc-banner';
    banner.textContent =
      pickState.kind === 'audio'
        ? '点击页面上的音频播放器，按 Esc 取消'
        : '点击需要拾取的输入框，按 Esc 取消';
    shadow.appendChild(banner);

    highlight = document.createElement('div');
    highlight.className = 'qc-highlight';
    shadow.appendChild(highlight);

    if (pickState.kind === 'audio') {
      pickOverlay = document.createElement('div');
      pickOverlay.className = 'qc-pick-overlay';
      pickOverlay.addEventListener('click', onOverlayClick, true);
      shadow.appendChild(pickOverlay);
    }

    applyPickCursor();

    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('mousedown', onPickDown, true);
    document.addEventListener('pointerdown', onPickPointerDown, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    window.addEventListener('scroll', onPickScroll, true);
    window.addEventListener('resize', onPickScroll, true);

    pickState.timer = setTimeout(() => {
      exitPick();
      showToast('拾取已超时，请重新点击「拾取」');
    }, PICK_TIMEOUT_MS);

    showToast(
      pickState.kind === 'audio'
        ? '拾取模式：点击页面上的 audio 播放器'
        : pickState.field === 'source'
          ? '拾取模式：点击页面上的源输入框'
          : '拾取模式：点击页面上的目标输入框'
    );
  }

  function exitPick() {
    if (!pickState) return;

    clearTimeout(pickState.timer);
    pickState = null;
    hoverEl = null;

    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('mousedown', onPickDown, true);
    document.removeEventListener('pointerdown', onPickPointerDown, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    window.removeEventListener('scroll', onPickScroll, true);
    window.removeEventListener('resize', onPickScroll, true);

    if (banner) { banner.remove(); banner = null; }
    if (highlight) { highlight.remove(); highlight = null; }
    if (pickOverlay) { pickOverlay.remove(); pickOverlay = null; }

    removePickCursor();
  }

  /* ---------- 存储与消息 ---------- */

  function applyState(nextRules, nextEnabled) {
    rules = Array.isArray(nextRules) ? nextRules : [];
    enabled = nextEnabled !== false;
    clearAllButtons();
    scan();
  }

  function loadState() {
    try {
      chrome.storage.sync.get({ [KEY_RULES]: [], [KEY_ENABLED]: true }, (data) => {
        if (chrome.runtime.lastError) return;
        applyState(data[KEY_RULES], data[KEY_ENABLED]);
      });
    } catch (e) {
      /* 扩展被重新加载时可能抛错，忽略 */
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (!changes[KEY_RULES] && !changes[KEY_ENABLED]) return;
      const nextRules = changes[KEY_RULES] ? changes[KEY_RULES].newValue : rules;
      const nextEnabled = changes[KEY_ENABLED] ? changes[KEY_ENABLED].newValue : enabled;
      applyState(nextRules, nextEnabled);
    });
  } catch (e) {
    /* ignore */
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'QC_STATS') {
        const stats = {};
        let total = 0;
        for (const rule of rules) {
          let count = 0;
          if (rule && rule.enabled !== false) {
            const expression = String(rule.source || '').trim();
            if (expression) {
              try {
                for (const el of queryXPath(expression)) {
                  if (ruleKind(rule) === 'audio' ? isAudioElement(el) : isTextField(el)) count += 1;
                }
              } catch (e) {
                count = 0;
              }
            }
          }
          stats[rule.id] = count;
          total += count;
        }
        sendResponse({ ok: true, stats, total, enabled });
        return;
      }

      if (msg.type === 'QC_START_PICK') {
        startPick(msg.ruleId, msg.field, msg.kind);
        sendResponse({ ok: true });
        return;
      }
    });
  } catch (e) {
    /* ignore */
  }

  /* ---------- DOM 监听 ---------- */

  observer = new MutationObserver(() => {
    if (!enabled || !rules.length) return;
    scheduleScan();
  });

  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  } catch (e) {
    /* ignore */
  }

  window.addEventListener('scroll', updatePositions, { capture: true, passive: true });
  window.addEventListener('resize', updatePositions, { passive: true });

  loadState();
})();
