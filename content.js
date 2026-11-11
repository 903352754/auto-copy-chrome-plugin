/* 快速复制助手 —— 内容脚本
 * 1. 扫描页面中匹配规则的输入框，在下方悬浮显示「快速复制」按钮
 * 2. 点击按钮时，把源输入框的值填入用户指定的目标输入框，并尝试写入剪贴板
 * 3. 支持从插件弹窗进入「拾取模式」，直接在页面上点选目标输入框
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
  const PICK_TIMEOUT_MS = 60000;

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

  function escapeCss(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !NON_TEXT_TYPES.has(type);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function toSourceSelector(source) {
    const value = String(source || '').trim();
    if (!value) return '';
    if (/^[A-Za-z0-9_-]+$/.test(value)) {
      // 纯类名：同时匹配 input 和 textarea
      return 'input.' + escapeCss(value) + ', textarea.' + escapeCss(value);
    }
    return value;
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
      const selector = toSourceSelector(rule.source);
      if (!selector) continue;

      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (e) {
        continue; // 用户填了非法选择器，跳过
      }

      for (const el of nodes) {
        if (!isTextField(el) || matched.has(el)) continue;
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

  function createButton(input, rule) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qc-btn';
    btn.textContent = BTN_TEXT;
    btn.title = rule.target ? '复制到：' + rule.target : '尚未设置目标输入框';

    // 保持源输入框焦点，避免页面因失焦收起内容
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onCopyClick(input, rule, btn);
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

  function findTargetElement(selector) {
    const value = String(selector || '').trim();
    if (!value) return null;

    let nodes;
    try {
      nodes = Array.from(document.querySelectorAll(value));
    } catch (e) {
      return null;
    }

    let fallback = null;
    for (const node of nodes) {
      if (isTextField(node)) {
        if (isVisible(node)) return node;
        if (!fallback) fallback = node;
        continue;
      }
      // 允许填写包裹输入框的容器选择器
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
          ? '未找到目标输入框，请检查目标选择器：' + rule.target
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

  /* ---------- 拾取目标输入框 ---------- */

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

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';

    if (el.id) {
      const idSel = '#' + escapeCss(el.id);
      try {
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      } catch (e) {
        /* ignore */
      }
    }

    const parts = [];
    let node = el;

    while (node && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();

      if (node.id) {
        const idSel = '#' + escapeCss(node.id);
        try {
          if (document.querySelectorAll(idSel).length === 1) {
            parts.unshift(idSel);
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }

      const classes = Array.from(node.classList || [])
        .filter((c) => c && !c.startsWith('qc-'))
        .slice(0, 3);
      if (classes.length) part += '.' + classes.map(escapeCss).join('.');

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sib) => sib.tagName === node.tagName);
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }

      parts.unshift(part);
      if (!parent || node === document.body) break;

      try {
        if (parts.length >= 2 && document.querySelectorAll(parts.join(' > ')).length === 1) break;
      } catch (e) {
        /* ignore */
      }

      node = parent;
    }

    return parts.join(' > ');
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

  function onPickMove(e) {
    if (!pickState) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const field = findFieldAt(el);
    hoverEl = field;
    positionHighlight(field ? field.getBoundingClientRect() : null);
  }

  function onPickScroll() {
    if (!pickState) return;
    positionHighlight(hoverEl ? hoverEl.getBoundingClientRect() : null);
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

  function onPickClick(e) {
    if (!pickState) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const field = hoverEl || findFieldAt(document.elementFromPoint(e.clientX, e.clientY));
    if (!field) {
      showToast('请点击一个输入框');
      return;
    }

    const selector = buildSelector(field);
    const ruleId = pickState.ruleId;
    exitPick();

    if (!selector) {
      showToast('无法识别这个输入框，请换一个试试');
      return;
    }

    try {
      chrome.storage.local.set({
        [KEY_PENDING]: { ruleId, selector, ts: Date.now() }
      });
    } catch (err) {
      /* ignore */
    }

    showToast('已拾取目标输入框，点击插件图标完成设置', 3500);
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

  function startPick(ruleId) {
    ensureUi();
    exitPick();

    pickState = { ruleId: String(ruleId || ''), timer: 0 };

    banner = document.createElement('div');
    banner.className = 'qc-banner';
    banner.textContent = '点击需要填入内容的目标输入框，按 Esc 取消';
    shadow.appendChild(banner);

    highlight = document.createElement('div');
    highlight.className = 'qc-highlight';
    shadow.appendChild(highlight);

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

    showToast('拾取模式：点击页面上的目标输入框');
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
            const selector = toSourceSelector(rule.source);
            if (selector) {
              try {
                for (const el of document.querySelectorAll(selector)) {
                  if (isTextField(el)) count += 1;
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
        startPick(msg.ruleId);
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
