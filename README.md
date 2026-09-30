<p align="center">
  <img src="mascot.png" alt="MaaLow 吉祥物" width="240">
</p>

<h1 align="center">MaaLow</h1>

<p align="center">
  <b>MaaLow — Teachable Low-Code Automation on MaaFramework</b><br>
  基于 MaaFramework 的可教学低代码视觉自动化平台。
</p>

## 定位

MaaLow 让用户通过**自然语言指导 + 屏幕标注**快速创建游戏或应用自动化，不需要手工编写大量 Pipeline。

核心理念：

> **先教它怎么做，再让它自己做。**

## 核心结构

```text
MaaLow
├─ Workspace
├─ Teaching（实时指导 / 回放指导）
├─ Recorder（录像）
├─ Skills
├─ Memory
├─ AI Assistant
└─ MaaFramework
   ├─ OCR
   ├─ Template / Color / CV
   ├─ Pipeline
   └─ Click / Swipe / Key
```

## Workspace

每个游戏或应用都是独立 Workspace，保存自己的任务、模板、Pipeline、技能、教学记录和配置。

设备上同一时间只有一个“当前工作区”，实时指导、回放指导、录制、守护规则和不指定工作区的运行都用它。只有网页能切换和管理工作区：顶栏左侧切换；“工作区”页可以新建（从平板已安装的应用里选游戏）、重命名、复制（副本里的定时任务默认停用）、换游戏、导出 / 导入 zip、删除。删除的工作区进回收站（平板上的 `workspaces/.trash/`），保留 7 天。当前工作区不能删；正在录制或运行时不能切换、改名、删除。App 首页只显示当前工作区，网页切换后会跟着变。

## 运行形态

* MaaLow 以伴生 App 的形式运行在平板上，数据（工作区、截图、录像、标注）都存在平板本地。
* App 自带网页管理界面，由平板本机托管，电脑浏览器通过 tailscale 访问。网页不显示实时画面（用户直接看平板屏幕），图片和视频都按需拉取。
* 网页有四页：概览（设备、守护规则、定时任务、最近运行、保活检查）、实时指导、回放指导、工作区；浅色 / 深色跟随系统，也可以在右上角切换。
* 守护规则在游戏前台、没有任务运行时巡检，只放随时可能冒出来的画面；流程里才出现的弹窗用流程节点的 `[JumpBack]`。网页上逐条启用 / 停用（总开关之外）、拖动排序（按顺序，命中一条就执行）、设各自的巡检频率（不设就用全局 `guard_interval_ms`）、移出；只能从候选里添加：节点 JSON 写 `"guard_candidate": true` 才是候选。停用、顺序和频率记在 `workspace.json` 的 `extra.guards_off`、`extra.guards_order`、`extra.guard_intervals`，只有 `guards` 里的会被巡检。概览页的“规则文件 / 模板 / 技能”可以点开浏览：节点说明和 JSON、模板缩略图和用到它的节点、技能说明和源码。
* App 首页列出网页链接（局域网、Tailscale 等），每个都能复制、显示二维码、系统分享；Token 可以单独复制，也可以重置（旧链接和 PC 端配置立即失效）。
* 图标和配色来自吉祥物 `mascot.png`，改了图之后用 `uv run python android/scripts/gen_icons.py` 重新生成 App 图标和网页 logo。
* 热更新：Pipeline 规则、模板图、ONNX 模型、Skill 脚本更新都不需要重装 App。

## Teaching Mode

教导分两种：

| | 实时指导 | 回放指导 |
|---|---|---|
| 适合 | 普通 UI：点哪里、弹窗、签到、菜单流程 | 实时复杂行为：战斗、闪避、Boss 机制 |
| 画面 | 当前这一帧截图 | 事先录好的一段录像 |
| 节奏 | 教一步，AI 做一步并回复，再教下一步 | 先录下真实操作，事后逐帧看、逐帧标 |
| 产出 | Pipeline 节点、模板 | 战斗 Skill、识别规则，以后还有 YOLO 数据集 |

实时指导靠“停下来说清楚”，但战斗里的关键往往只持续几帧：红光亮起到必须闪避只有几百毫秒，边打边教不现实。回放指导把“发生了什么”和“讲清楚”分开：先录，再回头看。

两种指导共用同一套屏幕标注（点击点、框、圈、箭头、区域，加文字说明），网页里可以切换。

### 实时指导

要标注时，网页先请求一张截图（平板本机缩到 1080×720），在截图上标注、写指令、发送；AI 收到后执行，再回复。AI 回复之前不能再发下一条。

一个任务就是教的一件事（如“每日签到”），步骤和对话存在 `teaching/<任务>.json`、`<任务>.chat.jsonl` 和 `<任务>/` 截图目录。

`explore` 是草稿：App 启动后、结束任务后都回到这里，随便试、随便问。草稿里试出了想要的东西，就“另存为任务”（对话、步骤、截图整个改名过去，草稿变回空白）；不要了就“清空草稿”。

网页顶部可以“新任务”、从下拉框切回已有任务接着教、“结束任务”（保存并回到草稿）、“删除任务”；AI 也可以用 `maalow do task <名字>` 切换。每次切换都会在两边的对话里留一条分隔线，网页上的操作也会通过 listen 告诉 AI。结束任务不会自动生成 Pipeline，需要时在对话里让 AI 生成。对话只显示最近 200 条，更早的点“加载更早的消息”。

用户主要通过自然语言指导，例如：

“点击领取。”

“这个页面出现后先关闭弹窗。”

“跟着队友走，结束后找宝箱。”

必要时可以直接在截图上：

* 矩形框选
* 圆圈标记
* 箭头指向
* 点击目标
* 标记区域

MaaLow 将：

```text
当前画面
+ 用户语言
+ 视觉标注
+ 执行动作
+ 执行结果
```

转换成可重复执行的 MaaFramework 规则。

### 回放指导

用来做战斗等实时 Skill。网页上点“开始录制”“结束录制”，录下用户在平板上的真实操作（单段 3 分钟以内）。

```text
开始录制 → 在平板上正常玩 → 结束录制
↓
拖动进度条粗定位（显示低清缩略图）
↓
上一帧 / 下一帧精确定位，停在预警出现、出手、闪避的那一帧
↓
在帧上标注：点了哪里、看到了什么、为什么
↓
AI 读取标注和对应的帧，写出 Skill / 识别规则
```

* **不录触摸事件**，也不开系统的“显示点按操作反馈”：点击位置全部由用户在帧上手动标注
* **固定帧率**录像（30 fps），标注以**帧号**为准；精确的帧由 App 按帧号解码后返回图片，不依赖浏览器 video 标签的 seek
* **回放界面**：
  * 视频画面下方一条与画面等宽的长进度条，拖动粗定位，拖动时显示预生成的低清缩略图
  * “上一帧 / 下一帧”按钮和快捷键精确定位，当前帧号和时间始终可见
  * 在帧上标注：点击点、框、圈、箭头、区域，加文字说明
* 录像和标注存在工作区 `recordings/<id>/`，框统一用 1080×720 坐标
* **给 AI**：`maalow rec` 列出录像、按帧号取帧（带坐标网格）、输出标注摘要

实现要点：

* **录制**：特权进程再开一路屏幕镜像，送进 App 里的 SurfaceTexture；App 的 GL 线程按固定 30 fps 时钟把最新画面画进 H.264 硬件编码器的输入 Surface，时间戳就是 `帧号 / 30`。镜像只在画面变化时出帧，时钟不管有没有新画面都照常出帧；线程晚了就把错过的帧补成重复帧，所以帧数始终等于录制时长 × 30。识别用的截图通路不动，录制不占设备锁，守护规则和 Skill 照常运行。码率默认 3 Mbps，可在 `PUT /api/v1/settings {"record_bitrate"}` 或开始录制时指定。
* **不怕被杀**：录制中编码输出直接写进 `recordings/<id>/` 下的隐藏文件（裸 H.264 + 帧索引），结束时再封装成 `video.mp4`；App 被杀、重装或引擎重启后，下次启动会自动把没封装完的录像修复出来（`stopped_by: "recovered"`）。
* **取帧**：`GET /api/v1/recordings/{ws}/{id}/frame?n=N&fmt=jpg|png&q=90`，App 用 MediaExtractor + 硬件解码器从 N 之前的关键帧解到第 N 帧（关键帧间隔 1 秒）。解码器状态常驻：向后走接着解；向前走时把整个 GOP 缓存下来；每走一步还会顺着方向预取、预编码下一帧。
* **缩略图**：录制时每 5 帧顺手画一张 192×128 的小图，100 张拼成一张 `thumbs/NNN.jpg`，布局写在 `meta.json` 的 `thumbs` 里。
* **标注**：`recordings/<id>/labels.json`，按帧号组织：`{"version", "frames": {"帧号": {"rev", "time_ms", "note", "annotations": [{"kind", "coords", "label"}]}}}`，形状格式和实时指导相同，坐标 1080×720（框是 `[x, y, w, h]`）。网页按帧增量保存（`PUT .../labels/{n}`，带 `rev`）；两个页面改了同一帧时，后保存的一方会收到 409，由用户选覆盖还是载入对方的。
* `maalow sync` 默认不同步录像视频和缩略图（`--videos` 带上），`meta.json` 和 `labels.json` 照常同步。

先人工逐帧标注。等标注攒够了，再做 YOLO 导出、训练和模型接入，用来识别通用的预警信号（红光、金光、蓄力、锁定、Boss 血条），不按具体敌人一个个做。

## 自动运行

```text
截图
↓
Maa Recognition
↓
匹配已知状态
↓
执行动作
↓
验证结果
↓
下一状态
```

已经学会的任务优先完全本地运行。

## AI 协作

AI 主要作为**自动化工程师**，用于：

* 理解自然语言教学
* 理解视觉标注
* 总结稳定规则
* 生成或修改 Maa Pipeline
* 分析失败原因
* 协助处理未知状态

优先级：

```text
已有规则
→ 本地视觉识别
→ AI
→ 人
```

## Skills

可复用高级能力例如：

```text
ClosePopup
ClickText
ScrollList
WaitLoading
Interact
FollowParty
Fight
SearchChest
```

普通 UI 用 Pipeline，实时复杂行为用 Skill / Custom Action。

Skill 是工作区里的 `skills/<name>.js`（ES 模块），在伴生 App 里由 QuickJS 执行，API 见 `skills/maalow.d.ts`（`maalow sync` 时从 App 取下来）：

```js
export const meta = { description: "关弹窗", timeout: 30_000 };

export default function (args, ctx) {
  const hit = recognize("CloseShopPopup", { image: screenshot() });
  if (hit.hit) click(hit);
  return { closed: hit.hit };
}
```

* 运行：`maalow do skill <name> --args '{...}'`、定时任务的 `"skill"` 字段，或 Pipeline 节点 `"action": "Custom", "custom_action": "<name>"`（识别用 `"custom_recognition": "<name>.recognize"`）
* 改完 `maalow sync` 即生效，不用重装 App；报错带文件名和行号
* 检查：`npx -p typescript tsc -p workspaces/<ws>/skills`
* 区域定位 `locate()`：屏幕上的一块区域在一张参考图里的位置，见下一节

### 区域定位 locate()

把屏幕上截下的一块区域放进一张同比例的参考图里找位置：两边做同样的预处理，再做带掩膜的归一化互相关（ZNCC），先隔点粗搜、再在最好的附近细搜。App 原生实现（`android/app/src/main/cpp/locate_core.cpp`，不依赖 OpenCV），110×110 的区域在 ±30 单位里找一次约 10 ms。典型用法是把游戏的小地图放进整张地图里，每帧知道人在哪，不用开大地图（燕云见 [`workspaces/WhereWindsMeet/README.md`](workspaces/WhereWindsMeet/README.md)）。

```js
const r = locate("locate/cixin_mosaic", { image, prior: [x, y], radius: 30, wedge: cam });
if (r && r.score >= 0.4 && r.score - r.second >= 0.1) pos = [r.x, r.y]; // 可信
```

* 选项：`image`（默认最新截图）、`prior` + `radius`（只在先验位置附近搜；不给就搜整张图）、`wedge`（扇形遮罩的朝向，旧名 `cam`）、`zoom`（只试某一档），`crop` / `mask` / `regions` / `prep` 按键覆盖参考图里的设置
* 返回 `{x, y, score, second, zoom, used, ms, levels}`：`second` 是离最好位置 4 像素以外的最高分，`score` 比它高得多才说明没有歧义；一档都匹配不上返回 `null`
* 参考图是 `templates/<ref>.json` 加每档一张 PNG（alpha 标出参考图里哪些地方是已知的）。一个参考图可以有好几档（`levels`：比如小地图在某些地方会放大），每档都试，取分数最高的；每档有自己的换算：`位置 = (像素 - origin) × k + off`
* JSON 里还写着截哪块、丢掉哪些像素、怎么预处理，这些都随游戏而定：
  * `crop`：`center`（屏幕坐标）、`size`（正方形边长），要找的点是它的正中
  * `mask`：`circle`（只用内外半径之间的环）、`wedge`（按每次传入的朝向挖掉一个扇形，比如镜头视野）、`drop`（丢掉的 HSV 颜色范围，OpenCV 的 H 0–180，再向外扩 `grow` 像素）、`sat_max`（丢掉饱和度更高的像素，比如透出来的背景）
  * `regions`：某种颜色的半透明覆盖层（比如据点范围）。`flat` 是区内区外分开滤波，去掉色差，只丢掉边线；`mask` 是整块丢掉
  * `prep`：`kind` 取 raw / hp（减去模糊）/ dog（两次模糊相减，带通）/ grad / canny，加上 `pre` / `sigma`
* 参考图在 PC 上离线做，通用部分在 `scripts/map_locate.py`（预处理、定位、逐帧配准、拼图、评测、写参考图，要 `uv sync --extra cv`），各游戏的工具放在自己工作区的 `tools/` 下，配上自己的参数：
  1. 两种来源：地图截图按比例缩小，或者沿路线抓区域的连续帧拼成全图。后者和实时画面的画法一模一样，通常更准
  2. 抓帧：`uv run python scripts/grab_frames.py data/<ws>/survey1`，App 的实时帧（JPEG，约 8 帧/秒，带帧号）存到 PC 上；同时让技能在停稳的地方记锚点（已知位置、帧号）
  3. 用锚点加逐帧配准给每帧定位，拼图，导出参考图，再用留出的帧离线评测：每张图、每种预处理的误差、分数、第二高峰差距
  4. C++ 可以在 PC 上编成 DLL（`g++ -O2 -shared -static -std=c++20 -o data/build/locate.dll android/app/src/main/cpp/locate_core.cpp`），评测时用 `--native` 跑 App 的实现，和 OpenCV 版对拍
* `scripts/` 里的通用工具：`grab_frames.py`（抓 App 实时帧）、`map_locate.py`（上面的离线定位）

## 目标

把传统 Maa 自动化开发：

```text
截图
→ 配 ROI
→ 写识别规则
→ 写 Pipeline
→ 调试
```

变成：

```text
展示画面
→ 用自然语言告诉 MaaLow 怎么做
→ 必要时画框或箭头
→ MaaLow 学会
→ 自动重放
```

最终让创建自动化更接近**教一个人做事**，而不是编写脚本。
