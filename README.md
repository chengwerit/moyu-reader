<div align="center">

# 墨语 · Moyu Reader

**双击即用的本地电子书阅读器。数据存在你自己的文件夹里。**

零注册 · 零安装 · 零上传 · 断网可用

[快速开始](#快速开始) · [支持格式](#支持格式) · [功能](#功能) · [架构](#架构) · [常见问题](#常见问题)

</div>

---

## 这是什么

一个把书拖进窗口就能读的电子书阅读器。

- **双击 `启动墨语.bat` 就能用** —— 不需要装 Node、Python 或任何软件，用的是 Windows 自带的 PowerShell
- **数据存在 `data/` 目录** —— 复制整个文件夹到另一台电脑继续用，清浏览器缓存不影响
- **完全离线** —— 第三方库已打包进 `lib/`，断网也能解析 EPUB、PDF、DOCX、Markdown 等格式
- **不上传任何数据** —— 没有账户、没有服务器、AI 功能是你自带 Key 直连

支持 EPUB、PDF、DOCX、TXT、Markdown、HTML、FB2、RTF、MOBI / AZW / AZW3 / PRC 共 11 类格式。

---

## 快速开始

### 使用者

1. 下载或克隆整个文件夹
2. 双击 **`启动墨语.bat`**
3. 浏览器自动打开，把书拖进去

黑窗口是本地服务器，用的时候别关，读完直接关掉即可。
端口从 8899 开始自动挑选，被占用会自动换，不用手动配置。

> 换电脑：把整个文件夹复制过去，双击启动器继续用。书、笔记、划线、书签、主题设置全都在。

### 开发者

<details>
<summary>点击展开</summary>

**技术栈**：原生 JavaScript（ES Module）+ PowerShell + HttpListener。无构建步骤，无打包器。

```
moyu-reader/
├── 启动墨语.bat          双击启动
├── server.ps1            本地服务器（静态服务 + 数据 API）
├── index.html            应用骨架
├── css/app.css           全部样式与主题变量
├── js/
│   ├── db.js             数据层（文件存储 / IndexedDB 双后端）
│   ├── parsers.js        格式解析 → 统一书稿模型
│   ├── engine.js         阅读引擎（分页、进度、划线、朗读）
│   ├── ai.js             AI 伴读客户端
│   └── app.js            界面逻辑
├── lib/                  第三方库（已本地化，断网可用）
├── sw.js                 Service Worker
└── data/                 你的数据（git 仓库中已排除）
```

**架构**：所有格式解析后统一成 `{ title, author, cover, chapters: [{ title, html, text }], toc }`，
阅读引擎只认这一种结构，新增格式不用改引擎。

**跑验证**：

```bash
# 启动服务器
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1

# 调试端口启动 Edge
msedge.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\moyu-edge http://127.0.0.1:8899/

# 跑测试
node verify.cjs           # 12 项功能检查
node verify-portable.cjs  # 18 项便携性与落盘检查
```

> 设了 `http_proxy` 的环境需先清掉，否则 Node 连不上 `127.0.0.1`：
> `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY node verify.cjs`

**开发踩坑记录**见 [开发笔记.md](开发笔记.md) —— 包含设计取舍、已修复的 bug
以及 Windows 编码相关的坑（对做同类项目的开发者可能有用）。

更完整的项目导览见 [项目说明.md](项目说明.md)，包含目录结构说明、
硬性约束与排查顺序。

**项目上下文**：`.workbuddy/` 下是给 AI 助手的项目记忆与验证技能，
用 WorkBuddy 打开本项目时会自动读取，能让 AI 更快建立正确认知。

**改造路径**：本项目初版是纯网页应用（数据在 IndexedDB）。
后改造成双击即用、数据存文件夹的便携版，见开发笔记中的「便携化改造」章节。

</details>

---

## 数据存在哪

就在**这个文件夹的 `data/` 目录**，用记事本就能打开：

```
data/
├── library.json      书架、笔记、书签、阅读设置
└── books/
    └── <id>.json     每本书的章节正文
```

换电脑复制整个文件夹即可。清理浏览器数据、重装系统、重装浏览器都不影响。

> 这是有意的设计取舍：**你的阅读记录属于你，不属于任何账户。**
> 代价是不跨设备自动同步 —— 但同步本来就需要你信任一个中心化服务器。

---

## 支持格式

| 格式 | 实现方式 | 说明 |
|---|---|---|
| EPUB | JSZip + OPF/spine | 解析元数据、封面、目录，图片内联 |
| PDF | PDF.js | 按坐标重建段落；无文本层时渲染为图片 |
| DOCX | JSZip + OOXML | 段落、标题层级、表格、内嵌图片 |
| TXT | 原生 TextDecoder | UTF-8 / GB18030 / Big5 / UTF-16 自动探测 + 中文章节切分 |
| Markdown | marked | 按 h1/h2 切分章节 |
| HTML / XHTML | DOMParser | 清除脚本与事件属性后按 h1/h2 切分 |
| FB2 | XML 解析 | 章节、强调、插图占位 |
| RTF | 控制字剥离 | 提取纯文本后按章节切分 |
| MOBI / AZW / AZW3 / PRC | PalmDOC 解压 | 无 DRM 版本可用 |

带 DRM 的文件无法解析，请使用无保护版本。

---

## 功能

**书架** — 搜索、置顶、已读/未读筛选、列表视图、删除、每日一句

**阅读** — 目录跳转、全文搜索、书签、划线笔记、5 套主题、宋/黑/楷三种字体、
字号与行距调节、单页/双页、Zen 沉浸模式、键盘与滚轮与触屏适配

**朗读** — 基于浏览器原生 `speechSynthesis`，逐句高亮并自动跟随滚动

**AI 伴读** — 自带 Key 模式，支持解释、总结、关键词、翻译、续写、章节纠错。
兼容任何 OpenAI 格式接口（内置 DeepSeek / OpenAI / 通义千问 / Kimi / 智谱 预设）。
请求从浏览器直连所填服务，不经中转，Key 只存本地。

**备份** — 完整 JSON 导出与恢复（含全部正文、笔记、书签、设置）

### 快捷键

| 按键 | 功能 |
|---|---|
| `←` `→` `空格` `PageUp/Down` | 翻页 |
| `T` / `F` / `N` / `A` | 目录 / 搜索 / 笔记 / AI 面板 |
| `Z` | 沉浸模式 |
| `Esc` | 关闭面板 |

---

## 架构

**统一书稿模型** —— 所有格式最终都转成
`{ title, author, cover, chapters: [{ title, html, text }], toc }`，
阅读引擎只认这一种结构，新增格式不用改引擎。

**双存储后端** —— `js/db.js` 对外接口完全一致，内部自动选择：

| 打开方式 | 存储位置 |
|---|---|
| 双击 `启动墨语.bat` | `data/` 目录（文件存储） |
| 直接双击 `index.html`（`file://`） | 浏览器 IndexedDB（兜底） |

启动时探测 `./api/ping`，探不到就退回 IndexedDB。上层代码无需区分。

**分页用 CSS 多栏** —— `.page-inner` 同时是排版容器和横向滚动容器，
滚动步长严格等于「栏宽 + 栏间距」。

**依赖本地化** —— 第三方库打包进 `lib/`，页面零外部引用，断网可用。

---

## 常见问题

**Q：双击 `index.html` 可以吗？**
可以，但数据会存进浏览器而不是文件夹。原因：ES 模块的同源策略决定了
纯 `file://` 无法加载模块脚本。请用 `启动墨语.bat`。

**Q：会泄露我的阅读记录吗？**
不会。数据只在你自己的机器上，不上传任何服务器，也没有账户体系。
唯一的对外请求是你自己配置的 AI 接口。

**Q：支持 Mac / Linux 吗？**
目前启动器是 Windows 的 `.bat`，服务端脚本是 PowerShell。
核心应用是纯前端，需要 Node 或 Python 起个静态服务也能用，
但数据会落到浏览器 IndexedDB 而非文件夹。

**Q：扫描版 PDF 能搜索吗？**
不能。没有文本层时只能作为图片显示，无法搜索或划线。

**Q：书特别多会怎样？**
`data/books/` 里每本书一个独立文件，上千本也能正常工作。
`library.json` 只存元数据，随书量增长会变大，上万本时建议改用数据库。

**Q：AI 功能要钱吗？**
要，但费用由你用的服务方收。本项目零中转、不加价、不经手你的 Key 和请求。

---

## 已知限制

- 不提供自动云同步 —— 换电脑靠复制文件夹
- 朗读音质取决于浏览器与系统语音引擎
- 极老的 `.doc` 二进制格式可能无法解析，建议另存为 `.docx`
- 扫描版 PDF 无文本层，只能看图
- MOBI / AZW3 的 KF8 压缩流只做了尽力解析，复杂文件可能失败

---

## 许可

本项目采用 [MIT 许可](LICENSE)。

`lib/` 目录内的第三方库版权归各自作者所有，详见 [lib/LICENSE.md](lib/LICENSE.md)：

- JSZip — MIT
- marked — MIT
- PDF.js — Apache License 2.0

「墨语」为本项目名称，与上述第三方项目无关联。