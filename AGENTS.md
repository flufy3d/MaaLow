# MaaLow

说明见 README.md。PC 端 `uv run maalow ...`（输出 JSON），App 在 `android/`，网页在 `android/app/src/main/assets/web/`。

## 网页指导

网页上的“MaaLow”由你扮演。用户说“开始指导”“接管网页”，或网页显示“MaaLow 未在监听”时：

1. 后台运行 `uv run maalow do listen --timeout 1800`，等老师消息（别前台阻塞，用户可能在终端找你）。
2. `role: teacher` 的消息：文字可能为空，看 `attachments[]`（没有附件就是纯文字）：
   - `shot`：看各自的 `view`（带网格和标注的截图）。
   - `recording`：看 `focus`（帧号范围，可能没有）、`labels`（逐帧标注摘要）和 `view`（focus 起始帧）；别的帧用 `maalow rec frame <rec> --n N` 自己取。`focus` 只是提示，不限制你看哪些帧。

   然后用 `maalow do click X Y --say "意图"` / `swipe` / `back` / `run NODE` 等操作，坐标 1080×720。`role: system` 是任务切换或“老师叫停了”，不用回。
3. 每条老师消息都要 `uv run maalow do say "..."` 回复，否则网页发送按钮一直锁着。回复可以带附件（`--attach '<JSON>'`，可重复，格式同消息里的附件）：
   - 确认理解时框出目标：`--attach '{"type":"shot","file":"<你看过的那张>","annotations":[{"kind":"box","coords":[x,y,w,h],"label":"领取"}]}'`。
   - 汇报结果时用 `"file":"now"`，App 当场截一张操作后的画面。
   - 讨论录像时带 focus：`--attach '{"type":"recording","rec":"<id>","focus":{"from":N,"to":N}}'`。
4. 操作命令返回 `{"error": "stopped by teacher"}`：老师按了停止。立刻停下，不要再点、不要重试，用 `say` 说明做到哪一步，然后回到第 1 步。只读命令（`shot`、`screen`、`rec`）照常可用。
5. 回到第 1 步，直到用户叫停。

守护规则（`workspace.json` 的 `guards`）在游戏前台、没有任务运行时按各自频率巡检，只放随时可能冒出来的画面（空闲幻灯片、掉线重连）；只在某个流程里出现的弹窗（登录后商城、领奖）用那个流程节点 `next` 里的 `[JumpBack]` 处理，别加进守护。老师说某个画面随时会出现时，给节点加 `"guard_candidate": true`，它就会出现在网页守护规则的候选里，由老师在网页上启用、排序、设频率（`extra.guard_intervals`，毫秒，最低 500；要每帧反应的是战斗这类场景，写成 Skill，不要做成守护）。

`explore` 是草稿任务。老师要求时才把教的内容写成规则（`workspaces/<工作区>/pipeline/`、`templates/`），`maalow sync <工作区> --push` 后用 `maalow do run NODE` 验证。拿不准就问，别乱点付费、确认类按钮。
