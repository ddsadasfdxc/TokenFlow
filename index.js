import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { t } from '../../../i18n.js';

// 安全获取 SillyTavern 上下文（world-backstage 验证过的模式）
function getContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}

// 安全的 i18n 包装：避免 t() 在上下文未就绪时抛异常导致渲染中断
function safeT(key) {
    try {
        const result = t(key);
        return (typeof result === 'string' && result.length > 0) ? result : key;
    } catch {
        return key;
    }
}

const MODULE = 'token_flow';
const GENERATE_ENDPOINT = '/api/backends/chat-completions/generate';
const STREAM_DONE = '[DONE]';

// 2026 最新旗舰定价（$/1M token，cached 为缓存输入价）
// Kimi 官方为 CNY，已按 ~7.1 汇率折算为 USD 基准
const PRESET_MODELS = [
    // OpenAI · ChatGPT 5.6 系列（3 档）
    { name: 'gpt-5.6-sol',        input: 5.00, output: 30.00, cached: 0.50,   perRequest: 0 },
    { name: 'gpt-5.6-terra',      input: 2.50, output: 15.00, cached: 0.25,   perRequest: 0 },
    { name: 'gpt-5.6-luna',       input: 1.00, output: 6.00,  cached: 0.10,   perRequest: 0 },
    // Google · Gemini
    { name: 'gemini-3.1-pro',     input: 2.00, output: 12.00, cached: 0.40,   perRequest: 0 },
    { name: 'gemini-3.5-flash',   input: 1.50, output: 7.50,  cached: 0.30,   perRequest: 0 },
    { name: 'gemini-3.6-flash',   input: 1.50, output: 7.50,  cached: 0.30,   perRequest: 0 },
    { name: 'gemini-3.7-flash',   input: 0.75, output: 3.75,  cached: 0.15,   perRequest: 0 },
    // Anthropic
    { name: 'claude-opus-4.6',    input: 15.00, output: 75.00, cached: 1.50,  perRequest: 0 },
    { name: 'claude-sonnet-4.6',  input: 3.00, output: 15.00, cached: 0.30,   perRequest: 0 },
    // DeepSeek · V4 全系列（快Flash/Pro，均含正式版与预览版；高峰价基准，CNY→USD@7.1）
    // 官方：自2026-08-17起峰谷定价，高峰(9-12,14-18时)为淡季2倍。此处取高峰"缓存未命中输入+输出"为基准
    { name: 'deepseek-v4-flash',  input: 0.42, output: 1.27,  cached: 0.014, perRequest: 0 },
    { name: 'deepseek-v4-pro',    input: 1.27, output: 3.80,  cached: 0.042, perRequest: 0 },
    // Kimi (月之暗面，CNY→USD @7.1)
    { name: 'kimi-k3',            input: 3.00, output: 15.00, cached: 0.30,   perRequest: 0 },
    { name: 'kimi-k2.6',          input: 0.95, output: 4.00,  cached: 0.10,   perRequest: 0 },
];

const defaultSettings = {
    enabled: true,
    trackExact: true,
    useFallback: true,
    displayCurrency: '$',
    exchangeRate: 1,
    showOrb: true,
    orbPosition: null,
    models: structuredClone(PRESET_MODELS),
    modelVersion: 20260819,
    stats: { models: {}, totalCost: 0, totalTokens: 0, totalRequests: 0 },
    session: { models: {}, totalCost: 0, totalTokens: 0, totalRequests: 0 },
    sessionStartedAt: Date.now(),
    // ===== v1.1.0 增强：历史归档 + 预算 + 上下文监控 =====
    history: [],                       // 按日归档 [{date, cost, tokens, req}]
    dailyStats: {},                    // 今日累计 {cost, tokens, req}
    budget: { enabled: false, dailyLimit: 0, monthlyLimit: 0 },
    contextSize: 128000,               // 默认上下文窗口（可编辑）
    lastDailyReport: '',               // 记录最近一次简报日期，避免重复
    autoArchive: true,                 // 是否自动归档
    archiveDays: 30,                   // 历史归档保留天数
    // ===== v1.2.0：五套大师级主题 =====
    theme: 'aurora-midnight',          // 默认主题
    // ===== v1.3.0：Gemini 风格用量限额 =====
    geminiQuota: {
        enabled: true,                  // 是否显示用量限额面板
        metric: 'tokens',               // 度量方式：tokens | cost | requests
        dailyLimit: 0,                  // 每日限额（metric 单位），0=不限
        weeklyLimit: 0,                 // 每周限额，0=不限
        dailyResetTime: '17:19',        // 每日重置时刻 (HH:MM)
        weeklyResetDay: 4,              // 每周重置日 (0=周日..6=周六)
        weeklyResetTime: '12:19',       // 每周重置时刻 (HH:MM)
        upgradeLabel: 'AI Plus',        // 升级卡片标题
        upgradePrice: 'SGD 6.98/月',    // 升级卡片价格
        upgradeMultiplier: 2,           // 升级后倍数
    },
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
    // 预设价格表升级（双保险）：
    // 1) 内置版本比用户保存的新时，整体刷新为最新旗舰报价
    // 2) 即便版本号未变，也主动剔除已淘汰的旧模型，并确保当前旗舰系列存在
    const OBSOLETE = ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'deepseek-chat', 'deepseek-reasoner', 'qwen3.5-plus', 'mimo-v2.5-pro'];
    const NEEDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gemini-3.7-flash'];
    const outdatedVersion = (s.modelVersion || 0) < (defaultSettings.modelVersion || 0);
    const hasObsolete = OBSOLETE.some(dep => s.models.some(m => String(m.name).toLowerCase().includes(dep)));
    const missingFlagships = NEEDS.some(need => !s.models.some(m => String(m.name).toLowerCase() === need));
    if (outdatedVersion || hasObsolete || missingFlagships) {
        // 保留用户手动添加的自定义模型（不在预设命名空间内的），其余以最新预设刷新
        const presetNames = new Map(PRESET_MODELS.map(m => [String(m.name).toLowerCase(), m]));
        const userAdded = s.models.filter(m => !presetNames.has(String(m.name).toLowerCase()));
        const fresh = structuredClone(PRESET_MODELS);
        // 合并用户自定义模型（去重）
        for (const u of userAdded) {
            const ukey = String(u.name).toLowerCase();
            if (!fresh.some(f => String(f.name).toLowerCase() === ukey)) fresh.push(u);
        }
        s.models = fresh;
        s.modelVersion = defaultSettings.modelVersion;
        saveSettingsDebounced();
    }
    if (!s.stats || typeof s.stats !== 'object') s.stats = structuredClone(defaultSettings.stats);
    if (!s.session || typeof s.session !== 'object') s.session = structuredClone(defaultSettings.session);
    if (!s.stats.models) s.stats.models = {};
    if (!s.session.models) s.session.models = {};
    // ===== v1.1.0 兜底：历史归档 / 预算 / 上下文 =====
    if (!Array.isArray(s.history)) s.history = [];
    if (!s.dailyStats || typeof s.dailyStats !== 'object') s.dailyStats = { cost: 0, tokens: 0, req: 0 };
    if (!s.budget || typeof s.budget !== 'object') s.budget = { enabled: false, dailyLimit: 0, monthlyLimit: 0 };
    if (typeof s.contextSize !== 'number') s.contextSize = 128000;
    // ===== v1.3.0 兜底：Gemini 用量限额 =====
    if (!s.geminiQuota || typeof s.geminiQuota !== 'object') {
        s.geminiQuota = structuredClone(defaultSettings.geminiQuota);
    } else {
        // 逐字段补齐，防止旧配置缺字段
        const dq = defaultSettings.geminiQuota;
        for (const k of Object.keys(dq)) {
            if (s.geminiQuota[k] === undefined) s.geminiQuota[k] = dq[k];
        }
    }
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

    recordDailyUsage(s, cost.usd, inTok + outTok + cachedTok, requests, isEstimate);
    checkBudgetAlert(s, cost.usd);
    maybeArchive(s);

    saveSettingsDebounced();
    safeUpdateUI();
    updateOrbBadge();
    maybeDailyReport();
}

/* ============================================================
 *  v1.1.0 新增：每日/历史归档、预算、趋势、上下文监控
 * ============================================================ */

function _todayStr(d = new Date()) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

// 每日统计：按自然日累积
function recordDailyUsage(s, costUsd, tokens, req, isEstimate) {
    if (!s.dailyStats || typeof s.dailyStats !== 'object') s.dailyStats = { cost: 0, tokens: 0, req: 0 };
    s.dailyStats.cost = (s.dailyStats.cost || 0) + costUsd;
    s.dailyStats.tokens = (s.dailyStats.tokens || 0) + (tokens || 0);
    s.dailyStats.req = (s.dailyStats.req || 0) + (req || 0);
    // 会话开始日期追踪（用于换天重置）
    s.dailyStats.date = s.dailyStats.date || _todayStr();
    if (s.dailyStats.date !== _todayStr()) {
        s.dailyStats = { cost: costUsd, tokens: tokens || 0, req: req || 0, date: _todayStr(), est: isEstimate ? 1 : 0 };
    } else if (isEstimate) {
        s.dailyStats.est = (s.dailyStats.est || 0) + 1;
    }
}

// 预算预警：超过 80%/100% 阈值 → 悬浮球角标 + 控制台提示
function checkBudgetAlert(s, costUsd) {
    if (!s.budget || !s.budget.enabled) return;
    const dailyLimit = s.budget.dailyLimit || 0;
    const dailyCost = (s.dailyStats && s.dailyStats.cost) || 0;
    if (dailyLimit > 0 && dailyCost >= dailyLimit) {
        setOrbAlert('over_daily');
    } else if (dailyLimit > 0 && dailyCost >= dailyLimit * 0.8) {
        setOrbAlert('warn_daily');
    }
    // 月度预算基于 history 累加
    const monthStr = _todayStr().slice(0, 7);
    const monthlyCost = s.history.filter(h => (h.date || '').startsWith(monthStr))
        .reduce((a, h) => a + (h.cost || 0), 0) + dailyCost;
    const monthlyLimit = s.budget.monthlyLimit || 0;
    if (monthlyLimit > 0 && monthlyCost >= monthlyLimit) setOrbAlert('over_month');
    else if (monthlyLimit > 0 && monthlyCost >= monthlyLimit * 0.8) setOrbAlert('warn_month');
}

// 按日归档：每日记账一条，保留 archiveDays
function maybeArchive(s) {
    if (s.autoArchive === false) return;
    const today = _todayStr();
    if (!Array.isArray(s.history)) s.history = [];
    let rec = s.history.find(h => h.date === today);
    if (!rec) {
        rec = { date: today, cost: 0, tokens: 0, req: 0 };
        s.history.push(rec);
    }
    rec.cost = (rec.cost || 0) + (s.dailyStats ? s.dailyStats.cost : 0);
    rec.tokens = (rec.tokens || 0) + (s.dailyStats ? s.dailyStats.tokens : 0);
    rec.req = (rec.req || 0) + (s.dailyStats ? s.dailyStats.req : 0);
    // 保留最近 N 天
    const cutoff = Date.now() - (s.archiveDays || 30) * 86400000;
    s.history = s.history.filter(h => new Date(h.date + 'T00:00:00').getTime() >= cutoff);
}

// 上下文占用监控（估算当前聊天上下文 token 占用比例）
function contextUsagePercent() {
    const s = getSettings();
    const ctx = s.contextSize || 128000;
    const chatArr = (() => { try { return getContext()?.chat || globalThis.chat || []; } catch { return []; } })();
    let est = 0;
    if (Array.isArray(chatArr)) {
        for (const msg of chatArr) {
            if (!msg || typeof msg !== 'object') continue;
            est += estimateTokens(msg.mes || msg.content || msg.name || '');
        }
    }
    return { used: est, limit: ctx, pct: Math.min(100, (est / ctx) * 100) };
}

// 浮动球角标
function setOrbAlert(mode) {
    const s = getSettings();
    if (s.showOrb === false) return;
    const orbBadge = document.getElementById('token_flow_orb_badge');
    if (!orbBadge) return;
    orbBadge.style.display = '';
    orbBadge.textContent = '!';
    orbBadge.classList.add('tf-alert');
    orbBadge.setAttribute('data-mode', mode);
}

function clearOrbAlert() {
    const orbBadge = document.getElementById('token_flow_orb_badge');
    if (orbBadge) { orbBadge.style.display = 'none'; orbBadge.classList.remove('tf-alert'); }
}

function updateOrbBadge() {
    const s = getSettings();
    if (s.showOrb === false) { clearOrbAlert(); return; }
    const badge = document.getElementById('token_flow_orb_badge');
    if (!badge) return;
    const dailyCost = (s.dailyStats && s.dailyStats.cost) || 0;
    // 有预算预警时显示预警角标，否则显示今日费用
    if (badge.classList.contains('tf-alert')) return;
    if (dailyCost > 0) {
        badge.style.display = '';
        badge.textContent = fmtMoney(s, dailyCost);
    } else {
        badge.style.display = 'none';
    }
}

// 每日用量简报（写入聊天流提示，可关闭）
function maybeDailyReport() {
    const s = getSettings();
    const today = _todayStr();
    if (s.lastDailyReport === today) return;
    s.lastDailyReport = today;
    // 仅当日有记录时展示一次
    if (!s.dailyStats || (s.dailyStats.cost || 0) <= 0) return;
    console.log(`[TokenFlow] 今日用量简报: ${fmtMoney(s, s.dailyStats.cost)} · ${fmtTokens(s.dailyStats.tokens)} tokens · ${s.dailyStats.req} 请求`);
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
    sw.appendChild(document.createTextNode(safeT('启用统计')));
    row(span(safeT('统计开关')), sw);

    const sw2 = document.createElement('label');
    sw2.className = 'checkbox_label';
    const cb2 = document.createElement('input');
    cb2.type = 'checkbox';
    cb2.checked = !!s.trackExact;
    cb2.addEventListener('change', () => { s.trackExact = cb2.checked; saveSettingsDebounced(); });
    sw2.appendChild(cb2);
    sw2.appendChild(document.createTextNode(safeT('捕获真实 API usage')));
    row(span(safeT('精确追踪')), sw2);

    const sw3 = document.createElement('label');
    sw3.className = 'checkbox_label';
    const cb3 = document.createElement('input');
    cb3.type = 'checkbox';
    cb3.checked = !!s.useFallback;
    cb3.addEventListener('change', () => { s.useFallback = cb3.checked; saveSettingsDebounced(); });
    sw3.appendChild(cb3);
    sw3.appendChild(document.createTextNode(safeT('本地估算兜底')));
    row(span(safeT('估算兜底')), sw3);

    // ===== v1.2.0：五套大师级主题切换器 =====
    const THEMES = [
        { id: 'cyber-royal',     name: '赛博帝京', dot: '#ff2d95' },
        { id: 'ink-zen',         name: '水墨禅境', dot: '#8aa8b8' },
        { id: 'aurora-midnight', name: '午夜极光', dot: '#7df9ff' },
        { id: 'molten-gold',     name: '熔金斜阳', dot: '#ffb347' },
        { id: 'mono-white',      name: '纯白极简', dot: '#64748b' },
    ];
    const themeRow = document.createElement('div');
    themeRow.className = 'tf-theme-picker';
    for (const th of THEMES) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tf-theme-chip';
        chip.setAttribute('data-theme', th.id);
        chip.innerHTML = `<span class="tf-theme-dot" style="background:${th.dot};color:${th.dot}"></span>${safeT(th.name)}`;
        if (s.theme === th.id) chip.classList.add('active');
        chip.addEventListener('click', () => {
            s.theme = th.id;
            // 更新激活态
            themeRow.querySelectorAll('.tf-theme-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            applyTheme();
            saveSettingsDebounced();
        });
        themeRow.appendChild(chip);
    }
    row(span(safeT('主题')), themeRow);

    // 币种 + 汇率
    row(span(safeT('显示币种')),
        makeInput('tf_currency', 'text', s.displayCurrency, () => {
            s.displayCurrency = document.getElementById('tf_currency').value || '$';
            saveSettingsDebounced(); updateDashboard();
        }));
    row(span(safeT('汇率 (1 USD = ?)')),
        makeInput('tf_rate', 'number', s.exchangeRate, () => {
            const v = parseFloat(document.getElementById('tf_rate').value);
            if (v > 0) { s.exchangeRate = v; saveSettingsDebounced(); updateDashboard(); }
        }));

    // 模型价格编辑表
    const table = document.createElement('table');
    table.className = 'tf-price-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>' + safeT('模型') + '</th><th>' + safeT('输入 $/1M') + '</th><th>' + safeT('输出 $/1M') + '</th><th>' + safeT('缓存 $/1M') + '</th><th>' + safeT('按次 $') + '</th><th></th></tr>';
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
    wrap.appendChild(span(safeT('模型价格表')));
    wrap.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.textContent = '+' + safeT('添加模型');
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
    resetAll.textContent = safeT('清空全部数据');
    resetAll.className = 'menu_button';
    resetAll.addEventListener('click', () => {
        s.stats = structuredClone(defaultSettings.stats);
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    const resetSession = document.createElement('button');
    resetSession.textContent = safeT('重置会话');
    resetSession.className = 'menu_button';
    resetSession.addEventListener('click', () => {
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    btnRow.appendChild(resetAll);
    btnRow.appendChild(resetSession);
    wrap.appendChild(btnRow);

    // ============ v1.3.0：Gemini 用量限额设置 ============
    const qs = document.createElement('div');
    qs.className = 'tf-quota-settings';
    const qTitle = document.createElement('div');
    qTitle.className = 'tf-quota-settings-title';
    qTitle.textContent = '🧪 ' + safeT('用量限额') + ' · ' + safeT('设置');
    qs.appendChild(qTitle);
    const qGrid = document.createElement('div');
    qGrid.className = 'tf-quota-settings-grid';
    const gq = s.geminiQuota || {};

    const field = (label, input) => {
        const d = document.createElement('div');
        d.className = 'tf-quota-field';
        const l = document.createElement('label');
        l.textContent = label;
        d.appendChild(l);
        d.appendChild(input);
        return d;
    };
    const numInput = (val, onchange) => {
        const i = document.createElement('input');
        i.type = 'number';
        i.value = val;
        i.addEventListener('input', onchange);
        return i;
    };
    // 开关：启用面板
    const swQ = document.createElement('label');
    swQ.className = 'checkbox_label';
    const cbQ = document.createElement('input');
    cbQ.type = 'checkbox';
    cbQ.checked = !!gq.enabled;
    cbQ.addEventListener('change', () => { gq.enabled = cbQ.checked; saveSettingsDebounced(); safeUpdateUI(); });
    swQ.appendChild(cbQ);
    swQ.appendChild(document.createTextNode(safeT('启用')));
    qGrid.appendChild(field(safeT('显示用量限额'), swQ));

    // 度量方式
    const sel = document.createElement('select');
    sel.innerHTML = `<option value="tokens">${safeT('次数')} (tokens)</option><option value="cost">${safeT('金额')} (cost)</option><option value="requests">${safeT('请求数')} (requests)</option>`;
    sel.value = gq.metric || 'tokens';
    sel.addEventListener('change', () => { gq.metric = sel.value; saveSettingsDebounced(); safeUpdateUI(); });
    qGrid.appendChild(field(safeT('度量方式'), sel));

    // 每日限额
    qGrid.appendChild(field(safeT('每日限额'),
        numInput(gq.dailyLimit || 0, (e) => { gq.dailyLimit = parseFloat(e.target.value) || 0; saveSettingsDebounced(); safeUpdateUI(); })));
    // 每周限额
    qGrid.appendChild(field(safeT('每周限额'),
        numInput(gq.weeklyLimit || 0, (e) => { gq.weeklyLimit = parseFloat(e.target.value) || 0; saveSettingsDebounced(); safeUpdateUI(); })));
    // 每日重置时刻
    const rTime = document.createElement('input');
    rTime.type = 'time';
    rTime.value = gq.dailyResetTime || '17:19';
    rTime.addEventListener('change', () => { gq.dailyResetTime = rTime.value || '17:19'; saveSettingsDebounced(); safeUpdateUI(); });
    qGrid.appendChild(field(safeT('每日重置时刻'), rTime));
    qs.appendChild(qGrid);
    wrap.appendChild(qs);
}

/* ============================================================
 *  UI：统计 Dashboard
 * ============================================================ */

function updateDashboard() {
    applyTheme();
    // 优先渲染到悬浮球弹层（主统计页），回退到设置面板内嵌容器
    const el = document.getElementById('token_flow_panel_body') || document.getElementById('token_flow_dashboard');
    if (!el) return;
    const s = getSettings();
    if (!s.enabled) {
        el.innerHTML = '<div class="tf-dash-muted">' + safeT('统计已关闭') + '</div>';
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

    grid.appendChild(statCard(safeT('累计费用'), fmtMoney(s, totalCost), s.displayCurrency));
    grid.appendChild(statCard(safeT('累计 Token'), fmtTokens(totalTokens), totalReq + ' ' + safeT('次请求')));
    grid.appendChild(statCard(safeT('会话费用'), fmtMoney(s, sessCost), s.displayCurrency));
    grid.appendChild(statCard(safeT('会话 Token'), fmtTokens(sessTokens), sessReq + ' ' + safeT('次请求')));

    // ============ 写作画像：字数 + 消息条数（实时统计当前聊天） ============
    const chatArr = (() => { try { return getContext()?.chat || globalThis.chat || []; } catch { return []; } })();
    let uChars = 0, cChars = 0, uMsgs = 0, cMsgs = 0;
    const _strip = (t) => String(t || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ');
    if (Array.isArray(chatArr)) {
        for (const msg of chatArr) {
            if (!msg || typeof msg !== 'object') continue;
            const isU = msg.is_user ? true : (msg.role === 'user');
            const body = _strip(msg.mes || msg.content || '');
            if (isU) { uChars += body.length; uMsgs++; }
            else { cChars += body.length; cMsgs++; }
        }
    }
    const allChars = uChars + cChars;
    const allMsgs = uMsgs + cMsgs;
    const classicBooks = [
        { name: '《红楼梦》', chars: 730000 },
        { name: '《三体》三部曲', chars: 900000 },
        { name: '《三国演义》', chars: 640000 },
        { name: '《活着》', chars: 120000 },
        { name: '《百年孤独》', chars: 300000 },
        { name: '《战争与和平》', chars: 1200000 },
    ];
    const theBook = classicBooks[Math.floor(Math.random() * classicBooks.length)];
    const bookQty = allChars > 0 ? (allChars / theBook.chars).toFixed(allChars / theBook.chars < 10 ? 2 : 1) : '0';

    const writingBlock = document.createElement('div');
    writingBlock.className = 'tf-writing';
    const wTitle = document.createElement('div');
    wTitle.className = 'tf-writing-title';
    wTitle.textContent = '✍ ' + safeT('写作画像');
    const wGrid = document.createElement('div');
    wGrid.className = 'tf-writing-grid';
    const cell = (label, val, hint) => {
        const d = document.createElement('div');
        d.className = 'tf-writing-cell';
        const v = document.createElement('div');
        v.className = 'tf-writing-val';
        v.textContent = val;
        const l = document.createElement('div');
        l.className = 'tf-writing-label';
        l.textContent = label;
        d.appendChild(v); d.appendChild(l);
        if (hint) { const t = document.createElement('div'); t.className = 'tf-writing-hint'; t.textContent = hint; d.appendChild(t); }
        return d;
    };
    wGrid.appendChild(cell(safeT('总字数'), allChars.toLocaleString(), safeT('约') + ' ' + allMsgs + ' ' + safeT('条消息')));
    wGrid.appendChild(cell(safeT('User 字数'), uChars.toLocaleString(), safeT('共') + ' ' + uMsgs + ' ' + safeT('条')));
    wGrid.appendChild(cell(safeT('角色字数'), cChars.toLocaleString(), safeT('共') + ' ' + cMsgs + ' ' + safeT('条')));
    wGrid.appendChild(cell(safeT('总消息'), allMsgs.toLocaleString(), safeT('User') + ' ' + uMsgs + ' · ' + safeT('角色') + ' ' + cMsgs));
    writingBlock.appendChild(wTitle);
    writingBlock.appendChild(wGrid);
    const wTip = document.createElement('div');
    wTip.className = 'tf-writing-tip';
    wTip.textContent = `🎯 ${allChars.toLocaleString()} ${safeT('字约相当于')} 【${theBook.name}】 ${bookQty} ${safeT('本')}`;
    writingBlock.appendChild(wTip);
    grid.appendChild(writingBlock);

    // ============ v1.1.0：每日用量趋势图（近 14 天柱状图） ============
    const trendBlock = document.createElement('div');
    trendBlock.className = 'tf-trend';
    const trendTitle = document.createElement('div');
    trendTitle.className = 'tf-writing-title';
    trendTitle.textContent = '📈 ' + safeT('近期用量趋势') + ' (14d)';
    trendBlock.appendChild(trendTitle);
    const trendBars = document.createElement('div');
    trendBars.className = 'tf-trend-bars';
    const hist = Array.isArray(s.history) ? s.history.slice(-14) : [];
    if (!hist.length) {
        const empty = document.createElement('div');
        empty.className = 'tf-trend-empty';
        empty.textContent = safeT('暂无历史数据');
        trendBars.appendChild(empty);
    } else {
        const maxCost = Math.max(1, ...hist.map(h => h.cost || 0));
        for (const h of hist) {
            const col = document.createElement('div');
            col.className = 'tf-trend-col';
            const bar = document.createElement('div');
            bar.className = 'tf-trend-bar';
            bar.style.height = Math.max(6, ((h.cost || 0) / maxCost) * 100) + '%';
            bar.title = `${h.date}: ${fmtMoney(s, h.cost || 0)} / ${fmtTokens(h.tokens || 0)}`;
            const val = document.createElement('span');
            val.className = 'tf-trend-val';
            val.textContent = h.date.slice(5);
            col.appendChild(bar);
            col.appendChild(val);
            trendBars.appendChild(col);
        }
    }
    trendBlock.appendChild(trendBars);
    grid.appendChild(trendBlock);

    // ============ v1.1.0：预算 + 上下文监控 ============
    const monoBlock = document.createElement('div');
    monoBlock.className = 'tf-mono';
    const monoGrid = document.createElement('div');
    monoGrid.className = 'tf-writing-grid';

    // 今日预算进度
    const dailyCostNow = (s.dailyStats && s.dailyStats.cost) || 0;
    const dailyLimit = (s.budget && s.budget.dailyLimit) || 0;
    const dPct = dailyLimit > 0 ? Math.min(100, (dailyCostNow / dailyLimit) * 100) : 0;
    const dCell = document.createElement('div');
    dCell.className = 'tf-writing-cell';
    dCell.innerHTML = `<div class="tf-writing-val">${fmtMoney(s, dailyCostNow)}</div><div class="tf-writing-label">${safeT('今日费用')}</div>`;
    if (dailyLimit > 0) {
        const dbar = document.createElement('div');
        dbar.className = 'tf-budget-bar';
        const dfill = document.createElement('div');
        dfill.className = 'tf-budget-fill' + (dPct >= 100 ? ' over' : dPct >= 80 ? ' warn' : '');
        dfill.style.width = dPct + '%';
        dbar.appendChild(dfill);
        dCell.appendChild(dbar);
        const dmeta = document.createElement('div');
        dmeta.className = 'tf-writing-hint';
        dmeta.textContent = `${safeT('日预算')} ${fmtMoney(s, dailyLimit)} · ${Math.round(dPct)}%`;
        dCell.appendChild(dmeta);
    }
    monoGrid.appendChild(dCell);

    // 上下文占用
    const ctx = contextUsagePercent();
    const cCell = document.createElement('div');
    cCell.className = 'tf-writing-cell';
    cCell.innerHTML = `<div class="tf-writing-val">${Math.round(ctx.pct)}%</div><div class="tf-writing-label">${safeT('上下文占用')}</div>`;
    const cbar = document.createElement('div');
    cbar.className = 'tf-budget-bar';
    const cfill = document.createElement('div');
    cfill.className = 'tf-budget-fill' + (ctx.pct >= 90 ? ' over' : ctx.pct >= 70 ? ' warn' : '');
    cfill.style.width = ctx.pct + '%';
    cbar.appendChild(cfill);
    cCell.appendChild(cbar);
    const cmeta = document.createElement('div');
    cmeta.className = 'tf-writing-hint';
    cmeta.textContent = `${fmtTokens(ctx.used)} / ${fmtTokens(ctx.limit)}`;
    cCell.appendChild(cmeta);
    monoGrid.appendChild(cCell);

    monoBlock.appendChild(monoGrid);
    grid.appendChild(monoBlock);

    // 按模型明细 —— 加入成本占比进度条 + 排名徽标
    const modelKeys = Object.keys(total.models || {}).sort((a, b) =>
        ((total.models[b] && total.models[b].cost) || 0) - ((total.models[a] && total.models[a].cost) || 0),
    );
    const costArr = modelKeys.map(k => (total.models[k] && total.models[k].cost) || 0);
    const sumCost = costArr.reduce((x, y) => x + y, 0) || 1;
    if (modelKeys.length) {
        const tbl = document.createElement('div');
        tbl.className = 'tf-model-table';
        const title = document.createElement('div');
        title.className = 'tf-model-title';
        title.textContent = safeT('模型明细') + ' · ' + safeT('按费用排序');
        tbl.appendChild(title);
        const palette = ['#5eead4', '#93c5fd', '#c4b5fd', '#fda4af', '#fcd34d', '#86efac', '#f9a8d4', '#a5b4fc'];
        modelKeys.forEach((key, idx) => {
            const m = total.models[key];
            if (!m) return;
            const share = (m.cost || 0) / sumCost;
            const row = document.createElement('div');
            row.className = 'tf-model-row';
            const left = document.createElement('div');
            const topLine = document.createElement('div');
            topLine.className = 'tf-model-top';
            const rank = document.createElement('span');
            rank.className = 'tf-model-rank';
            rank.textContent = idx + 1;
            rank.style.background = palette[idx % palette.length];
            const nameEl = document.createElement('span');
            nameEl.className = 'tf-model-name';
            nameEl.textContent = key;
            const meta = document.createElement('span');
            meta.className = 'tf-model-meta';
            const estMark = m.est > 0 ? ' · ' + safeT('含估算') : '';
            meta.textContent = `${fmtTokens(m.in + m.out + m.cached)} · ${m.req} ${safeT('次')}${estMark}`;
            topLine.appendChild(rank);
            topLine.appendChild(nameEl);
            topLine.appendChild(meta);
            const bar = document.createElement('div');
            bar.className = 'tf-model-bar';
            const fill = document.createElement('div');
            fill.className = 'tf-model-bar-fill';
            fill.style.width = Math.round(share * 100) + '%';
            fill.style.background = palette[idx % palette.length];
            const pct = document.createElement('span');
            pct.className = 'tf-model-bar-pct';
            pct.textContent = (share * 100).toFixed(share * 100 < 10 ? 1 : 0) + '%';
            bar.appendChild(fill);
            bar.appendChild(pct);
            left.appendChild(topLine);
            left.appendChild(bar);
            const right = document.createElement('div');
            right.className = 'tf-model-cost';
            right.textContent = fmtMoney(s, m.cost || 0);
            row.appendChild(left);
            row.appendChild(right);
            tbl.appendChild(row);
        });
        grid.appendChild(tbl);
    }
    const started = document.createElement('div');
    started.className = 'tf-session-start';
    const d = new Date(s.sessionStartedAt || Date.now());
    started.textContent = safeT('会话开始于') + ' ' + d.toLocaleString();
    grid.appendChild(started);

    el.innerHTML = '';
    el.appendChild(grid);

    // ============ v1.3.0：Gemini 风格用量限额面板 ============
    renderGeminiQuota(el, s);
}

/* ============================================================
 *  v1.3.0 · Gemini「用量限额」一比一还原
 * ============================================================ */
// 计算当日周期内的用量（按当前 metric）
function quotaMetricUsage(s, windowStartTs) {
    const metric = (s.geminiQuota && s.geminiQuota.metric) || 'tokens';
    // dailyStats 只有今日累计；此函数用于匹配 json mode 下的"周期内"用量
    const d = s.dailyStats || {};
    // 对于日周期直接用今日累计（hourly 之前的全部）
    const now = Date.now();
    // 简单处理：日周期内用量 = 今日累计
    if (metric === 'cost') return d.cost || 0;
    if (metric === 'requests') return d.req || 0;
    return d.tokens || 0;
}

// 计算本周累计用量：累加 history 中本周发生的历史 + 今日
function quotaWeeklyUsage(s) {
    const cfg = s.geminiQuota || {};
    const metric = cfg.metric || 'tokens';
    const weekStart = weeklyResetMillis(s);
    let sum = 0;
    if (Array.isArray(s.history)) {
        for (const h of s.history) {
            if (!h || !h.date) continue;
            const t = new Date(h.date + 'T00:00:00Z').getTime();
            if (t >= weekStart) {
                if (metric === 'cost') sum += h.cost || 0;
                else if (metric === 'requests') sum += h.req || 0;
                else sum += h.tokens || 0;
            }
        }
    }
    const d = s.dailyStats || {};
    sum += (metric === 'cost') ? (d.cost || 0)
        : (metric === 'requests') ? (d.req || 0) : (d.tokens || 0);
    return sum;
}

// 计算本周起始时间戳（基于 weeklyResetDay/weeklyResetTime）
function weeklyResetMillis(s) {
    const cfg = s.geminiQuota || {};
    const day = (cfg.weeklyResetDay == null) ? 4 : (cfg.weeklyResetDay % 7);
    const wt = stringToMin((cfg.weeklyResetTime || '12:19').split(':'));
    const now = new Date();
    const m = new Date(now);
    m.setHours(0, 0, 0, 0);
    // 本周已过天数
    let diff = (now.getDay() - day + 7) % 7;
    m.setDate(m.getDate() - diff);
    m.setMinutes(wt.min, wt.sec, 0, 0);
    // 如果起始时间在未来，回退到上周
    if (m.getTime() > now.getTime()) m.setDate(m.getDate() - 7);
    return m.getTime();
}
function stringToMin(a) {
    return { min: parseInt(a[0], 10) || 0, sec: parseInt(a[1], 10) || 0 };
}
// 计算今日重置时刻（基于 dailyResetTime）
function dailyResetMillis(s) {
    const cfg = s.geminiQuota || {};
    const t = (cfg.dailyResetTime || '17:19').split(':');
    const m = new Date();
    m.setHours(parseInt(t[0], 10) || 0, parseInt(t[1], 10) || 0, 0, 0);
    return m.getTime();
}
function fmtClock(s, mode) {
    const cfg = s.geminiQuota || {};
    let h, min, day;
    if (mode === 'daily') {
        const t = (cfg.dailyResetTime || '17:19').split(':');
        h = t[0]; min = t[1];
        return `${h}:${min}`;
    } else {
        const t = (cfg.weeklyResetTime || '12:19').split(':');
        day = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][(cfg.weeklyResetDay == null ? 4 : cfg.weeklyResetDay % 7)];
        return `${day} ${t[0]}:${t[1]}`;
    }
}

// 渲染环形进度 SVG
function quotaRingHTML(pct, used, limit, label, mode, s) {
    const R = 34, C = 2 * Math.PI * R;
    const safe = Math.max(0, Math.min(100, pct));
    const off = C - (safe / 100) * C;
    const tone = safe >= 100 ? 'over' : safe >= 80 ? 'warn' : '';
    const usedStr = limit > 0 ? `${fmtCompact(s, used)} / ${fmtCompact(s, limit)}` : `${fmtCompact(s, used)}`;
    return `
        <div class="tf-quota-ring">
            <div class="tf-ring">
                <svg viewBox="0 0 78 78">
                    <circle class="tf-ring-bg" cx="39" cy="39" r="${R}"/>
                    <circle class="tf-ring-fg ${tone}" cx="39" cy="39" r="${R}"
                        stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
                </svg>
                <div class="tf-ring-center">
                    <div class="tf-ring-pct">${Math.round(safe)}%</div>
                    <div class="tf-ring-used">${safeT('已用')}</div>
                </div>
            </div>
            <div class="tf-ring-meta">
                <div class="tf-ring-label">${label}</div>
                <div class="tf-ring-desc">${usedStr}</div>
                <div class="tf-ring-reset">🔄 ${safeT('重置')} · ${fmtClock(s, mode)}</div>
            </div>
        </div>`;
}
// 格式化用量：cost -> 金额，tokens -> 万，requests -> 次
function fmtCompact(s, v) {
    const metric = (s.geminiQuota && s.geminiQuota.metric) || 'tokens';
    if (metric === 'cost') return fmtMoney(s, v);
    if (metric === 'requests') return fmtTokens(v) + ' ' + safeT('次');
    return fmtTokens(v);
}

// 主渲染函数：Gemini 风格用量限额面板
function renderGeminiQuota(el, s) {
    const cfg = s.geminiQuota || {};
    if (cfg.enabled === false) return;
    try {
        const wrap = document.createElement('div');
        wrap.className = 'tf-writing';
        // 头部
        const head = document.createElement('div');
        head.className = 'tf-quota-head';
        const title = document.createElement('div');
        title.className = 'tf-quota-title';
        title.innerHTML = `<span class="tf-quota-icon">🧪</span>${safeT('用量限额')}`;
        const sub = document.createElement('div');
        sub.className = 'tf-quota-sub';
        sub.textContent = safeT('用量限额副标题');
        head.appendChild(title);
        head.appendChild(sub);
        wrap.appendChild(head);

        // 两个环形：今日用量 / 每周限额
        const rings = document.createElement('div');
        rings.className = 'tf-quota-ring-wrap';

        const dailyLimit = cfg.dailyLimit || 0;
        const dailyUsed = quotaMetricUsage(s, dailyResetMillis(s));
        const dPct = dailyLimit > 0 ? (dailyUsed / dailyLimit) * 100 : 0;
        rings.innerHTML = quotaRingHTML(dPct, dailyUsed, dailyLimit, safeT('当前用量'), 'daily', s);

        const weeklyLimit = cfg.weeklyLimit || 0;
        const weeklyUsed = quotaWeeklyUsage(s);
        const wPct = weeklyLimit > 0 ? (weeklyUsed / weeklyLimit) * 100 : 0;
        rings.insertAdjacentHTML('beforeend', quotaRingHTML(wPct, weeklyUsed, weeklyLimit, safeT('每周限额'), 'weekly', s));
        wrap.appendChild(rings);

        // 升级卡片
        const up = document.createElement('div');
        up.className = 'tf-quota-upgrade';
        const info = document.createElement('div');
        info.className = 'tf-quota-upgrade-info';
        const emoji = document.createElement('div');
        emoji.className = 'tf-quota-upgrade-emoji';
        emoji.textContent = '⚡';
        const text = document.createElement('div');
        text.className = 'tf-quota-upgrade-text';
        const tb = document.createElement('b');
        tb.textContent = safeT('升级用量限额标题').replace('{n}', cfg.upgradeMultiplier || 2);
        const ts = document.createElement('span');
        ts.textContent = safeT('升级用量限额副标题');
        text.appendChild(tb);
        text.appendChild(ts);
        info.appendChild(emoji);
        info.appendChild(text);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tf-quota-upgrade-btn';
        btn.textContent = safeT('升级');
        btn.addEventListener('click', () => {
            console.log(`[TokenFlow] quota upgrade: ${cfg.upgradeLabel} ${cfg.upgradePrice}`);
        });
        up.appendChild(info);
        up.appendChild(btn);
        wrap.appendChild(up);

        el.appendChild(wrap);
    } catch (e) {
        console.warn('[TokenFlow] renderGeminiQuota:', e);
    }
}
function applyTheme() {
    try {
        const s = getSettings();
        const theme = s.theme || 'aurora-midnight';
        const containers = [
            document.getElementById('token_flow_panel'),
            document.getElementById('token_flow_drawer'),
            document.getElementById('token_flow_dashboard'),
        ];
        for (const el of containers) {
            if (el) el.setAttribute('data-tf-theme', theme);
        }
        // 同步悬浮球图标用色（可选）
        const orbIcon = document.querySelector('.tf-orb-icon');
        if (orbIcon) orbIcon.style.color = 'var(--tf-accent, #5eead4)';
    } catch (e) {
        console.warn('[TokenFlow] applyTheme:', e);
    }
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
 *  悬浮球 + 统计弹层（对齐 world-backstage 的 orb 模式）
 *  - 悬浮球固定在屏幕，可拖动 + 自动贴边 + 记忆位置
 *  - 点击悬浮球展开/收起实时统计弹层
 * ============================================================ */

const ORB_SIZE = 56;
let orbDragState = null;
let orbSuppressClick = false;

function ensureFloatingUI() {
    if (document.getElementById('token_flow_orb')) return true;
    if (!document.body) return false;

    const fragment = document.createElement('div');
    fragment.innerHTML = `
        <button class="tf-orb" id="token_flow_orb" type="button" aria-label="${safeT('打开用量统计')}" title="TokenFlow · ${safeT('用量统计')}">
            <span class="tf-orb-icon fa-solid fa-chart-line"></span>
            <span class="tf-orb-badge" id="token_flow_orb_badge" style="display:none"></span>
        </button>
        <div class="tf-panel-scrim" id="token_flow_panel_scrim" style="display:none"></div>
        <section class="tf-panel" id="token_flow_panel" role="dialog" aria-modal="true" style="display:none">
            <header class="tf-panel-header">
                <div class="tf-panel-title">
                    <b>TokenFlow</b>
                    <span>${safeT('用量统计')}</span>
                </div>
                <div class="tf-panel-actions">
                    <button class="tf-panel-refresh menu_button" id="token_flow_refresh" type="button" title="${safeT('刷新')}"><i class="fa-solid fa-rotate"></i></button>
                    <button class="tf-panel-reset menu_button" id="token_flow_reset_session" type="button" title="${safeT('重置会话')}"><i class="fa-solid fa-clock-rotate-left"></i></button>
                    <button class="tf-panel-close menu_button" id="token_flow_panel_close" type="button" title="${safeT('关闭')}"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </header>
            <div class="tf-panel-body" id="token_flow_panel_body"></div>
        </section>
    `;

    document.body.appendChild(fragment);

    const orb = document.getElementById('token_flow_orb');
    const panel = document.getElementById('token_flow_panel');
    const scrim = document.getElementById('token_flow_panel_scrim');
    const closeBtn = document.getElementById('token_flow_panel_close');
    const refreshBtn = document.getElementById('token_flow_refresh');
    const resetBtn = document.getElementById('token_flow_reset_session');

    // 恢复悬浮球位置
    const stored = getSettings().orbPosition;
    if (stored && typeof stored.x === 'number') {
        orb.style.left = stored.x + 'px';
        orb.style.top = stored.y + 'px';
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
    }

    // 拖动逻辑
    orb.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const rect = orb.getBoundingClientRect();
        orbDragState = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: rect.left,
            originY: rect.top,
            moved: false,
        };
        orb.setPointerCapture?.(e.pointerId);
        orb.classList.add('is-dragging');
    });
    orb.addEventListener('pointermove', (e) => {
        if (!orbDragState || e.pointerId !== orbDragState.pointerId) return;
        const dx = e.clientX - orbDragState.startX;
        const dy = e.clientY - orbDragState.startY;
        if (Math.hypot(dx, dy) > 5) orbDragState.moved = true;
        if (!orbDragState.moved) return;
        let x = orbDragState.originX + dx;
        let y = orbDragState.originY + dy;
        x = Math.max(8, Math.min(window.innerWidth - ORB_SIZE - 8, x));
        y = Math.max(8, Math.min(window.innerHeight - ORB_SIZE - 8, y));
        orb.style.left = x + 'px';
        orb.style.top = y + 'px';
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
        e.preventDefault();
    });
    const finishOrbDrag = (e) => {
        if (!orbDragState || e.pointerId !== orbDragState.pointerId) return;
        orb.classList.remove('is-dragging');
        orb.releasePointerCapture?.(e.pointerId);
        const drag = orbDragState;
        orbDragState = null;
        if (drag.moved) {
            const rect = orb.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const snapLeft = centerX < window.innerWidth / 2;
            const margin = 12;
            const snapX = snapLeft ? margin : window.innerWidth - ORB_SIZE - margin;
            orb.style.left = snapX + 'px';
            orb.style.right = 'auto';
            const s = getSettings();
            s.orbPosition = { x: snapX, y: rect.top };
            saveSettingsDebounced();
            orbSuppressClick = true;
            setTimeout(() => { orbSuppressClick = false; }, 260);
        }
    };
    orb.addEventListener('pointerup', finishOrbDrag);
    orb.addEventListener('pointercancel', finishOrbDrag);

    // 展开/收起
    orb.addEventListener('click', () => {
        if (orbSuppressClick) return;
        const open = panel.style.display !== 'none';
        panel.style.display = open ? 'none' : 'flex';
        scrim.style.display = open ? 'none' : 'block';
        orb.classList.toggle('is-open', !open);
        if (!open) { safeUpdateUI(); }
    });
    closeBtn.addEventListener('click', () => {
        panel.style.display = 'none';
        scrim.style.display = 'none';
        orb.classList.remove('is-open');
    });
    scrim.addEventListener('click', () => {
        panel.style.display = 'none';
        scrim.style.display = 'none';
        orb.classList.remove('is-open');
    });
    refreshBtn.addEventListener('click', safeUpdateUI);
    resetBtn.addEventListener('click', resetSessionStats);

    // ESC 关闭 & 面板标题栏拖动
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.style.display !== 'none') {
            panel.style.display = 'none';
            scrim.style.display = 'none';
            orb.classList.remove('is-open');
        }
    });

    console.log('[TokenFlow] floating orb + panel mounted');
    safeUpdateUI();
    return true;
}

/* ============================================================
 *  启动与事件绑定
 *  采用 world-backstage 验证过的模式：
 *  DOM 就绪后再注入 UI，并主动探测容器 + 重试兜底
 * ============================================================ */

function installSettingsEntry() {
    if (document.getElementById('token_flow_drawer')) return true;

    const host = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!host) {
        console.warn('[TokenFlow] settings container not found, will retry...');
        return false;
    }

    console.log('[TokenFlow] injecting settings into', host.id);

    const entry = document.createElement('div');
    entry.id = 'token_flow_entry';
    entry.innerHTML = `
        <div class="inline-drawer" id="token_flow_drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>TokenFlow</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="tf-settings-hint">
                    ${safeT('统计面板已移至悬浮球，点击右下角悬浮球即可展开。')}
                </div>
                <div class="tokenflow-settings" id="token_flow_settings_inner"></div>
            </div>
        </div>
    `;
    host.appendChild(entry);

    addExtensionSettingsInto(document.getElementById('token_flow_settings_inner'));
    console.log('[TokenFlow] settings panel injected');
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
    sw1.append(document.createTextNode(safeT('启用统计')));
    row(span(safeT('统计开关')), sw1);

    const sw2 = mkCheck('trackExact');
    sw2.append(document.createTextNode(safeT('捕获真实 API usage')));
    row(span(safeT('精确追踪')), sw2);

    const sw3 = mkCheck('useFallback');
    sw3.append(document.createTextNode(safeT('本地估算兜底')));
    row(span(safeT('估算兜底')), sw3);

    // 悬浮球开关
    const sw4 = mkCheck('showOrb');
    sw4.append(document.createTextNode(safeT('显示统计悬浮球')));
    row(span(safeT('统计悬浮球')), sw4);
    // 监听悬浮球开关
    const sw4Input = sw4.querySelector('input');
    sw4Input.addEventListener('change', () => {
        const orbe = document.getElementById('token_flow_orb');
        if (orbe) orbe.style.display = sw4Input.checked ? '' : 'none';
    });

    // 打开统计面板按钮
    const openBtnRow = document.createElement('div');
    openBtnRow.className = 'tf-btn-row';
    const openBtn = document.createElement('button');
    openBtn.textContent = safeT('打开统计面板');
    openBtn.className = 'menu_button';
    openBtn.addEventListener('click', () => {
        const panel = document.getElementById('token_flow_panel');
        const scrim = document.getElementById('token_flow_panel_scrim');
        const orbe = document.getElementById('token_flow_orb');
        if (panel) {
            panel.style.display = 'flex';
            scrim.style.display = 'block';
            orbe?.classList.add('is-open');
            safeUpdateUI();
        }
    });
    openBtnRow.appendChild(openBtn);
    wrap.appendChild(openBtnRow);

    // 币种 + 汇率
    row(span(safeT('显示币种')),
        makeInput('tf_currency', 'text', s.displayCurrency, () => {
            s.displayCurrency = document.getElementById('tf_currency').value || '$';
            saveSettingsDebounced(); updateDashboard();
        }));
    row(span(safeT('汇率 (1 USD = ?)')),
        makeInput('tf_rate', 'number', s.exchangeRate, () => {
            const v = parseFloat(document.getElementById('tf_rate').value);
            if (v > 0) { s.exchangeRate = v; saveSettingsDebounced(); updateDashboard(); }
        }));

    // 模型价格编辑表
    const table = document.createElement('table');
    table.className = 'tf-price-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>' + safeT('模型') + '</th><th>' + safeT('输入 $/1M') + '</th><th>' + safeT('输出 $/1M') + '</th><th>' + safeT('缓存 $/1M') + '</th><th>' + safeT('按次 $') + '</th><th></th></tr>';
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
    wrap.appendChild(span(safeT('模型价格表')));
    wrap.appendChild(table);

    const addBtn = document.createElement('button');
    addBtn.textContent = '+' + safeT('添加模型');
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
    resetAll.textContent = safeT('清空全部数据');
    resetAll.className = 'menu_button';
    resetAll.addEventListener('click', () => {
        s.stats = structuredClone(defaultSettings.stats);
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    const resetSession = document.createElement('button');
    resetSession.textContent = safeT('重置会话');
    resetSession.className = 'menu_button';
    resetSession.addEventListener('click', () => {
        s.session = structuredClone(defaultSettings.session);
        saveSettingsDebounced(); updateDashboard();
    });
    btnRow.appendChild(resetAll);
    btnRow.appendChild(resetSession);
    wrap.appendChild(btnRow);

    // ============ v1.1.0 新增配置：预算监控 ============
    const budgetHead = document.createElement('div');
    budgetHead.className = 'tf-writing-title';
    budgetHead.textContent = '💰 ' + safeT('预算监控');
    wrap.appendChild(budgetHead);

    const mkCheck2 = (key, label) => {
        const lab = document.createElement('label');
        lab.className = 'checkbox_label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!(s[key]);
        cb.addEventListener('change', () => {
            s[key] = cb.checked; saveSettingsDebounced(); updateDashboard();
        });
        lab.append(cb);
        lab.append(document.createTextNode(safeT(label)));
        return lab;
    };

    // 预算开关（嵌套路径 s.budget.enabled）
    const budgetLab = document.createElement('label');
    budgetLab.className = 'checkbox_label';
    const budgetCb = document.createElement('input');
    budgetCb.type = 'checkbox';
    budgetCb.checked = !!(s.budget && s.budget.enabled);
    budgetCb.addEventListener('change', () => {
        s.budget.enabled = budgetCb.checked; saveSettingsDebounced();
        if (!budgetCb.checked) clearOrbAlert();
        updateDashboard();
    });
    budgetLab.append(budgetCb);
    budgetLab.append(document.createTextNode(safeT('启用预算预警')));
    row(span(safeT('预算开关')), budgetLab);
    row(span(safeT('今日限额 ($/1M)')),
        makeInput('tf_budget_daily', 'number', s.budget && s.budget.dailyLimit, () => {
            const v = parseFloat(document.getElementById('tf_budget_daily').value);
            s.budget.dailyLimit = isNaN(v) ? 0 : v; saveSettingsDebounced(); updateDashboard();
        }));
    row(span(safeT('月度限额 ($/1M)')),
        makeInput('tf_budget_monthly', 'number', s.budget && s.budget.monthlyLimit, () => {
            const v = parseFloat(document.getElementById('tf_budget_monthly').value);
            s.budget.monthlyLimit = isNaN(v) ? 0 : v; saveSettingsDebounced(); updateDashboard();
        }));

    // ============ v1.1.0 新增配置：上下文监控 ============
    const ctxHead = document.createElement('div');
    ctxHead.className = 'tf-writing-title';
    ctxHead.textContent = '🧠 ' + safeT('上下文监控');
    wrap.appendChild(ctxHead);
    row(span(safeT('上下文窗口 (tokens)')),
        makeInput('tf_ctx_size', 'number', s.contextSize, () => {
            const v = parseInt(document.getElementById('tf_ctx_size').value);
            if (v > 0) { s.contextSize = v; saveSettingsDebounced(); updateDashboard(); }
        }));

    // ============ v1.1.0 新增功能：历史归档配置 + 导出/导入 ============
    const histHead = document.createElement('div');
    histHead.className = 'tf-writing-title';
    histHead.textContent = '🗂 ' + safeT('历史归档');
    wrap.appendChild(histHead);

    const autoArch = mkCheck2('autoArchive', '自动按日归档');
    row(span(safeT('自动归档')), autoArch);
    row(span(safeT('保留天数')),
        makeInput('tf_archive_days', 'number', s.archiveDays, () => {
            const v = parseInt(document.getElementById('tf_archive_days').value);
            if (v > 0) { s.archiveDays = v; saveSettingsDebounced(); }
        }));

    const ioRow = document.createElement('div');
    ioRow.className = 'tf-btn-row';

    const exportBtn = document.createElement('button');
    exportBtn.textContent = safeT('导出数据');
    exportBtn.className = 'menu_button';
    exportBtn.addEventListener('click', () => {
        const payload = { version: 1, exportedAt: Date.now(), settings: s };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'tokenflow_backup.json'; a.click();
        URL.revokeObjectURL(url);
    });
    ioRow.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.textContent = safeT('导入数据');
    importBtn.className = 'menu_button';
    importBtn.addEventListener('click', () => {
        const fi = document.createElement('input');
        fi.type = 'file'; fi.accept = '.json';
        fi.addEventListener('change', () => {
            const file = fi.files && fi.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(reader.result);
                    if (parsed && parsed.settings) {
                        Object.assign(extension_settings[MODULE], parsed.settings);
                        saveSettingsDebounced(); updateDashboard();
                        alert(safeT('导入成功'));
                    } else {
                        alert(safeT('导入失败：格式不合法'));
                    }
                } catch (e) { alert(safeT('导入失败') + ': ' + e.message); }
            };
            reader.readAsText(file);
        });
        fi.click();
    });
    ioRow.appendChild(importBtn);
    wrap.appendChild(ioRow);

    content.appendChild(wrap);
}

function initialize() {
    if (globalThis.__tokenFlowLoaded) return;
    globalThis.__tokenFlowLoaded = true;

    console.log('[TokenFlow] initialize() called, readyState:', document.readyState);

    try {
        const settings = getSettings();
        console.log('[TokenFlow] settings loaded:', { enabled: settings.enabled, trackExact: settings.trackExact });

        // 注入设置面板（带重试，等待扩展设置容器出现）
        let retryCount = 0;
        let injectTimer = null;
        const tryInject = () => {
            if (installSettingsEntry()) return;
            retryCount++;
            if (retryCount > 30) {
                console.error('[TokenFlow] settings container not found after 30 retries, giving up');
                return;
            }
            console.log('[TokenFlow] retrying injection...', retryCount);
            injectTimer = setTimeout(tryInject, 300);
        };
        tryInject();

        // 挂载悬浮球 + 统计弹层（body 顶层，独立于设置面板）
        if (settings.showOrb !== false) {
            ensureFloatingUI();
        }

        // MutationObserver 兜底：即使重试窗口错过容器出现，这里也能捕获
        let mo = null;
        if (window.MutationObserver) {
            mo = new MutationObserver(() => {
                if (!document.getElementById('token_flow_drawer')) installSettingsEntry();
                if (!document.getElementById('token_flow_orb') && getSettings().showOrb !== false) ensureFloatingUI();
            });
            // 观察 body，等待 settings 容器被构建后注入
            mo.observe(document.body, { childList: true, subtree: true });
        }

        // 安装 fetch 拦截器（捕获真实 API usage）
        if (settings.trackExact) installFetchInterceptor();

        // 事件绑定：优先通过 SILVYTAVERN 全局上下文获取（world-backstage 验证过的模式），
        // 失败则回退到静态 import 的事件源。
        const context = getContext();
        const source = context?.eventSource || eventSource;
        const events = context?.eventTypes || context?.event_types || event_types;

        const on = (ev, handler) => {
            try {
                const tgt = events[ev];
                if (source && tgt) source.on(tgt, handler);
                else console.warn('[TokenFlow] missing event binding for', ev);
            } catch (e) { console.warn('[TokenFlow] event bind error:', e); }
        };

        // 聊天切换时重新尝试注入设置面板（有时 settings 容器是切换后才挂载的）
        on('CHAT_CHANGED', () => {
            if (!document.getElementById('token_flow_drawer')) tryInject();
            safeUpdateUI();
        });
        on('GENERATION_ENDED', safeUpdateUI);
        on('MESSAGE_RECEIVED', safeUpdateUI);

        console.log('[TokenFlow] initialized successfully');
    } catch (e) {
        console.error('[TokenFlow] init error:', e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}