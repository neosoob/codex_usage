# Codex Usage Checker

一个 Chrome / Edge 扩展，用来固定读取 `https://chatgpt.com/codex/settings/usage` 的 Codex 余额，并在聊天页右下角显示缩略信息。

## 当前实现

- 不再依赖当前页面文本，而是始终请求 `https://chatgpt.com/codex/settings/usage`
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

这个版本依旧是解析 usage 页面 HTML 文本，不是调用官方公开 API。只要 usage 页面文案还是：

- `5 小时使用限额`
- `每周使用限额`
- `重置时间：...`

就能工作。后面如果页面结构或文案变化，需要同步更新解析规则。
