'use strict';

/* 快速复制助手 —— 弹窗逻辑 */

let rules = [];
let enabled = true;
let stats = {};
let pickedId = null;

let saveTimer = 0;
let statTimer = 0;
let toastTimer = 0;

let ui = {};

/* ---------- 初始化 ---------- */

async function init() {
  ui = {
    master: document.getElementById('master'),
    source: document.getElementById('new-source'),
    target: document.getElementById('new-target'),
    addBtn: document.getElementById('add-btn'),
    list: document.getElementById('list'),
    summary: document.getElementById('stat-summary'),
    toast: document.getElementById('toast')
  };

  const data = await storage.getSync({ qc_rules: [], qc_enabled: true });
  rules = normalizeRules(data.qc_rules);
  enabled = data.qc_enabled !== false;

  await applyPendingPick();

  ui.master.checked = enabled;
  bindEvents();
  renderList();
  refreshStats();
}

function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && typeof item.source === 'string')
    .map((item) => ({
      id: item.id || newId(),
      source: item.source,
      target: typeof item.target === 'string' ? item.target : '',
      enabled: item.enabled !== false
    }));
}

/* ---------- 存储封装 ---------- */

const storage = {
  getSync(defaults) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(defaults, (data) => {
          resolve(chrome.runtime.lastError ? defaults : data || defaults);
        });
      } catch (e) {
        resolve(defaults);
      }
    });
  },
  setSync(value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.sync.set(value, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  },
  getLocal(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (data) => resolve(data || {}));
      } catch (e) {
        resolve({});
      }
    });
  },
  removeLocal(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(key, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }
};

/* ---------- 拾取结果回填 ---------- */

async function applyPendingPick() {
  const data = await storage.getLocal('qc_pending_pick');
  const pending = data.qc_pending_pick;
  if (!pending || !pending.selector) return;

  await storage.removeLocal('qc_pending_pick');

  // 超过 10 分钟的旧拾取结果不再使用
  if (pending.ts && Date.now() - pending.ts > 10 * 60 * 1000) return;

  const rule = rules.find((r) => r.id === pending.ruleId);
  if (!rule) return;

  rule.target = pending.selector;
  await saveNow();

  pickedId = rule.id;
  setTimeout(() => toast('已填入拾取到的目标选择器'), 80);
  scheduleStats(700);
}

/* ---------- 渲染 ---------- */

function renderList() {
  ui.list.textContent = '';

  if (!rules.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '📋';

    const line1 = document.createElement('p');
    line1.textContent = '还没有规则';

    const line2 = document.createElement('p');
    line2.className = 'empty-sub';
    line2.textContent = '在上方添加源类名和目标选择器';

    empty.append(icon, line1, line2);
    ui.list.appendChild(empty);
  } else {
    for (const rule of rules) {
      ui.list.appendChild(createRow(rule));
    }
  }

  updateAllCounts();

  if (pickedId) {
    const row = ui.list.querySelector('.rule[data-id="' + pickedId + '"]');
    if (row) {
      row.classList.add('picked');
      try {
        row.scrollIntoView({ block: 'nearest' });
      } catch (e) {
        /* ignore */
      }
    }
    pickedId = null;
  }
}

function createRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule';
  row.dataset.id = rule.id;

  const top = document.createElement('div');
  top.className = 'rule-top';

  const switchLabel = document.createElement('label');
  switchLabel.className = 'switch';
  switchLabel.title = '启用 / 停用此规则';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'rule-toggle';
  toggle.checked = rule.enabled !== false;

  const slider = document.createElement('span');
  slider.className = 'slider';

  switchLabel.append(toggle, slider);

  const count = document.createElement('span');
  count.className = 'rule-count';

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'pick-btn';
  pickBtn.textContent = '拾取';
  pickBtn.title = '在页面上点选目标输入框';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'del-btn';
  delBtn.textContent = '✕';
  delBtn.title = '删除规则';

  top.append(switchLabel, count, spacer, pickBtn, delBtn);

  row.append(
    top,
    createField('源', 'source', rule.source, '类名或 CSS 选择器'),
    createField('目标', 'target', rule.target, '目标输入框选择器')
  );

  updateRowCount(row, rule);
  return row;
}

function createField(labelText, className, value, placeholder) {
  const field = document.createElement('div');
  field.className = 'field';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = className;
  input.value = value || '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';

  field.append(label, input);
  return field;
}

/* ---------- 计数展示 ---------- */

function updateAllCounts() {
  for (const row of ui.list.querySelectorAll('.rule')) {
    const rule = rules.find((r) => r.id === row.dataset.id);
    if (rule) updateRowCount(row, rule);
  }
}

function updateRowCount(row, rule) {
  const el = row.querySelector('.rule-count');
  if (!el) return;

  if (!enabled) {
    el.textContent = '插件停用';
    el.className = 'rule-count off';
    return;
  }

  if (rule.enabled === false) {
    el.textContent = '已停用';
    el.className = 'rule-count off';
    return;
  }

  const count = stats[rule.id];
  if (typeof count === 'number') {
    el.textContent = count > 0 ? '本页 ' + count + ' 个' : '本页无匹配';
    el.className = 'rule-count' + (count > 0 ? ' on' : '');
  } else {
    el.textContent = '—';
    el.className = 'rule-count';
  }
}

function setSummary(text) {
  ui.summary.textContent = text;
}

async function refreshStats() {
  clearTimeout(statTimer);
  statTimer = 0;

  if (!enabled) {
    stats = {};
    setSummary('插件已停用');
    updateAllCounts();
    return;
  }

  const tab = await getActiveTab();
  const url = tab ? tab.url || '' : '';

  if (!tab || (url && !/^(https?|file):/i.test(url))) {
    stats = {};
    setSummary(tab ? '当前页面不支持' : '未找到活动页面');
    updateAllCounts();
    return;
  }

  try {
    const res = await sendToTab(tab.id, { type: 'QC_STATS' });
    stats = (res && res.stats) || {};
    const total = Object.keys(stats).reduce((sum, key) => sum + (Number(stats[key]) || 0), 0);
    setSummary(total ? '本页共 ' + total + ' 个匹配输入框' : '本页暂无匹配输入框');
  } catch (e) {
    stats = {};
    setSummary('请刷新页面后重试');
  }

  updateAllCounts();
}

function scheduleStats(delay = 600) {
  clearTimeout(statTimer);
  statTimer = setTimeout(refreshStats, delay);
}

/* ---------- 增删改 ---------- */

async function addRule() {
  const source = ui.source.value.trim();
  const target = ui.target.value.trim();

  if (!source) {
    toast('请先填写源输入框的类名或选择器');
    ui.source.focus();
    return;
  }

  if (rules.some((r) => r.source === source)) {
    toast('已存在相同的源规则');
    ui.source.focus();
    return;
  }

  rules.push({ id: newId(), source, target, enabled: true });

  ui.source.value = '';
  ui.target.value = '';
  ui.source.focus();

  renderList();
  await saveNow();
  scheduleStats();

  toast(target ? '规则已添加' : '规则已添加，可点「拾取」设置目标');
}

async function deleteRule(id) {
  const removed = rules.find((r) => r.id === id);
  rules = rules.filter((r) => r.id !== id);

  renderList();
  await saveNow();
  scheduleStats();

  toast(removed ? '已删除：' + removed.source : '规则已删除');
}

async function pickTarget(id) {
  await saveNow();

  const tab = await getActiveTab();
  if (!tab) {
    toast('请先打开一个网页');
    return;
  }

  const url = tab.url || '';
  if (url && !/^(https?|file):/i.test(url)) {
    toast('当前页面不支持拾取，请打开普通网页');
    return;
  }

  try {
    await sendToTab(tab.id, { type: 'QC_START_PICK', ruleId: id });
  } catch (e) {
    toast('无法连接页面，请刷新网页后重试');
    return;
  }

  toast('已进入拾取模式，点击页面上的目标输入框');
  setTimeout(() => window.close(), 350);
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  ui.master.addEventListener('change', () => {
    enabled = ui.master.checked;
    saveNow();
    refreshStats();
    toast(enabled ? '插件已启用' : '插件已停用');
  });

  ui.addBtn.addEventListener('click', addRule);

  [ui.source, ui.target].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRule();
      }
    });
  });

  ui.list.addEventListener('click', (e) => {
    const row = e.target.closest('.rule');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.closest('.del-btn')) {
      deleteRule(id);
      return;
    }

    if (e.target.closest('.pick-btn')) {
      pickTarget(id);
    }
  });

  ui.list.addEventListener('input', (e) => {
    const row = e.target.closest('.rule');
    if (!row) return;
    const rule = rules.find((r) => r.id === row.dataset.id);
    if (!rule) return;

    if (e.target.classList.contains('source')) rule.source = e.target.value;
    else if (e.target.classList.contains('target')) rule.target = e.target.value;
    else return;

    scheduleSave();
    scheduleStats();
  });

  ui.list.addEventListener('change', (e) => {
    if (e.target.classList.contains('source') || e.target.classList.contains('target')) {
      saveNow();
      return;
    }

    const toggle = e.target.closest('.rule-toggle');
    if (!toggle) return;

    const row = toggle.closest('.rule');
    if (!row) return;
    const rule = rules.find((r) => r.id === row.dataset.id);
    if (!rule) return;

    rule.enabled = toggle.checked;
    updateRowCount(row, rule);
    saveNow();
    scheduleStats();
  });
}

/* ---------- 保存 ---------- */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;

  try {
    await storage.setSync({ qc_rules: rules, qc_enabled: enabled });
  } catch (e) {
    toast('保存失败，请重试');
  }
}

/* ---------- 活动页通信 ---------- */

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
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(res);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/* ---------- 杂项 ---------- */

function newId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2200);
}

init();
