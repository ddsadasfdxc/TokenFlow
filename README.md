# TokenFlow · SillyTavern 用量统计扩展

精准统计 SillyTavern（酒馆）的 **Token 用量、请求次数与多币种费用**。

## ✨ 功能

- 🔍 **真实 API 用量捕获** — Monkey-patch `window.fetch`，拦截 `/api/backends/chat-completions/generate`，从响应中提取真实 `usage` 数据
- 🌀 **SSE 流式兼容** — 自动解析流式响应，抓取 `[DONE]` 前的最终 usage chunk
- 💰 **多维度计费** — 输入 / 输出 / 缓存三档单价 + 按次计费，自定义汇率换算任意显示币种
- 📊 **双桶统计** — 累计 + 会话双视角，按模型分组明细
- 🎨 **美观 UI** — 玻璃拟态卡片、渐变数字、自动适配酒馆深浅主题
- 🌐 **国际化** — 简体中文 / 繁体中文 / English

## 📦 安装

1. 打开 SillyTavern → **扩展** → **安装扩展**
2. 粘贴 Git 仓库地址：

```
https://github.com/ddsadasfdxc/TokenFlow
```

3. 点击安装，重启 SillyTavern

## 🔧 使用

安装后在 **扩展设置区** 找到 **TokenFlow** 折叠面板：

- 开启/关闭统计、真实 API 捕获、本地估算兜底
- 设置显示币种与汇率
- 编辑各模型价格（输入 $/1M、输出 $/1M、缓存 $/1M、按次 $）
- 查看累计费用 / Token / 请求次数，及按模型明细

数据自动持久化（`saveSettingsDebounced`），更换浏览器不丢失。

## 🧮 内置模型价格库

gpt-4o / gpt-4o-mini / gpt-5 / claude-opus-4.6 / claude-sonnet-4.6 / gemini-3.1-pro / deepseek-chat / deepseek-reasoner / kimi-k2.6 / qwen3.5-plus / mimo-v2.5-pro

## 📄 License

AGPL-3.0