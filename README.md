# B站评论收藏夹 · Bilibili Comment Collector

给 B 站评论区加一个「☆ 收藏」按钮：**一条神评，点一下就存下来**，之后能搜、能打标签、能跳回原楼层，还能导出成 Markdown / JSON / CSV。

不登录、不联网、不调 B 站接口 —— 只读页面已经渲染出来的评论，数据全部存在浏览器本地。

![许可证](https://img.shields.io/badge/license-MIT-blue)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-4c8fbd)
![Chrome 111+](https://img.shields.io/badge/Chrome-111%2B-yellow)

![评论区效果](docs/screenshot-comments.png)

![收藏夹页面](docs/screenshot-manager.png)

## 为什么做这个

B 站自带的「收藏」只能收藏视频，看到一条好评论，只能截图或者复制到记事本 —— 复制完就不知道它出自哪个视频、哪一层楼了。

现有的方案要么是整页批量抓评论导出 CSV（那是数据采集，不是日常收藏），要么带云端 AI 分析、要把评论内容上传走。这个扩展只做一件事：**把你在页面上看到的这条评论，连同它的出身（视频、作者、楼层）一起留在本地。**

## 功能

- **一键收藏评论，含楼中楼**：评论操作栏末尾多一个「☆ 收藏」，点击即存；已收藏显示「★ 已收藏」
- **跳回原楼层**：用 B 站自己的深链格式，打开后自动滚到那条评论并描边高亮
- **搜索**：正文 / 作者 / 备注 / 视频标题全文匹配，支持 `tag:标签`、`#标签` 过滤
- **标签与备注**：给收藏分类、写自己的批注，备注停手自动保存
- **导出 / 导入**：Markdown（按视频分组、引用块正文）、JSON（可再导入）、CSV（带 BOM，Excel 直接开）
- **全部本地**：只申请 `storage` 与 `unlimitedStorage`，没有 `tabs`、没有 `cookies`、没有任何网络请求

## 安装

### 方式一：下载发布包（推荐）

1. 到 [Releases](../../releases) 下载最新的 `bilibili-comment-collector-x.y.z.zip`
2. 解压到任意固定目录（**不要放在临时目录，删了就没了**）
3. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开右上角**开发者模式**
4. 点**加载已解压的扩展程序**，选择解压出来的文件夹
5. 打开任意 B 站视频页，鼠标移到评论上，操作栏末尾点「☆ 收藏」

> 需要 Chrome / Edge 111 或更高版本（用到 `world: "MAIN"` 的 content script）。
> 首次安装后如果评论按钮没出现，刷新一下页面。

### 方式二：克隆源码

```bash
git clone https://github.com/wudidadaqiuqiu/bilibili-comment-collector.git
```

然后在 `chrome://extensions` 里「加载已解压的扩展程序」选择仓库根目录（`manifest.json` 就在根目录）。

## 用法

| 位置 | 作用 |
|---|---|
| 评论操作栏 | 点 **☆ 收藏** 存下这条评论；已收藏的显示 **★ 已收藏** |
| 评论区标题旁 | 点 **★ 我的评论收藏** 打开收藏夹 |
| 工具栏图标 | 看条数、最近 6 条，点一条直接跳回原楼层 |
| 收藏夹页面 | 搜索、标签、备注、跳转、复制、删除、导出 / 导入 |

**搜索语法**：默认全文匹配，多个词用空格分隔（AND 关系）。`tag:神评` 或 `#神评` 按标签过滤。

**导出**：右上角「导出 ▾」，导出的就是*当前筛选结果*（所见即所得）。

## 数据在哪、怎么备份

- 位置：`chrome.storage.local`，键名 `bshc:items:v1`
- **卸载扩展会连同数据一起删除**，重要的收藏请定期「导出 JSON」；换电脑用「导入」还原
- 想清空重来：`chrome://extensions` 移除扩展，或逐条删除

隐私：扩展不读取账号信息，不发起任何网络请求，不做任何上报。

## 它是怎么工作的

B 站现在的评论区是 Web Component + Shadow DOM，不是普通 HTML：

```
bili-comments                     ← document.querySelector('bili-comments')
└── #shadow-root
    ├── div#header > bili-comments-header-renderer
    └── div#contents > div#feed
        └── bili-comment-thread-renderer        ← 每个一级评论线程
            └── #shadow-root
                ├── bili-comment-renderer       ← 主评论，.data 是原始评论对象
                │   └── #shadow-root
                │       └── div#body > div#content
                │           ├── bili-rich-text        （正文）
                │           └── bili-comment-action-buttons-renderer
                │               └── #shadow-root > #pubdate #like #dislike #reply #more
                └── bili-comment-replies-renderer   ← 楼中楼容器
                    └── #shadow-root > bili-comment-reply-renderer（同样有 .data）
```

两个关键点：

**1. 为什么是两个 content script**（`src/content/bridge.js` + `src/content/content.js`）

`bili-comment-renderer.data` 是页面 JS 上下文里的对象属性，普通 content script 跑在隔离世界，读不到。所以：

- `bridge.js` 声明 `"world": "MAIN"`，与页面共享 JS 上下文，负责读 `.data`；它把需要的一小撮字段（rpid / oid / root / parent / ctime / like / 正文 / 作者）序列化后写到元素的 `data-bshc` 属性上 —— **attribute 是两个世界共享的**
- `content.js` 在隔离世界，读 `data-bshc`、注入按钮、和 background 通信

这样隔离世界始终有 `chrome.runtime` 可用，又不需要用 `postMessage` 传递 DOM 引用。

**2. 跳到指定楼层**

B 站前端代码里有 `var Fm = /^#reply(\d+)$/`：hash 命中时把 rpid 作为 `seekId` 传给评论组件，并关闭懒加载。这就是官方「复制评论链接」背后的机制，扩展直接复用，不用自己翻页查找。

**样式**：按钮注入在 shadow root 里，页面 CSS 进不来。用 `CSSStyleSheet` + `adoptedStyleSheets` 把一份样式表挂到所有相关 shadow root（不可用时退回 `<style>` 标签）。

**并发**：所有写操作都经过 background 的串行队列，多标签页同时收藏不会互相覆盖。

## 目录结构

```
bilibili-comment-collector/
├── manifest.json
├── src/
│   ├── background.js          Service Worker：唯一写入方、串行队列、角标
│   ├── shared/model.js        数据规范化、搜索、导出（纯函数）
│   ├── content/
│   │   ├── bridge.js          MAIN world：把 .data 写成 data-bshc
│   │   ├── content.js         隔离世界：注入按钮、收藏、深链高亮
│   │   └── content.css        页面级 toast 样式
│   ├── popup/                 工具栏弹窗
│   ├── manager/               收藏夹页面
│   └── icons/
├── scripts/check.mjs          自检：manifest、文件引用、JS 语法、图标尺寸
└── .github/workflows/         check（推送/PR）+ release（打 tag 自动发版）
```

## 开发

```bash
npm run check     # 等价于 CI 跑的自检，无需安装依赖
```

改完代码在 `chrome://extensions` 点该扩展的刷新按钮即可，**然后在已打开的 B 站页面刷新一次**（content script 不会热更新）。

发布：

```bash
# 1. 先改 manifest.json 和 package.json 的版本号并提交
# 2. 打 tag 推送，Release 由 workflow 自动创建并附上 zip
git tag v1.1.0 && git push origin v1.1.0
```

## 已知边界

- **只收藏页面已经渲染出来的评论**。不调接口、不自动翻页，所以「共 2241 条回复」里没展开的部分收藏不到；楼中楼默认展开的前 2 条可以直接收藏，展开更多后也能收
- 极少数页面（如部分专题页）评论组件结构不同，按钮不会出现
- 页面结构若大改导致按钮消失，改这两个函数即可：`src/content/bridge.js` 的 `collect()`、`src/content/content.js` 的 `collect()`
- 收藏时记下的是那一刻的点赞数，之后不会更新

## 排错

页面控制台执行：

```js
__BSHC_DUMP__()   // 桥接层当前抓到的评论数组
```

- 返回数组但没有按钮 → `content.js` 没跑起来，检查扩展是否启用、页面是否已刷新
- `__BSHC_DUMP__ is not defined` → `bridge.js` 没注入，确认 Chrome ≥ 111
- 点收藏提示「后台没有响应」→ Service Worker 被回收或扩展刚更新，刷新页面
- 收藏夹页面空白 → 打开 `chrome://extensions` 看该扩展有无红色报错

## 免责声明

本项目与哔哩哔哩（bilibili）官方无关，是个人使用的第三方工具。仅用于保存你自己看到的公开评论，请遵守 B 站用户协议，不要用于批量抓取或商业用途。

## License

[MIT](LICENSE)
