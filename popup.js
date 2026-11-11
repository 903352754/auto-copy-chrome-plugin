'use strict';

/* 快速复制助手 —— 弹窗逻辑 */

let rules = [];
let enabled = true;
let stats = {};
let pickedId = null;
let addKind = 'input';

let asrConfig = { appId: '', secretId: '', secretKey: '', engineType: '16k_zh' };

let saveTimer = 0;
let statTimer = 0;
let toastTimer = 0;
let asrTimer = 0;

const ASR_KEY = 'qc_asr_config';

let ui = {};

/* ---------- 初始化 ---------- */

async function init() {
  ui = {
    master: document.getElementById('master'),
    source: document.getElementById('new-source'),
    target: document.getElementById('new-target'),
    addBtn: document.getElementById('add-btn'),
    addTabs: Array.from(document.querySelectorAll('.kind-tab')),
    list: document.getElementById('list'),
    summary: document.getElementById('stat-summary'),
    toast: document.getElementById('toast'),
    asrConfig: document.getElementById('asr-config'),
    asrStatus: document.getElementById('asr-status'),
    asrAppId: document.getElementById('asr-appid'),
    asrSecretId: document.getElementById('asr-secretid'),
    asrSecretKey: document.getElementById('asr-secretkey'),
    asrEngine: document.getElementById('asr-engine')
  };

  const data = await storage.getSync({ qc_rules: [], qc_enabled: true });
  rules = normalizeRules(data.qc_rules);
  enabled = data.qc_enabled !== false;

  await loadAsrConfig();
  await applyPendingPick();

  ui.master.checked = enabled;
  bindEvents();
  setAddKind('input', true);
  renderList();
  refreshStats();

  // 有语音规则但没有配置密钥时，直接展开配置面板提醒
  if (rules.some((r) => ruleKind(r) === 'audio') && !isAsrConfigured()) {
    ui.asrConfig.open = true;
  }
}

function ruleKind(rule) {
  return rule && rule.kind === 'audio' ? 'audio' : 'input';
}

function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && typeof item.source === 'string')
    .map((item) => ({
      id: item.id || newId(),
      kind: item.kind === 'audio' ? 'audio' : 'input',
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
  },
  setLocal(value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(value, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }
};

/* ---------- 腾讯云语音识别配置 ---------- */

function normalizeAsrConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    appId: String(source.appId || '').trim(),
    secretId: String(source.secretId || '').trim(),
    secretKey: String(source.secretKey || '').trim(),
    engineType: String(source.engineType || '16k_zh').trim() || '16k_zh'
  };
}

function isAsrConfigured() {
  return !!(asrConfig.appId && asrConfig.secretId && asrConfig.secretKey);
}

async function loadAsrConfig() {
  const data = await storage.getLocal(ASR_KEY);
  asrConfig = normalizeAsrConfig(data[ASR_KEY]);

  ui.asrAppId.value = asrConfig.appId;
  ui.asrSecretId.value = asrConfig.secretId;
  ui.asrSecretKey.value = asrConfig.secretKey;

  const engines = Array.from(ui.asrEngine.options).map((option) => option.value);
  if (!engines.includes(asrConfig.engineType)) asrConfig.engineType = '16k_zh';
  ui.asrEngine.value = asrConfig.engineType;

  updateAsrStatus();
}

function updateAsrStatus() {
  if (!ui.asrStatus) return;
  const configured = isAsrConfigured();
  ui.asrStatus.textContent = configured ? '已配置' : '未配置';
  ui.asrStatus.className = 'asr-status ' + (configured ? 'on' : 'off');
}

function readAsrConfigFromUi() {
  return normalizeAsrConfig({
    appId: ui.asrAppId.value,
    secretId: ui.asrSecretId.value,
    secretKey: ui.asrSecretKey.value,
    engineType: ui.asrEngine.value
  });
}

function scheduleAsrSave() {
  clearTimeout(asrTimer);
  asrTimer = setTimeout(saveAsrConfig, 400);
}

async function saveAsrConfig() {
  clearTimeout(asrTimer);
  asrTimer = 0;

  asrConfig = readAsrConfigFromUi();
  updateAsrStatus();

  try {
    await storage.setLocal({ [ASR_KEY]: asrConfig });
  } catch (e) {
    toast('语音识别配置保存失败，请重试');
  }
}

/* ---------- 拾取结果回填 ---------- */

async function applyPendingPick() {
  const data = await storage.getLocal('qc_pending_pick');
  const pending = data.qc_pending_pick;
  const xpath = pending && (pending.xpath || pending.selector);
  if (!xpath) return;

  await storage.removeLocal('qc_pending_pick');

  // 超过 10 分钟的旧拾取结果不再使用
  if (pending.ts && Date.now() - pending.ts > 10 * 60 * 1000) return;

  const rule = rules.find((r) => r.id === pending.ruleId);
  if (!rule) return;

  const field = pending.field === 'source' ? 'source' : 'target';
  rule[field] = xpath;
  await saveNow();

  pickedId = rule.id;
  setTimeout(() => toast('已填入拾取到的 XPath'), 80);
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
    line2.textContent = '在上方选择「快速复制」或「识别语音」，再添加 XPath';

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
  const isAudio = ruleKind(rule) === 'audio';

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

  const badge = document.createElement('span');
  badge.className = 'rule-badge' + (isAudio ? ' audio' : '');
  badge.textContent = isAudio ? '语音' : '复制';

  const count = document.createElement('span');
  count.className = 'rule-count';

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'del-btn';
  delBtn.textContent = '✕';
  delBtn.title = '删除规则';

  top.append(switchLabel, badge, count, spacer, delBtn);

  row.append(
    top,
    createField(
      isAudio ? '音频' : '源',
      'source',
      rule.source,
      isAudio ? "audio XPath，如 //audio[@id='player']" : "XPath，如 //input[@class='price-input']",
      'source',
      isAudio ? 'audio' : 'input'
    ),
    createField('目标', 'target', rule.target, "XPath，如 //textarea[@id='remark']", 'target', 'input')
  );

  updateRowCount(row, rule);
  return row;
}

function createField(labelText, className, value, placeholder, fieldName, pickKind) {
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

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'pick-btn';
  pickBtn.dataset.field = fieldName;
  pickBtn.textContent = '拾取';
  pickBtn.title =
    pickKind === 'audio'
      ? '在页面上点选 audio 播放器'
      : fieldName === 'source'
        ? '在页面上点选源输入框'
        : '在页面上点选目标输入框';

  field.append(label, input, pickBtn);
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

  if (!String(rule.source || '').trim()) {
    el.textContent = '未设置源';
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
    setSummary(total ? '本页共 ' + total + ' 个匹配元素' : '本页暂无匹配元素');
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
  const isAudio = addKind === 'audio';

  if (!source && !target) {
    rules.push({ id: newId(), kind: addKind, source: '', target: '', enabled: true });
    ui.source.focus();
    renderList();
    await saveNow();
    scheduleStats();
    if (isAudio && !isAsrConfigured()) {
      ui.asrConfig.open = true;
      toast('已添加空语音规则，请先填写腾讯云语音识别配置');
    } else {
      toast(
        isAudio
          ? '已添加空语音规则，点「拾取」选择 audio 播放器和填入位置'
          : '已添加空规则，点字段右侧的「拾取」选择输入框'
      );
    }
    return;
  }

  if (source && rules.some((r) => r.source === source && ruleKind(r) === addKind)) {
    toast('已存在相同的源规则');
    ui.source.focus();
    return;
  }

  rules.push({ id: newId(), kind: addKind, source, target, enabled: true });

  ui.source.value = '';
  ui.target.value = '';
  ui.source.focus();

  renderList();
  await saveNow();
  scheduleStats();

  if (isAudio && !isAsrConfigured()) {
    ui.asrConfig.open = true;
    toast('语音规则已添加，请先填写腾讯云语音识别配置');
  } else {
    toast(target ? '规则已添加' : '规则已添加，可点「拾取」设置目标');
  }
}

async function deleteRule(id) {
  const removed = rules.find((r) => r.id === id);
  rules = rules.filter((r) => r.id !== id);

  renderList();
  await saveNow();
  scheduleStats();

  toast(removed ? '已删除：' + removed.source : '规则已删除');
}

async function pickField(id, field, kind) {
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

  const fieldName = field === 'source' ? 'source' : 'target';
  const pickKind = fieldName === 'source' && kind === 'audio' ? 'audio' : 'input';

  try {
    await sendToTab(tab.id, { type: 'QC_START_PICK', ruleId: id, field: fieldName, kind: pickKind });
  } catch (e) {
    toast('无法连接页面，请刷新网页后重试');
    return;
  }

  toast(
    pickKind === 'audio'
      ? '已进入拾取模式，点击页面上的 audio 播放器'
      : fieldName === 'source'
        ? '已进入拾取模式，点击页面上的源输入框'
        : '已进入拾取模式，点击页面上的目标输入框'
  );
  setTimeout(() => window.close(), 350);
}

function setAddKind(kind, silent) {
  addKind = kind === 'audio' ? 'audio' : 'input';

  for (const tab of ui.addTabs) {
    const active = tab.dataset.kind === addKind;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  ui.source.placeholder =
    addKind === 'audio'
      ? "audio XPath，如 //audio[@id='player']"
      : "源 XPath，如 //input[@class='price-input']";
  ui.addBtn.textContent = addKind === 'audio' ? '＋ 添加语音规则' : '＋ 添加规则';

  if (addKind === 'audio' && !isAsrConfigured()) ui.asrConfig.open = true;

  if (!silent) ui.source.focus();
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

  for (const tab of ui.addTabs) {
    tab.addEventListener('click', () => setAddKind(tab.dataset.kind));
  }

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

    const pickBtn = e.target.closest('.pick-btn');
    if (pickBtn) {
      const rule = rules.find((r) => r.id === id);
      pickField(id, pickBtn.dataset.field === 'source' ? 'source' : 'target', ruleKind(rule));
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

  for (const input of [ui.asrAppId, ui.asrSecretId, ui.asrSecretKey]) {
    input.addEventListener('input', scheduleAsrSave);
    input.addEventListener('change', saveAsrConfig);
  }
  ui.asrEngine.addEventListener('change', saveAsrConfig);

  // 关闭弹窗时把尚未落盘的修改补存一次
  window.addEventListener('pagehide', () => {
    if (saveTimer) saveNow();
    if (asrTimer) saveAsrConfig();
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
