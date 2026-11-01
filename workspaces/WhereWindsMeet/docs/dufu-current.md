# 独夫：现状（2026-10-31）

干净基座基于 `7721712`（2026-10-31 清理提交见 git log）。阶段一和阶段二的防守都已通过关 2；顺序 6 的进攻仍默认关，关 3 未过。本文只记当前有效结论；方案设计见 [dufu-moveid-plan.md](dufu-moveid-plan.md)，2026-10-24～10-28 的实验记录见 [archive/dufu-moveid-2026-10.md](archive/dufu-moveid-2026-10.md)。

## 一眼看完

| 项 | 阶段一 | 阶段二 |
|---|---|---|
| 默认模型 | `dufu1b` | `dufu2b` |
| 关 2 局数 | fresh 16（r116–r146 偶数局） | 确认轮 16（r100–r115） |
| 致命招应对 | 919/998 = 92.1% | 3235/3492 = 92.6% |
| 按局 bootstrap 95%（本轮） | [89.7%, 94.3%] | [91.3%, 94.0%] |
| 金招按成卸 | 0/317 = 0.0% | 5/498 = 1.0% |
| 挨打/分 | 1.38 | 1.74 |
| 结论 | 两轮独立 16 局合并后过线 | 两条都过 |

阶段一的合并口径（r099–r114 + r116–r146，同模型同配置）是 **1627/1769 = 92.0%**，按局 bootstrap 95% 区间 **[90.3%, 93.5%]**；金招按成卸 **1/563 = 0.18%**；**1.45 挨打/分**。按阶段二「区间下界也 ≥90% 才算稳过」的标准，阶段一关 2 两条都过。

## 阶段一（dufu1b）

- **fresh 16（r116–r146 偶数局，6 分钟/局）**：致命招应对 **919/998 = 92.1%**，按局 bootstrap 95% 区间 **[89.7%, 94.3%]**；含未核实闪避 1112/1191 = 93.4%；金招按成卸 **0/317 = 0.0%**；**1.38 挨打/分**。16 局全部 fresh、全部活满 6 分钟；4 局低于 90%。
- **区间口径**：`fresh16_review.py` 用不同 bootstrap 种子复算为 [89.6%, 94.3%]，点估计一致；本文用既有报告 [89.7%, 94.3%]。
- **失败归因（fresh 16，致命 79 下）**：时机偏 22、不可行动 16、没认出 15、认对按对仍挨打 14、认错应对 12。
- **配置**：`parryLead=10, curtainGap=false, curtain2=true, attack=false`，qnn；`chain11` 已从代码删除（等价于 false，历史 A/B 见归档）。`dufu2.js` 的 `args.model` 默认 `dufu1b`（2026-10-28 用户同意）；旧 `dufu1` 仍可用 `"model":"dufu1"` 显式选择。
- **喝药已修（r176 / r178）**：涂毒后等 `PREP_SETTLE_MS` 2.5 s 让 buff 落地，再检查槽位、必要时换回药；`potionTick` 喝药前也检查快捷槽，必要时开物品栏换药（每局最多 2 次）。r176 在 19% 血 `slot swap 1 → swap 2 → tap → healed 19%→28%`，r178 在 24% 血 `swap 1 → tap → 24%→33%`。
- **关 1（学生 OOF，−10 帧）**：fp32 致命招应对 5503/5837 = 94.3%；int8 5442/5837 = 93.2%；金→红 0/707（阶段一没有红光，实际按金→非金 / 卸势看）；金→没光重映射后 gold 707 = 7.5%、none 8527 = 89.9%、unknown 255 = 2.7%、red 0。

## 阶段二（dufu2b）

- **确认轮 16 局（r100–r115，17.5 分钟/局）**：致命招应对 **3235/3492 = 92.6%**，按局 bootstrap 95% 区间 **[91.3%, 94.0%]**；含未核实闪避 3590/3847 = 93.3%；金招按成卸 **5/498 = 1.0%**；**1.74 挨打/分**；5 局活满 17.5 分钟，按局中位 92.8%，3 局低于 90%。
- **默认配置**：模型 `dufu2b` + 闪避提前 `dodgeLead=5` + 火球雨斜后跑（`runDir:"diag"`）+ 金光火球窗（`goldSeq`）+ `chain` 开；qnn，17.5 分钟/局。
- **关 2 口径**：致命招每一下在决策时刻（接触前 10 帧）应对判对 ≥90%，金招被当成卸势 ≤3%，连续 16 局。闪避后 25 帧内没有接触算闪开；没有录像核实的闪避另报「含未核实」口径。
- **旧基线**：`dufu.js` 阶段二约 10 挨打/分、存活约 150 s；`dufu2.js` 首版关 2 是 8 局 76.1%、5.49 挨打/分。确认轮把 k2:c30 的补卸势（`chain`）改为默认开后过线。

## 顺序 6：进攻（默认关）

- `dufu2.js` 的 `args.attack` 默认 `false`（代码 `args.attack ?? false`）；阶段一 / 阶段二共用，进攻触摸走 contact 3，不占防守的 contact 1/2。
- **6 对 6 fresh A/B（r148–r159，6 分钟/局）**：进攻关 **1.11 挨打/分**、致命 372/397 = 93.7%、金招按成卸 1/120；进攻开 **1.37 挨打/分**、致命 436/469 = 92.96%、金招按成卸 1/124，boss 每局掉 **26–46%**（关的 6 局 0–0.8%）。
- **关 3（进攻开，r160–r175，16 局）**：152 hit / 90.1 战斗分钟 = **1.69 挨打/分**（`report` 按局等权 1.71，`s5_ab` 去掉进场 1.81）；致命 947/1049 = 90.28%（含未核实 91.89%）；金招按成卸 0/294。**第一条 ≤1.5 未过。**
- **修喝药后重跑（r177–r184，8/16 时用户叫停）**：111 hit / 46.1 分钟 = **2.41 挨打/分**（`s5_ab` 2.52）；致命 536/597 = 89.78%；金招按成卸 0/140；逐局 2.24 / 2.25 / 2.75 / 1.55 / 3.28 / 2.59 / 1.03 / 3.61。
- **结论**：进攻开在关 3 不成立，`attack` 只做显式 opt-in。16 局的建议配置是 `attack:false`（A/B 1.11，阶段一 fresh 16 1.38），等关 3 过了再单独迭代输出。

## 阶段一 fresh 16 失败复核（79 个致命失败）

脚本 `data/p1/fresh16_review.py`（不 import `s5_analyze` / `s5_ab` / `gate2_check`），逐条台账 `data/p1/gate2_check/fresh16_review.json`，79 张失败帧条在 `data/p1/gate2_check/fresh16_review_sheets/`。

设备 `result.hits` 16 局合计 **112**；录像真值命中 **126**，其中 4 个是抓取过场的后续（按门 1 排除），非抓取 **122**。下面按 122 个真值命中复核；致命失败 **79** 个，其余 43 个是非致命组 / 未识别组的命中。

| 根因 | 次数 | 占 79 | 归属 |
|---|---|---|---|
| 幕布扫击（k0:c5+c18 14、k1:c18 3） | 17 | 21.5% | 执行 / 机制 |
| 时机偏（14 太晚 + 2 太早） | 16 | 20.3% | 模型（接触时间） |
| 连段硬直（前一下 5–19 帧内） | 15 | 19.0% | 执行 / 机制 |
| 没认出（无按键） | 12 | 15.2% | 模型（识别） |
| 认错应对（全是 parry→dodge） | 10 | 12.7% | 模型（应对） |
| 按键锁 / 动作未恢复（键对、窗内仍挨） | 8 | 10.1% | 执行 / 机制 |
| 喝药锁 | 1 | 1.3% | 执行 / 机制 |
| **合计** | **79** | **—** | **模型可修 38 / 执行机制 41** |

- **模型可修 38（48.1%，HP 46.3%）/ 执行机制 41（51.9%，HP 53.7%）**。模型侧没有一条规则能一次拿下 10 个以上：识别 12 要重训或改 tte，时机 16 是 tte 抖动，应对 10 是颜色头临门翻转。
- **幕布 17 全部失败**：k0:c5+c18 14、k1:c18 3；6 个闪避在接触前 7.3–13.5 帧（窗内）仍被扫到，6 个太晚（−0.0…2.5 帧），3 个没按，2 个 k1:c18 的闪避被门 2 记成「认错应对」，按根因已移到幕布。
- **低成本候选全部不到 1pp，未做 6 对 6**：`chain11` 目标 14 下但其中 12 下是链中硬直；提前量 / 闪避 lead、幕布 gap、curtain2 都已 A/B 过；按键稳定化可能救几个但也会把 14 个本来就晚的按得更晚；金色阈值 0.02 在 OOF 上金→卸 2.97% 贴 3% 线、没有余量；幕布走缝 `curtainGap=false` 是 A/B 选出来的。
- **结论**：没有 ≥1pp 的低成本防守修正，防守 gate 和默认配置（`dufu1b`、`parryLead=10`、`curtainGap=false`、`curtain2=true`；`chain11` 已删除）不变。

## 当前默认命令

进场（阶段一；阶段二把 `phase` 改 2）：

```bash
uv run maalow do skill dufu_enter --args '{"phase":1}'
```

单局（`dufu_rounds.py`，阶段一，防守，6 分钟）：

```bash
uv run python workspaces/WhereWindsMeet/tools/dufu_rounds.py data/moveid/p1/live --n 1 --phase 1 \
  --skill dufu2 --ms 360000 \
  --skill-args '{"mode":"defend","provider":"qnn","model":"dufu1b","attack":false}'
```

阶段一默认 `parryLead=10 / curtainGap=false / curtain2=true`（2026-10-31 起折进代码），`attack` 仍默认 false；阶段二默认不变。

闭环（`loop.py`，`MOVEID_PHASE=1`；阶段二不设这个变量）：

```bash
D=workspaces/WhereWindsMeet/tools/dufu_moveid
MOVEID_PHASE=1 uv run python $D/loop.py run --n 16 --tag gate3 --batch 8 \
  --args '{"mode":"defend","provider":"qnn","model":"dufu1b"}'
MOVEID_PHASE=1 uv run python $D/loop.py ab --n 12 --tag ab_attack \
  --alt '[{"attack":false,"model":"dufu1b"},{"attack":true,"model":"dufu1b"}]'
MOVEID_PHASE=1 uv run python $D/loop.py ingest --tag gate3
MOVEID_PHASE=1 uv run python $D/loop.py gate --tag gate3
MOVEID_PHASE=1 uv run python $D/loop.py train --tag live_b --live r... --val r...
MOVEID_PHASE=1 uv run python $D/loop.py report --tag gate3
```

`run` / `ab` 每局前如果是接着打（上一局 `time`），先跑一局不录像、不建 round 目录的 `shadow` 让 boss 把角色打死，下一局 `dufu_enter` 就是满血 fresh；开始前临时关掉 `AutoPickup`、`DismissIdleSlideshow`、`CloseItemTip`，结束时恢复原来的 `off` 列表。`ingest` = `s5_pull --delete` → `s5_color` → `s5_analyze`。

## 数据 / 资产地图

仓库根是 `D:\Projects\MaaLow`；`data/` 在仓库根，不在 `workspaces/WhereWindsMeet/` 下。

| 路径 | 内容 |
|---|---|
| `workspaces/WhereWindsMeet/model/dufu1b/` | 阶段一默认模型：`dufu1.json` + int8 / fp32 / qnn ONNX |
| `workspaces/WhereWindsMeet/model/dufu1/` | 顺序 4 基座（`dufu1.json`）+ 阶段一 `movetable.json`（97 组，全局卸势提前 6，`k0:c5+c18` / `k2:c11` 不可卸） |
| `workspaces/WhereWindsMeet/model/dufu2b/` | 阶段二默认模型：`dufu2.json` + int8 / fp32 / qnn ONNX |
| `workspaces/WhereWindsMeet/model/dufu2/` | 顺序 4 基座 + 阶段二 `movetable.json`（87 组；模型 88 类含 idle，全局卸势提前 10，表里的闪避 14 是占位，实机用 `dodgeLead=5`） |
| `workspaces/WhereWindsMeet/skills/lib/dufu1-table.js`、`dufu2-table.js` | 两张表编译进 skill 的副本；改表后要重新生成并 `s5_push.py` |
| `data/moveid/p1/` | 阶段一 120 局数据底座：`index.json`、`events_ext.json`、`decisions.json`、`video/`、`bars/`；录像 34.16 GB，9489 个接触 |
| `data/moveid/` | 阶段二 197 局数据底座：同上；录像 29.35 GB，7982 个接触 |
| `data/moveid/p1/moves/taxonomy.json` | 阶段一聚类：28 类出招 + unknown；`special.json` 标金光抓取后续 c7、幕布 c5/c18 |
| `data/moveid/p1/teacher_prefix/` | `prefix.json`（97 组）、`oof.npz`、`gate1.json`、`check/` |
| `data/moveid/p1/student/` | `oof.npz`、`gate1/`、`final.pt`、`live_a.pt`、`live_eval.json` |
| `data/moveid/p1/live/` | r001–r184 实机局；`loop_gate3.json`（manifest）、`loop_gate3_gate.json`、`loop_ab_attack_gate.json`、`ab_fresh16_confirm.json`、`ab_final16_new.json` |
| `data/p1/gate2_check/` | `fresh16_review.json`（79 个失败台账）、`fresh16_review_sheets/`、`fresh16_confirm.json`、`final16_new.json`、`lead_clean_base.json`（2026-10-31 独立复算） |
| `data/p1/gate2_check.py`、`data/p1/fresh16_review.py` | 独立复算脚本（不 import `s5_analyze` / `s5_ab`） |
| `data/moveid/live/ab_confirm16.json`、`gate2_confirm16.txt` | 阶段二确认轮的复算结果 |

## 已知缺口 / 下一步

- **阶段一防守**：没有 ≥1pp 的低成本修正；79 个致命失败里 41 个是执行 / 机制（幕布 17、连段硬直 15、按键锁 8、喝药 1），38 个是模型（时机 16、没认出 12、认错 10）。继续调 lead / 阈值 / 历史 `chain11` 不会有量级变化。
- **阶段二防守**：确认轮剩 257 个致命失败，主要是 k0 无光大组 79、k1 无光组 43、k2 无光组 40、k0:c27 25、火球雨各段合计约 37。
- **进攻**：按 TTK / boss 掉血速度评估，不能只看 6 分钟 A/B 的 26–46%；防守 gate 不变，进攻保持 opt-in。v2 设计和 gate 见 [dufu-offense-design.md](dufu-offense-design.md)。
- **gate X 与 A/B 规模**：已定两段式——8 对 8、10 分钟/局 A/B（安全线 + 10 分钟 ≥1 条血 381 px），过了再 8 局击杀确认（TTK 中位 ≤20 分钟，15 分钟 stretch）。
- **数据纪律**：录像拉到 PC 逐帧校验后再从 Pad 删；模型 / 阈值改动前后都用同一关 2 口径 16 局 + 按局 bootstrap 报区间。

## 2026-10-31 干净基座

- **删可再生缓存**：`data/moveid/p1/student/views` 286G、`data/moveid/p1/teacher/cache` 111G、`gate0/frames` 18.6G（阶段二 9.8 + 阶段一 8.8）、`color/crops` 5.3G（2.3 + 3.0）、`data/tmp` 0.73G；D 盘可用 531G → **952G**。保留 `soft` 1.3G、`p1/student/pad` 2.4G 作为证据，以及全部模型、OOF、gate JSON、录像和训练清单。
- **独立复算**：`data/p1/gate2_check/lead_clean_base.json`，fresh 16 局 919/998 = 92.1%、含未核实 1112/1191 = 93.4%、金 0/317，和既有报告一致。
- **代码**：`dufu2.js` 删除 `chain11` 路径，阶段一默认值折成 `parryLead=10 / curtainGap=false / curtain2=true`；新增 `tests/dufu2_scheduler.mjs`（10 条测试）和 pytest 入口，旧/新触摸序列对拍一致。
- **Git**：删除已合并的 `dufu-unified`（本地 + 远程）、`refactor/oct26`；提交 4 个派生标签资产（2 个脚本 + 2 个 `s2_labels_p1*.json`），2 个空 `gate0_*_p1.json` 留未跟踪。
- **Pad**：停掉遗留的 `zhenshou` Skill；5 个 10-23 旧录像、`guards off=[]`、viewers 0。

## 2026-11-01 进攻 v2 设计与首版实现

- 用户确认：阶段一允许在安全长窗切横刀（陌刀默认、长窗横刀、短窗/防守回陌刀——首版暂不回切）；Gate 两段式；阶段二放到阶段一之后。
- 离线分析（30 fps 修正）：tte 不能当进攻门；`charge` 基本不打 HP；`strike` 只能作整套收尾，整套净 HP 中位 1.14 px；可用输出是 execute / qishu / light / follow。总血量中位 2 条 × 381 px；当前 10 分钟约 21%，现实保守 TTK 16.9 分钟。
- 首版实现已落地、默认关：`lib/dufu-offense.js` + `dufu-offense-table.js`、`dufu2.js` 的 `args.offense:"v2"`、trace 10 列、`result.offense`、`loop.py gate` 按 offense 分组、`s5_push.py` 推送新 lib。
- 测试：pytest 39 passed；`dufu2_scheduler` 34 条；`dufu_offense` 13 条；固定基线 `4c80b3c` 的 `offense:"off"` 对拍 12/12 逐条一致。
- **实机安全回归（2026-11-01）**：6 分钟 smoke 伤害约 37.5%，但 2.43 挨打/分；旧 q 2 对 2 off vs v2 为 **1.44 vs 4.26 挨打/分、致命 89.7% vs 81.8%**（r189 3.2 分钟死亡），不是 CPU（loop p50/p95 同量级）。收紧到 `.80/.85/.90/.90/.95` 后：off **1.63 / 86.8%**，v2 **2.99 / 87.8%**，v2 只剩 20 个动作、6 分钟 boss 约 21%。关键 bug：v2 的 c11 窗口 10 个里 7 个挨打（off 7/0）；已加 `goldNow`（goldSeq / 金 tell / 最近 c11·c40 接触后 2.5 s，阶段一/二都生效），q 调到中间值 `.70/.80/.85/.85/.90`。修复后 2 对 2（r194–r197）：off **2.25 / 88.1% / c11 11 窗 9 中**，v2 **1.90 / 88.7% / c11 6 窗 0 中**；v2 6 分钟 boss 约 22%。c11 撞车已消失、v2 这一批优于 off，但伤害偏低；进入正式 Stage 1（8 对 8、10 分钟）。
- **Stage 1 6/16 中止（2026-11-01）**：loop 在 r203 后 `fresh_reset` 停在“重伤/再次训练”页，Pad idle；非技能崩溃。off 3 局 2 死（1.84 / dead 2.63 / dead 3.54），v2 3 局 0 死（1.83 / 1.84 / 2.04）；部分 gate off **2.90 / 84.5%**、v2 **2.20 / 88.4%**，金 0/82、0/110。v2 10 分钟 boss 掉 104/172/142 px（27–45%）。**10 分钟 off 对照自己就死亡/超线，Stage 1 的 10 分钟安全门不成立**；未跑 Stage 2。6 局已 ingest，5 个旧录像未动。下一步需选：6 分钟安全 A/B + 单独 10 分钟 v2 伤害/存活，或先重训防守，或放宽 10 分钟安全线。
- 首版边界：T4/T5 只有接口；幕布整段封锁（c18+6 窗暂缓）；阶段一切横刀后不回切；near 1500 ms；`range` 是 near 代理不是距离；开场奇术放行。
- Gate：Stage 1 = 8 对 8、10 分钟/局，安全线（挨打/分 ≤1.5、致命 ≥90%、金 ≤3%）+ 10 分钟 ≥1 条血（381 px）；Stage 2 = 8 局击杀确认，TTK 中位 ≤20 分钟（15 分钟 stretch，至少 6/8 击杀）。
- 调度、动作表、日志和停止条件见 [dufu-offense-design.md](dufu-offense-design.md)。

## 历史

- 方案设计（为什么换 / 目标 / 核心思路 / 运行时 / 模型 / 关卡 / 约束 / 顺序）：[dufu-moveid-plan.md](dufu-moveid-plan.md)
- 2026-10-24～2026-10-28 的顺序 1–6 进展（逐字归档）：[archive/dufu-moveid-2026-10.md](archive/dufu-moveid-2026-10.md)
- 工具旧 README（逐字归档）：[archive/dufu-moveid-tools-2026-10.md](archive/dufu-moveid-tools-2026-10.md)
- 旧 `dufu.js` 基线、老师规则、试过没用的方向：[dufu.md](dufu.md)
- 当前工具入口：[../tools/dufu_moveid/README.md](../tools/dufu_moveid/README.md)
