# Codex Usage Checker

一个 Chrome / Edge 扩展，用来在当前登录态下读取 `https://chatgpt.com/codex/settings/usage` 的 Codex 余额，并在聊天页右下角显示缩略信息。

## 当前实现

- 不再依赖当前页面文本
- 不再直接 `fetch` usage 页原始 HTML
- 改为在 `chatgpt.com` 同源下静默加载一个隐藏 `iframe`
- 直接读取 usage 页前端渲染完成后的真实 DOM
- 解析两组额度：
  - `5 小时使用限额`
  - `每周使用限额`
- 在聊天页右下角注入悬浮卡片：
  - 默认显示缩略信息
  - 鼠标移上去展开详细信息和重置时间
- 点击扩展图标时，弹窗也会读取同一份数据

## 安装

1. 打开浏览器扩展管理页
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择当前目录：`C:\Users\neoso\VSCodeProjects\codex_usage`

## 使用

1. 保持已登录 `chatgpt.com`
2. 打开任意 `chatgpt.com` 聊天页面
3. 右下角会出现 Codex 余额缩略卡片
4. 鼠标移上去可查看 5 小时和每周限额详情
5. 点击扩展图标可手动刷新

## 注意

这个版本依赖 usage 页在 iframe 里完成前端渲染。如果 OpenAI 后续对该页加了 `X-Frame-Options` 或更严格的 CSP，需要再改成后台标签页抓取方案。
