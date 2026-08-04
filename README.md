# 暑期学习管理

家庭版英语词汇学习工具，面向小学到初中阶段的词汇复习。项目是纯前端静态应用，不依赖后端、数据库或构建工具。

> 注意：应用使用 `fetch()` 加载 `data/*.json` 和 `downloads/files.json`，请通过本地 HTTP 服务访问，不建议直接用 `file://` 打开 `index.html`。

## 当前功能

### 英语词库导航

- 左侧按英语词库分组展示：小学词汇、七年级上/下册、八年级上/下册、九年级上/下册、中考 3500 词
- 分组首次展开时按需加载对应 JSON 文件
- 点击分类后，右侧词卡、标题、描述和操作按钮联动刷新
- 数学、语文数据在 `manifest.json` 中保留为预留内容，但当前界面只开放英语

### 词卡学习

- 词卡展示英文、中文释义、音标和学习进度
- 点击词卡喇叭按钮播放英文发音
- 支持自动跟读当前分类的全部单词
- 点击词卡主体可打开单词详情弹窗
- 七年级上册部分词条包含记忆方法、搭配、派生词、例句、注意点、同反义词等详情数据

### 默写挑战

- 当前分类可进入“单词拼写闯关”
- 根据中文提示和发音，从打乱的字母中拼出英文
- 支持单词、短语以及带空格/标点的表达
- 自动记录正确率、得分、连续答对次数和星级评价
- 基础轮答错的词会出现在完成页，可点击“重新挑战错词”进行强化练习

### SRS 今日复习

- 使用本地 `localStorage` 保存每个单词的间隔复习状态
- 算法基于 SM-2：根据默写挑战答题结果更新复习间隔、难度系数和下次复习日期
- 顶部“今日复习”按钮显示当前已加载词库中的到期复习数量
- 当前入口只复习到期词，不主动加入新词

### 学习行为追踪

- 使用 `localStorage` 记录学习事件
- 当前记录包括发音播放、挑战开始、挑战答题、挑战完成、挑战中途退出等
- 词卡熟练度、播放次数、挑战次数、正确率和最近学习时间均基于事件日志计算

### 资料下载

- 顶部“资料下载”按钮打开下载弹窗
- 下载列表来自 `downloads/files.json`
- 当前包含小学词汇汇总、英译中/中译英练习、初一英语单词默写等 PDF

## 词库规模

当前 `data/manifest.json` 配置的英语词库如下：

| 分组 | 分类数 | 词条数 |
|------|--------|--------|
| 小学词汇 | 17 | 582 |
| 七年级上册词汇 | 8 | 415 |
| 七年级下册词汇 | 8 | 459 |
| 八年级上册词汇 | 8 | 455 |
| 八年级下册词汇 | 8 | 382 |
| 九年级上册词汇 | 8 | 437 |
| 九年级下册词汇 | 4 | 185 |
| 中考 3500 词 | 24 | 493 |

另有 `data/word_details_7a.json`，包含 398 个七年级上册词条的详情数据。

## 项目结构

```text
learning-app/
├── index.html                    # 页面入口
├── css/
│   └── style.css                 # 页面样式、响应式布局、弹窗和动画
├── js/
│   ├── app.js                    # 主应用逻辑：导航、词卡、挑战、下载、详情弹窗
│   ├── vocab-data.js             # DataStore：manifest 和词库 JSON 按需加载
│   ├── srs.js                    # SRS 间隔重复系统
│   └── tracker.js                # 本地学习事件追踪
├── data/
│   ├── manifest.json             # 词库分组配置
│   ├── primary_vocabulary.json
│   ├── junior_vocabulary7A.json
│   ├── junior_vocabulary7B.json
│   ├── junior_vocabulary8A.json
│   ├── junior_vocabulary8B.json
│   ├── junior_vocabulary9A.json
│   ├── junior_vocabulary9B.json
│   ├── junior_3500_7days.json
│   └── word_details_7a.json
├── downloads/
│   ├── files.json                # 下载资料清单
│   └── *.pdf
└── test/
    └── challenge-review.test.js  # Playwright 自动化测试脚本
```

## 运行方式

在项目根目录启动静态 HTTP 服务：

```bash
cd "/mnt/d/claude code/learning-app"
python3 -m http.server 8080
```

然后访问：

```text
http://localhost:8080
```

如果使用 Node 生态，也可以用任意静态服务器，例如：

```bash
npx http-server . -p 8080
```

## 数据结构

菜单结构由 `data/manifest.json` 定义：

```text
subjects
└── english
    └── groups
        ├── primary
        ├── junior
        ├── junior7B
        ├── junior8
        ├── junior8B
        ├── junior9A
        ├── junior9B
        └── junior_3500_7days
```

每个英语分组通过 `dataFile` 指向独立词库文件。词库文件内部仍保持：

```text
subjects → groups → categories → words[]
```

单词基础字段：

```json
{
  "en": "apple",
  "cn": "苹果",
  "phonetic": "/ˈæpəl/",
  "grade": "primary"
}
```

## 本地存储

应用会使用以下 `localStorage` 键：

| 键名 | 用途 |
|------|------|
| `learning_events` | Tracker 学习事件日志 |
| `tracker_device_id` | 本机设备标识 |
| `srs_states` | SRS 单词复习状态 |

清空浏览器站点数据会重置学习记录和复习进度。

## 测试

仓库包含一个 Playwright 测试脚本，但当前没有 `package.json` 固化测试依赖。

首次运行需要自行安装依赖并启动静态服务器：

```bash
npm install playwright
npx http-server . -p 8765 -s
node test/challenge-review.test.js
```

注意：当前测试脚本期望“基础轮结束后自动进入错词重练”，而应用实现是完成页点击“重新挑战错词”后进入重练。测试脚本需要按实际产品逻辑同步调整后再作为回归测试使用。

## 技术栈

| 技术 | 用途 |
|------|------|
| HTML5 | 页面结构 |
| CSS3 | 响应式布局、词卡、弹窗、动画 |
| JavaScript ES6+ | 应用状态、DOM 渲染、事件处理 |
| Web Speech API | 英文发音 |
| localStorage | 学习记录和 SRS 进度持久化 |
| JSON | 词库、详情、下载清单 |

## 后续可优化点

- 补充 `package.json`，固定本地服务器和测试命令
- 对齐并修复 Playwright 测试脚本
- 明确 SRS 今日复习范围：仅已加载词库，或启动前自动加载全部英语词库
- 清理生产环境中的调试 `console.log`
- 如果要开放数学/语文，需要把侧边栏从英语硬编码改为按 `subjects` 动态渲染

## 许可

个人学习使用。
