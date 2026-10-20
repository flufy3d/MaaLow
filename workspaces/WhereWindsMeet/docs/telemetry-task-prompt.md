# 新会话任务提示词：独夫防守执行/状态遥测

把下面整段复制到新会话。

---

你在 `D:\Projects\MaaLow` 工作（Windows，bash）。这是 MaaLow 的 `WhereWindsMeet` 工作区，目标是给独夫（dufu）防守加**只加日志的遥测**，不改变任何默认战斗行为。

先读：
- `workspaces/WhereWindsMeet/docs/dufu-defense-findings-20261020.md`（本轮总收口，最重要）
- `workspaces/WhereWindsMeet/docs/runtime-hp-feedback-audit.md`（已保留的 P0b 低血修复）
- `workspaces/WhereWindsMeet/docs/attack-evidence-audit.md`（原始审计）
- `workspaces/WhereWindsMeet/skills/dufu.js`、`skills/lib/dufu-reads.js`
- `tests/dufu_scheduler.mjs`
- `data/tmp/dense_pred/r748.run.utf8.json`（r748 诊断轮，21 hit）
- 需要时看 `data/attack_triage/20261020/` 下的 triage/ground_review/r748_review

当前代码状态：P0b 低血修复已保留；`curtainDodgeFirst`、`defDodgeReplan`、`offDefend` 三个失败开关已被清理；`curtainParryPlan`/`curtainKeepParry`/`dodgeMinP`/`flareThreat` 等原有参数保留。先跑 `node tests/dufu_scheduler.mjs`（应为 **17 PASS**）和 `uv run pytest -q`（**40 passed**），确认基线通过。

## 目标

实现默认关闭的 `telemetry`（或等价参数），只写日志：

1. **`pred` 概率**：在现有 `predMark` 里，除了 `def1` argmax，再记录 `def1` 的 p0–p4（至少 p(parry)、p(dodge)、p(avoid)）和 argmax；仍支持 `predMs=50`。不要改变推理/计划。
2. **press 执行反馈**：每次 `press parry` 后 5–10f，读一次 parry 按钮/卸势架势（优先用现有模板 `combat/parry_ok.png` / 现有按钮 ROI/像素读；参考 `dufu.js` 的 `litNow`、`data/tmp/dufu_yolo/glow.py` 的按钮光 ROI），写 `mark("press result", "parry lit|stance|none ...")`；dodge 后记录 dodge 按钮光/是否进入闪避。没有可靠读法就写 `unknown`，不要硬造。
3. **状态切换**：`inCurtain` 进入/退出、`staggerUntil` 设置/到期、`off` 当前动作（开/关）、`hp/qi` 明显变化；倒地/被按住如果暂时没有可靠检测，先用 `hit`/`stagger`/`escape skip (heavy)` 时间近似并标 `unknown`，不要为了这个引入新模型。

所有日志只在 `telemetry:true` 时输出；`telemetry` 默认 false，关闭时 events/presses/v8 与现在完全一致。加假时钟测试：关闭时无变化；开启时 `pred` 带概率、press 后有 result、状态切换有 mark；不得改变 `press`/`touch` 次数。

## 验收

- `node --check workspaces/WhereWindsMeet/skills/dufu.js`、`node --check tests/dufu_scheduler.mjs` 通过。
- `node tests/dufu_scheduler.mjs` 全过；`uv run pytest -q` 40 passed（或清理后的基线）。
- 默认关闭时行为与清理后一致；开启时只多日志。
- 写 `workspaces/WhereWindsMeet/docs/telemetry-implementation.md`：改了哪些文件、字段格式、测试、限制。

## 诊断跑

测试通过后，只推 `skills/dufu.js`（和 `dufu-reads.js`，若改）：
`uv run maalow sync WhereWindsMeet --push --exclude 'docs/**' --exclude 'tools/**' --exclude 'README.md' --exclude 'skills/maalow.d.ts'`

用和 737 相同的参数，加 `telemetry:true`、`predMs:50`，跑 1–2 轮。成功页/死亡页：死亡页点 `(1000,682)`“再次训练”；成功页点 `(880,682)`“再次演练”。录像可选，run JSON 必须保存。

然后逐条分析 21 条 hit，重点用 4 个已知案例：
- r748 2712（横向扫击，def1=dodge/计划=parry）
- r748 970、3947（玩家俯卧/被按住）
- r748 2806（幕布内，S1 0.96 但无 plan）

把每条 hit 分成：
- `NOT_EXECUTED`：press 发了，5–10f 内没有 parry 架势/按钮光；
- `EXECUTED_UNPARRYABLE`：有架势/按钮光，仍中；
- `EXECUTED_TIMING`：有架势，但早/晚或接触估计偏；
- `NO_PRESS_STATE`：没有 press，因为幕布/倒地/硬直/出招/CD；
- `MEASUREMENT`：灰屏/读条伪影。

输出 `workspaces/WhereWindsMeet/docs/telemetry-findings.md`：逐条表、四类计数与 maxHP、4 个案例的证据、下一步建议（只基于数据，不直接改默认）。不要写 labels.json，不要宣称人工确认。

## 约束

- 不改默认策略、不调 lead/阈值、不加新防守开关；只加日志。
- 不运行游戏之前先跑测试；不推送 docs/tools/data。
- 保留仓库既存未提交改动（包括 P0b、flareThreat 等）。
- 重活可以开子代理：一个做代码+测试，一个做数据分析；协调者复审。
- 所有结论区分“日志事实 / 代理推断 / 待人工确认”。
