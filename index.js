import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { t } from '../../../i18n.js';

const MODULE = 'token_flow';
const GENERATE_ENDPOINT = '/api/backends/chat-completions/generate';
const STREAM_DONE = '[DONE]';

const PRESET_MODELS = [
    { name: 'gpt-4o',             input: 2.50, output: 10.00, cached: 1.25,   perRequest: 0 },
    { name: 'gpt-4o-mini',        input: 0.15, output: 0.60,  cached: 0.075,  perRequest: 0 },
    { name: 'gpt-5',              input: 1.25, output: 10.00, cached: 0.625,  perRequest: 0 },
    { name: 'claude-opus-4.6',    input: 15.00, output: 75.00, cached: 1.50,  perRequest: 0 },
    { name: 'claude-sonnet-4.6',  input: 3.00, output: 15.00, cached: 0.30,   perRequest: 0 },
    { name: 'gemini-3.1-pro',     input: 1.25, output: 10.00, cached: 0.10,   perRequest: 0 },
    { name: 'deepseek-chat',      input: 0.27, output: 1.10,  cached: 0.07,   perRequest: 0 },
    { name: 'deepseek-reasoner',  input: 0.55, output: 2.19,  cached: 0.14,   perRequest: 0 },
    { name: 'kimi-k2.6',          input: 1.00, output: 8.00,  cached: 0.10,   perRequest: 0 },
    { name: 'qwen3.5-plus',       input: 0.80, output: 2.00,  cached: 0.10,   perRequest: 0 },
    { name: 'mimo-v2.5-pro',      input: 3.00, output: 6.00,  cached: 0.025,  perRequest: 0 },
];

const defaultSettings = {
    enabled: true,
    trackExact: true,
    useFallback: true,
    displayCurrency: '$',
    exchangeRate: 1,
    models: structuredClone(PRESET_MODELS),
    stats: { models: {}, totalCost: 0, totalTokens: 0, totalRequests: 0 },
    session: { models: {}, totalCost: 0, totalTokens: 0, totalRequests: 0 },
    sessionStartedAt: Date.now(),
};

function getSettings() {
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) s[key] = structuredClone(defaultSettings[key]);
    }
    if (!Array.isArray(s.models)) s.models = structuredClone(PRESET_MODELS);
    if (!s.stats || typeof s.stats !== 'object') s.stats = structuredClone(defaultSettings.stats);
    if (!s.session || typeof s.session !== 'object') s.session = structuredClone(defaultSettings.session);
    if (!s.stats.models) s.stats.models = {};
    if (!s.session.models) s.session.models = {};
    return s;
}

/* ============================================================
 *  费用计算引擎
 * ============================================================ */

function getPriceFor(settings, model) {
    const key = String(model || '').toLowerCase().trim();
    if (!key) return { name: model, input: 0, output: 0, cached: 0, perRequest: 0 };
    const exact = settings.models.find(m => String(m.name).toLowerCase() === key);
    if (exact) return exact;
    const fuzzy = settings.models.find(m =>
        key.includes(String(m.name).toLowerCase()) ||
        String(m.name).toLowerCase().includes(key),
    );
    return fuzzy || { name: model, input: 0, output: 0, cached: 0, perRequest: 0 };
}

/**
 * 计算一次请求的费用（USD 原始 + 换算后显示货币）
 */
function calcCost(settings, model, inTok, outTok, cachedTok, requests = 1) {
    const price = getPriceFor(settings, model);
    const tokenCost =
        (inTok / 1e6) * (price.input || 0) +
        (outTok / 1e6) * (price.output || 0) +
        (cachedTok / 1e6) * (price.cached || 0);
    const reqCost = (price.perRequest || 0) * requests;
    const usd = tokenCost + reqCost;
    return {
        usd,
        display: usd * settings.exchangeRate,
        price,
    };
}

function fmtMoney(settings, usd) {
    const val = usd * settings.exchangeRate;
    if (val === 0) return `${settings.displayCurrency}0`;
    if (Math.abs(val) >= 1000) return `${settings.displayCurrency}${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (Math.abs(val) >= 1) return `${settings.displayCurrency}${val.toFixed(3)}`;
    return `${settings.displayCurrency}${val.toFixed(6)}`;
}

function fmtTokens(n) {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
}

/* ============================================================
 *  数据记录（累计 + 会话双桶）
 * ============================================================ */

function recordUsage(model, inTok, outTok, cachedTok, isEstimate, requests = 1) {
    const s = getSettings();
    if (!s.enabled) return;

    const key = String(model || 'unknown');

    for (const bucketName of ['stats', 'session']) {
        const bucket = s[bucketName];
        if (!bucket.models[key]) {
            bucket.models[key] = { in: 0, out: 0, cached: 0, req: 0, cost: 0, est: 0 };
        }
        const m = bucket.models[key];
        m.in += inTok || 0;
        m.out += outTok || 0;
        m.cached += cachedTok || 0;
        m.req += requests;
        if (isEstimate) m.est += 1;

        const cost = calcCost(s, key, inTok, outTok, cachedTok, requests);
        m.cost += cost.usd;

        bucket.totalTokens = (bucket.totalTokens || 0) + (inTok || 0) + (outTok || 0) + (cachedTok || 0);
        bucket.totalRequests = (bucket.totalRequests || 0) + requests;
        bucket.totalCost = (bucket.totalCost || 0) + cost.usd;
    }

    saveSettingsDebounced();
    safeUpdateUI();
}

/* ============================================================
 *  本地估算兜底（中英混合字符估算）
 * ============================================================ */

function estimateTokens(text) {
    if (!text) return 0;
    const str = String(text);
    const cjk = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const other = str.length - cjk;
    return Math.max(1, Math.round(cjk * 0.9 + other / 4));
}

/* ============================================================
 *  Fetch 拦截：捕获真实 API usage（monkey-patch window.fetch）
 * ============================================================ */

function extractUsageFromBody(body) {
    if (!body) return null;
    const usage = body.usage || body.data?.usage || body.choices?.[0]?.usage || body.completions?.[0]?.usage;
    if (!usage) return null;
    const inTok = usage.prompt_tokens || usage.input_tokens || usage.input || 0;
    const outTok = usage.completion_tokens || usage.output_tokens || usage.output || 0;
    const cachedTok = usage.prompt_tokens_details?.cached_tokens ||
        usage.cache_creation_input_tokens || usage.cache_read_input_tokens || 0;
    const totalTok = usage.total_tokens || (inTok + outTok + cachedTok);
    if (!totalTok && !inTok && !outTok) return null;
    return { in: inTok, out: outTok, cached: cachedTok };
}

let patchInstalled = false;

function installFetchInterceptor() {
    if (patchInstalled || typeof window.fetch !== 'function') return;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
        const [input, init] = args;
        let url = '';
        try {
            url = typeof input === 'string' ? input : (input?.url || '');
        } catch { /* ignore */ }

        if (typeof url === 'string' && url.includes(GENERATE_ENDPOINT) && init?.method?.toUpperCase() === 'POST') {
            try {
                const bodyText = typeof init.body === 'string' ? init.body : JSON.stringify(init?.body || {});
                let reqBody = {};
                try { reqBody = JSON.parse(bodyText || '{}'); } catch { /* ignore */ }

                const isStream = reqBody.stream === true ||
                    (Array.isArray(reqBody.stream_options) && reqBody.stream_options.includes('include_usage'));

                const resp = await originalFetch(...args);

                if (isStream && resp.body && typeof resp.body.getReader === 'function') {
                    cloneAndTrackStream(resp, reqBody);
                    return resp;
                }

                const clone = resp.clone();
                clone.json().then(async (json) => {
                    try {
                        const usage = extractUsageFromBody(json);
                        if (usage) {
                            const model = json.model || reqBody.model || 'unknown';
                            recordUsage(model, usage.in, usage.out, usage.cached, false);
                        }
                    } catch { /* ignore */ }
                }).catch(() => { /* 非 JSON 或读取失败，忽略 */ });

                return resp;
            } catch (e) {
                console.warn('[TokenFlow] fetch interceptor error:', e);
            }
        }

        return originalFetch(...args);
    };

    patchInstalled = true;
    console.log('[TokenFlow] fetch interceptor installed');
}

async function cloneAndTrackStream(resp, reqBody) {
    try {
        const cloned = resp.clone();
        const reader = cloned.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let lastUsage = null;
        let sawDone = false;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split('\n\n');
            buffer = parts.pop();

            for (const chunk of parts) {
                if (sawDone) continue;
                const line = chunk.split('\n').find(l => l.startsWith('data:'));
                if (!line) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                if (data === STREAM_DONE) { sawDone = true; break; }
                try {
                    const json = JSON.parse(data);
                    const usage = extractUsageFromBody(json);
                    if (usage) lastUsage = usage;
                    if (!lastUsage && json.model) reqBody._tfModel = json.model;
                } catch { /* 片段 JSON，跳过 */ }
            }
        }

        if (lastUsage) {
            const model = reqBody._tfModel || reqBody.model || 'unknown';
            recordUsage(model, lastUsage.in, lastUsage.out, lastUsage.cached, false);
        }
    } catch (e) {
        console.warn('[TokenFlow] stream tracking failed:', e);
    }
}

/* ============================================================
 *  UI：设置面板
 * ============================================================ */

function makeInput(id, type, initial, oninput) {
    const inp = document.createElement('input');
    inp.id = id;
    inp.type = type;
    inp.value = initial;
    inp.className = 'text_pole';
    inp.addEventListener('input', oninput);
    return inp;
}

function addExtensionSettings() {
    const container = document.getElementById('token_flow_settings') ?? document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('token_flow_drawer')) return; // 避免重复注入
    const s = getSettings();

    // 官方 inline-drawer 结构
    const drawer = document.createElement('div');
    drawer.id = 'token_flow_drawer';
    drawer.classList.add('inline-drawer');
    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const name = document.createElement('b');
    name.textContent = 'TokenFlow';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(name, icon);
    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');
    drawer.append(toggle, content);
    container.appendChild(drawer);

    // Dashboard 容器（放在设置上方，实时展示统计）
    const dash = document.createElement('div');
    dash.id = 'token_flow_dashboard';
    content.appendChild(dash);

    const wrap = document.createElement('div');
    wrap.className = 'tokenflow-settings';
    content.appendChild(wrap);

    const row = (label, el) => {
        const r = document.createElement('div');
        r.className = 'tf-row';
        r.appendChild(label);
        r.appendChild(el);
        wrap.appendChild(r);
    };

    const span = (text) => {
        const e = document.createElement('span');
        e.textContent = text;
        e.className = 'tf-label';
        return e;
    };

    // 开关
    const sw = document.createElement('label');
    sw.className = 'checkbox_label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.enabled;
    cb.addEventListener('change', () => { s.enabled = cb.checked; saveSettingsDebounced(); });
    sw.appendChild(cb);
    sw.appendChild(document.createTextNode(t('启用统计')));
    row(span(t('统计开关')), sw);

    const sw2 = document.createElement('label');
    sw2.className = 'checkbox_label';
    const cb2 = document.createElement('input');
    cb2.type = 'checkbox';
    cb2.checked = !!s.trackExact;
    cb2.addEventListener('change', () => { s.trackExact = cb2.checked; saveSettingsDebounced(); });
    sw2.appendChild(cb2);
    sw2.appendChild(document.createTextNode(t('捕获真实 API usage')));
    row(span(t('精确追踪')), sw2);

    const sw3 = document.createElement('label');
    sw3.className = 'checkbox_label';
    const cb3 = document.createElement('input');
    cb3.type = 'checkbox';
    cb3.checked = !!s.useFallback;
    cb3.addEventListener('change', () => { s.useFallback = cb3.checked; saveSettingsDebounced(); });
    sw3.appendChild(cb3);
    sw3.appendChild(document.createTextNode(t('本地估算兜底')));
    row(span(t('估算兜底')), sw3);

    // 币种 + 汇率
    row(span(t('显示币种')),
        makeInput('tf_currency', 'text', s.displayCurrency, () => {
            s.displayCurrency = document.getElementById('tf_currency').value || '$';
            saveSettingsDebounced(); updateDashboard();
        }));
    row(span(t('汇率 (1 USD = ?)')),
        makeInput('tf_rate', 'number', s.exchangeRate, () => {
            const v = parseFloat(document.getElementById('tf_rate').value);
            if (v > 0) { s.exchangeRate = v; saveSettingsDebounced(); updateDashboard(); }
        }));

    // 模型价格编辑表
    const table = document.createElement('table');
    table.className = 'tf-price-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>' + t('模型') + '</th><th>' + t('输入 $/1M') + '</th><th>' + t('输出 $/1M') + '</th><th>' + t('缓存 $/1M') + '</th><th>' + t('按次 $') + '</th><th></th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    const renderRows = () => {
        tbody.innerHTML = '';
        s.models.forEach((m, i) => {
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            const nameInput = document.createElement('input');
            nameInput.className = 'text_pole tf-name';
            nameInput.value = m.name;
            nameInput.addEventListener('input', () => { m.name = nameInput.value; saveSettingsDebounced(); });
            tdName.appendChild(nameInput);
            tr.appendChild(tdName);

            for (const f of ['input', 'output', 'cached', 'perRequest']) {
                const td = document.createElement('td');
                const inp = document.createElement('input');
                inp.className = 'text_pole tf-num';
                inp.type = 'number';
                inp.step = 'any';
                inp.value = m[f];
                inp.addEventListener('input', () => {
                    const v = parseFloat(inp.value);
                    m[f] = isNaN(v) ? 0 : v;
                    saveSettingsDebounced(); updateDashboard();
                });
                td.appendChild(inp);
                tr.appendChild(td);
            }

            const tdDel = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.className = 'tf-del';
            delBtn.addEventListener('click', () => {
                if (s.models.length <= 1) return;
                s.models.splice(i, 1);
                saveSettingsDebounced(); renderRows();
            });
            tdDel.appendChild(delBtn);
            tr.appendChild(tdDel);
            tbody.appendChild(tr);
        });
    };
    renderRows();
    table.appendChild(tbody);
    wrap.appendChild(span(t('模型价格表')));
    wrap.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.textContent = '+' + t('添加模型');
    addBtn.className = 'menu_button';
    addBtn.addEventListener('click', () => {
        s.models.push({ name: 'new-model', input: 0, output: 0, cached: 0, perRequest: 0 });
        saveSettingsDebounced(); renderRows();
    });
    wrap.appendChild(addBtn);

    // 数据操作
    const btnRow = document.createElement('div');
    btnRow.className = 'tf-btn-row';
    const resetAll = document.createElement('button');
    resetAll.textContent = t('清空全部数据');
    resetAll.className = 'menu_button';
    resetAll.addEventListener('click', () => {
        s.stats = structuredClone(defaultSettings.stats);
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    const resetSession = document.createElement('button');
    resetSession.textContent = t('重置会话');
    resetSession.className = 'menu_button';
    resetSession.addEventListener('click', () => {
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    btnRow.appendChild(resetAll);
    btnRow.appendChild(resetSession);
    wrap.appendChild(btnRow);
}

/* ============================================================
 *  UI：统计 Dashboard
 * ============================================================ */

function updateDashboard() {
    const el = document.getElementById('token_flow_dashboard');
    if (!el) return;
    const s = getSettings();
    if (!s.enabled) {
        el.innerHTML = '<div class="tf-dash-muted">' + t('统计已关闭') + '</div>';
        return;
    }

    const statCard = (label, value, sub) => {
        const card = document.createElement('div');
        card.className = 'tf-stat-card';
        const lab = document.createElement('div');
        lab.className = 'tf-stat-label';
        lab.textContent = label;
        const val = document.createElement('div');
        val.className = 'tf-stat-value';
        val.textContent = value;
        card.appendChild(lab);
        card.appendChild(val);
        if (sub) {
            const s2 = document.createElement('div');
            s2.className = 'tf-stat-sub';
            s2.textContent = sub;
            card.appendChild(s2);
        }
        return card;
    };

    const total = s.stats;
    const session = s.session;
    const totalTokens = (total.totalTokens || 0);
    const totalCost = (total.totalCost || 0);
    const totalReq = (total.totalRequests || 0);
    const sessTokens = (session.totalTokens || 0);
    const sessCost = (session.totalCost || 0);
    const sessReq = (session.totalRequests || 0);

    const grid = document.createElement('div');
    grid.className = 'tf-grid';

    grid.appendChild(statCard(t('累计费用'), fmtMoney(s, totalCost), s.displayCurrency));
    grid.appendChild(statCard(t('累计 Token'), fmtTokens(totalTokens), totalReq + ' ' + t('次请求')));
    grid.appendChild(statCard(t('会话费用'), fmtMoney(s, sessCost), s.displayCurrency));
    grid.appendChild(statCard(t('会话 Token'), fmtTokens(sessTokens), sessReq + ' ' + t('次请求')));

    // 按模型明细
    const modelKeys = Object.keys(total.models || {}).sort();
    if (modelKeys.length) {
        const tbl = document.createElement('div');
        tbl.className = 'tf-model-table';
        const title = document.createElement('div');
        title.className = 'tf-model-title';
        title.textContent = t('模型明细');
        tbl.appendChild(title);

        for (const key of modelKeys) {
            const m = total.models[key];
            if (!m) continue;
            const row = document.createElement('div');
            row.className = 'tf-model-row';

            const left = document.createElement('div');
            const nameEl = document.createElement('span');
            nameEl.className = 'tf-model-name';
            nameEl.textContent = key;
            const meta = document.createElement('span');
            meta.className = 'tf-model-meta';
            const estMark = m.est > 0 ? ' · ' + t('含估算') : '';
            meta.textContent = `${fmtTokens(m.in + m.out + m.cached)} · ${m.req} ${t('次')}${estMark}`;
            left.appendChild(nameEl);
            left.appendChild(meta);

            const right = document.createElement('div');
            right.className = 'tf-model-cost';
            right.textContent = fmtMoney(s, m.cost || 0);

            row.appendChild(left);
            row.appendChild(right);
            tbl.appendChild(row);
        }
        grid.appendChild(tbl);
    }

    const started = document.createElement('div');
    started.className = 'tf-session-start';
    const d = new Date(s.sessionStartedAt || Date.now());
    started.textContent = t('会话开始于') + ' ' + d.toLocaleString();
    grid.appendChild(started);

    el.innerHTML = '';
    el.appendChild(grid);
}

function safeUpdateUI() {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(updateDashboard);
    } else {
        updateDashboard();
    }
}

// 清空会话数据（每日/新会话时调用）
function resetSessionStats() {
    const s = getSettings();
    s.session = structuredClone(defaultSettings.session);
    s.sessionStartedAt = Date.now();
    saveSettingsDebounced();
    safeUpdateUI();
}

/* ============================================================
 *  启动与事件绑定
 *  采用 world-backstage 验证过的模式：
 *  DOM 就绪后再注入 UI，并主动探测容器 + 重试兜底
 * ============================================================ */

function installSettingsEntry() {
    // 避免重复注入
    if (document.getElementById('token_flow_drawer')) return;

    const host = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!host) return false;

    const entry = document.createElement('div');
    entry.id = 'token_flow_entry';
    entry.className = 'tokenflow-settings-entry';
    const drawer = document.createElement('div');
    drawer.id = 'token_flow_drawer';
    drawer.className = 'inline-drawer';
    const toggle = document.createElement('div');
    toggle.className = 'inline-drawer-toggle inline-drawer-header';
    const b = document.createElement('b');
    b.textContent = 'TokenFlow';
    const icon = document.createElement('div');
    icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    toggle.append(b, icon);
    const content = document.createElement('div');
    content.className = 'inline-drawer-content';
    drawer.append(toggle, content);
    entry.appendChild(drawer);
    host.appendChild(entry);

    // Dashboard 容器 + 设置面板
    const dash = document.createElement('div');
    dash.id = 'token_flow_dashboard';
    content.appendChild(dash);
    addExtensionSettingsInto(content);

    safeUpdateUI();
    return true;
}

function addExtensionSettingsInto(content) {
    const s = getSettings();
    const wrap = document.createElement('div');
    wrap.className = 'tokenflow-settings';

    const row = (label, el) => {
        const r = document.createElement('div');
        r.className = 'tf-row';
        r.appendChild(label);
        r.appendChild(el);
        wrap.appendChild(r);
    };
    const span = (text) => {
        const e = document.createElement('span');
        e.textContent = text;
        e.className = 'tf-label';
        return e;
    };

    // 开关
    const mkCheck = (key) => {
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!s[key];
        cb.addEventListener('change', () => { s[key] = cb.checked; saveSettingsDebounced(); });
        label.append(cb);
        return label;
    };

    const sw1 = mkCheck('enabled');
    sw1.append(document.createTextNode(t('启用统计')));
    row(span(t('统计开关')), sw1);

    const sw2 = mkCheck('trackExact');
    sw2.append(document.createTextNode(t('捕获真实 API usage')));
    row(span(t('精确追踪')), sw2);

    const sw3 = mkCheck('useFallback');
    sw3.append(document.createTextNode(t('本地估算兜底')));
    row(span(t('估算兜底')), sw3);

    // 币种 + 汇率
    row(span(t('显示币种')),
        makeInput('tf_currency', 'text', s.displayCurrency, () => {
            s.displayCurrency = document.getElementById('tf_currency').value || '$';
            saveSettingsDebounced(); updateDashboard();
        }));
    row(span(t('汇率 (1 USD = ?)')),
        makeInput('tf_rate', 'number', s.exchangeRate, () => {
            const v = parseFloat(document.getElementById('tf_rate').value);
            if (v > 0) { s.exchangeRate = v; saveSettingsDebounced(); updateDashboard(); }
        }));

    // 模型价格编辑表
    const table = document.createElement('table');
    table.className = 'tf-price-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>' + t('模型') + '</th><th>' + t('输入 $/1M') + '</th><th>' + t('输出 $/1M') + '</th><th>' + t('缓存 $/1M') + '</th><th>' + t('按次 $') + '</th><th></th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    const renderRows = () => {
        tbody.innerHTML = '';
        s.models.forEach((m, i) => {
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            const nameInput = document.createElement('input');
            nameInput.className = 'text_pole tf-name';
            nameInput.value = m.name;
            nameInput.addEventListener('input', () => { m.name = nameInput.value; saveSettingsDebounced(); });
            tdName.appendChild(nameInput);
            tr.appendChild(tdName);

            for (const f of ['input', 'output', 'cached', 'perRequest']) {
                const td = document.createElement('td');
                const inp = document.createElement('input');
                inp.className = 'text_pole tf-num';
                inp.type = 'number';
                inp.step = 'any';
                inp.value = m[f];
                inp.addEventListener('input', () => {
                    const v = parseFloat(inp.value);
                    m[f] = isNaN(v) ? 0 : v;
                    saveSettingsDebounced(); updateDashboard();
                });
                td.appendChild(inp);
                tr.appendChild(td);
            }

            const tdDel = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.className = 'tf-del';
            delBtn.addEventListener('click', () => {
                if (s.models.length <= 1) return;
                s.models.splice(i, 1);
                saveSettingsDebounced(); renderRows();
            });
            tdDel.appendChild(delBtn);
            tr.appendChild(tdDel);
            tbody.appendChild(tr);
        });
    };
    renderRows();
    table.appendChild(tbody);
    wrap.appendChild(span(t('模型价格表')));
    wrap.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.textContent = '+' + t('添加模型');
    addBtn.className = 'menu_button';
    addBtn.addEventListener('click', () => {
        s.models.push({ name: 'new-model', input: 0, output: 0, cached: 0, perRequest: 0 });
        saveSettingsDebounced(); renderRows();
    });
    wrap.appendChild(addBtn);

    // 数据操作
    const btnRow = document.createElement('div');
    btnRow.className = 'tf-btn-row';
    const resetAll = document.createElement('button');
    resetAll.textContent = t('清空全部数据');
    resetAll.className = 'menu_button';
    resetAll.addEventListener('click', () => {
        s.stats = structuredClone(defaultSettings.stats);
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    const resetSession = document.createElement('button');
    resetSession.textContent = t('重置会话');
    resetSession.className = 'menu_button';
    resetSession.addEventListener('click', () => {
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    btnRow.appendChild(resetAll);
    btnRow.appendChild(resetSession);
    wrap.appendChild(btnRow);

    content.appendChild(wrap);
}

function initialize() {
    if (globalThis.__tokenFlowLoaded) return;
    globalThis.__tokenFlowLoaded = true;

    try {
        const settings = getSettings();

        // 注入设置面板（带重试，等待扩展设置容器出现）
        const tryInject = () => {
            if (installSettingsEntry()) return;
            // 容器未就绪，稍后重试
            setTimeout(tryInject, 500);
        };
        tryInject();

        // 安装 fetch 拦截器（捕获真实 API usage）
        if (settings.trackExact) installFetchInterceptor();

        // 生成结束后刷新统计
        const safeOn = (ev) => {
            try { if (ev && ev.length) eventSource.on(ev, safeUpdateUI); } catch (e) { console.warn('[TokenFlow] event bind error:', e); }
        };
        safeOn(event_types.GENERATION_ENDED);
        safeOn(event_types.CHAT_CHANGED);
        safeOn(event_types.MESSAGE_RECEIVED);

        console.log('[TokenFlow] initialized');
    } catch (e) {
        console.error('[TokenFlow] init error:', e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}