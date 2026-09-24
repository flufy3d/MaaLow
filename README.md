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
├─ Teaching
├─ Recorder
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

## Teaching Mode

程序分析当前画面，用户主要通过自然语言指导，例如：

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
