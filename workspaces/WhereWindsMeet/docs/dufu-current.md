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
- **gate 口径（2026-11-01 更新）**：当前只跑 **8 对 8、6 分钟/局** 安全 A/B；旧 10 分钟 Stage 1/Stage 2 停用（10 分钟 off 自己 2/3 死亡）。6 分钟安全通过后再做 `offenseQ` 输出 A/B，目标 boss 伤害 ≥30%（stretch 35%），不重训防守。
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
- **Stage 1 6/16 中止（2026-11-01）**：loop 在 r203 后 `fresh_reset` 停在“重伤/再次训练”页，Pad idle；非技能崩溃。off 3 局 2 死（1.84 / dead 2.63 / dead 3.54），v2 3 局 0 死（1.83 / 1.84 / 2.04）；部分 gate off **2.90 / 84.5%**、v2 **2.20 / 88.4%**，金 0/82、0/110。v2 10 分钟 boss 掉 104/172/142 px（27–45%）。**10 分钟 off 对照自己就死亡/超线，Stage 1 的 10 分钟安全门不成立**；未跑 Stage 2。6 局已 ingest，5 个旧录像未动。
- **2026-11-01 用户定 6 分钟口径**：安全 gate 改 8 对 8、6 分钟/局；不重训防守；10 分钟 Stage1/Stage2 停用。真实战 boss 攻击更高、角色死更快，重点提高 6 分钟输出：目标 ≥30%（stretch 35%），同时挨打/分 ≤1.5。当前批次 `off_6min`（r204 起）正在跑，16 局、8 对 8，off vs v2。
- **工具修复**：`loop.py` 的 `fresh_reset` 每次 shadow 前先 `dufu_enter`，可从“重伤/再次训练”页恢复；`do_run` 先关守卫再 `wait_idle`，避免被 `guard:WhereWindsMeet` 的瞬时 busy 直接退出。新增 `test_loop_fresh_reset_recovers_death_panel`，pytest 40 passed；提交 `c2f4ebf`。
- **离线输出复核（r199/r201/r203，2026-11-01）**：`execute` 5/6 成功，每次 **-57~-59 px**，是唯一稳定伤害；13 次 `qishu` 持续伤害约 0，日志里的 ±100 px 是 6 行血条 ROI 抖动回弹；`follow` 0 次是因为阶段一 quiet_far `pE(61)=0.755 < q.follow .80`，不可达；`light` 每次约 1.2–1.8 px。6 分钟 22% 主要就是 1 次处决（59 px）。
- **输出方案改为 qD**：light .70 / follow **.72** / qishu **1.0** / execute .80；预期 follow 找回 35–50 px、qishu 让位 5–10 px，目标 ≥30%。处决失败重试（qi 未回升时补一次）作为第二候选；`BOSS_ROI` 6 行抖动单独验证，不与 qD 混批。仍先过 6 分钟安全门。
- **6 分钟 8 对 8 只跑 8/16 就停（2026-11-01）**：r204–r211 全部活满 6 分钟；第 9 局（r212）只开始录像、没起 skill，loop 退出，空录像已手动 stop，无 r212 目录。**不续跑**，因为安全线已经明显不过：
  - off（4 局）：**1.58 挨打/分、248/274 = 90.5%**、金 1/91；boss 基本不掉。
  - v2（4 局）：**2.54 挨打/分、253/287 = 88.15%**、金 1/91；6 分钟 boss 掉 160/109/108/116 px = **42% / 29% / 28% / 30%（平均约 32%）**，输出目标其实已经接近/达到，但安全失败。
  - v2 c11：**19 窗 10 中**（off 12 窗 1 中）；r205/r209 的 c11 命中分别 4/5。逐帧看，c11 窗内没有 v2 进攻 press，是防守 dodge 后 +11~+21 帧仍被链击命中；当前 `goldNow` 只封进攻，不能修这个防守问题。
  - 结论：**现在不是输出不够，是 v2 安全不够**；继续 qD/加输出只会更差，不跑 qD、不重训防守。下一步要么停 v2，要么先专门修 c11 防守链（不改模型/不重训），再重跑 6 分钟 8 对 8。
- 首版边界：T4/T5 只有接口；幕布整段封锁（c18+6 窗暂缓）；阶段一切横刀后不回切；near 1500 ms；`range` 是 near 代理不是距离；开场奇术放行。
- Gate：Stage 1 = 8 对 8、10 分钟/局，安全线（挨打/分 ≤1.5、致命 ≥90%、金 ≤3%）+ 10 分钟 ≥1 条血（381 px）；Stage 2 = 8 局击杀确认，TTK 中位 ≤20 分钟（15 分钟 stretch，至少 6/8 击杀）。
- 调度、动作表、日志和停止条件见 [dufu-offense-design.md](dufu-offense-design.md)。

## 2026-11-01 进攻批次在线学习：M0 测量

- 用户定口径：进攻改**批次在线学习**（每 4–8 局更新一次，不在同一局内更新）；先做安全的 M1 安全门控，再做 M2 动作排序；安全门仍是 6 分钟/局（挨打/分 ≤1.5、致命 ≥90%、金 ≤3%），输出 ≥30%（stretch 35%）；筛选 2 对 2，晋级 8 对 8、16 局。设计与 schema 见 [dufu-offense-online.md](dufu-offense-online.md)。
- **BOSS_ROI 修正（offense-only）**：旧 `bossBar()` 用 6 行 ROI 的红色像素 / 6；HUD 把血条上下移 1–3 行时读数掉 1/6–1/2 再回弹（r199 47.07 s：365→241→365；r205 血条几乎一直在 y 28–32，正常只读到 5/6）。新增 `lib/dufu-reads.js` 的 `bossFill()`：高 ROI `[347,20,386,20]` 逐行取最大红色行宽，免疫垂直位移。`dufu2.js` 的防守（进场、boss 消失、结束判定、旧 `boss` trace 列）仍用 `bossBar()`；进攻的 near 锚点、`atk2Land` 伤害核算、trace `bossPx` 改用 `bossFill()`。`offense:"off"` 对拍仍 12/12。
- **ROI 离线复核（r199/r201/r203，`offense_boss_roi.py`）**：同一段视频、15 Hz 采样，旧读数有 **320 次**“掉 ≥20 px 又在 1 s 内回到 80%”的假掉（设备 4 Hz trace 同口径 183 次），新读数 **2 次**；5 次有效处决的真实台阶 old 57.3–58.0 px、new 57.5–58.0 px，与已知 −57~−59 px 一致。新读数的已知弱点：横贯 ROI 的红色描边/红雾会把单行顶到 386（比真实条宽多 16–36 px），只偏高、不会造成掉血方向假掉；用它算处决前后差时可能低估，离线用 0.5 s 最大滤波 + 单调包络处理。
- **trace 增加机会级列**：`exe / disc / qishu / pE42 / pE61 / pE70 / cand / gate / hitAge / pol / prop`；`cand` 是规则引擎在 horizon / 学习门控之前的首选，`gate` 是学习门控分，`pol` 0/2/3，`prop` 确定性策略为 1000。旧列不动。
- **数据脚本**：`tools/dufu_moveid/offense_online.py`（`build / audit / train / export`）把 r185–r211 的 trace + contacts 合成机会级数据（`data/moveid/offense/online/`，gitignored），按局切分；`offense_boss_fill.py` 用 `bossFill` 重放录像，给每次按键算真实 2 s / 3 s 伤害。
- **首批审计（r185–r211，27 局）**：244,458 行、16,853 个机会、475 次进攻按键（execute 18 / qishu 49 / light 353 / follow 55）。按键后 61 帧内真值受击：execute 0/18、qishu 1/49、light 15/353、follow 4/55（合计 20/475 = 4.2%，低于全体 v2 行的 6.2%）——**按键窗内并不更危险**。
- **v3 接口**：`args.offense:"v3"` = v2 + `lib/dufu-offense-policy.js` 学习门控（只能否决规则动作，execute 豁免；`args.offenseGateThr` 可做阈值 A/B）。默认仍 `off`，v2 保留。测试 41 passed（新增 `dufu_offense_policy.mjs` 的 Python↔JS 权重对拍与 v3 门控场景）。
- **2 对 2、6 分钟 v2 vs v3（r212–r215，2026-11-01）**：
  - r212 v2 **dead 5.2 分钟**、16 真值受击；r214 v2 time、23 受击。r213 v3 time、14 受击；r215 v3 time、11 受击。
  - 安全（`s5_ab`）：v2 **3.73 挨打/分、致命 145/165 = 87.9%**；v3 **2.26、106/121 = 87.6%**。独立复算（`contacts.json`）：v2 3.55 / 86.2%，v3 2.15 / 83.9%。**两臂都没过 1.5 / 90%**。
  - 输出（bossFill 重放）：v2 149 / 148 px（39% / 39%）；v3 **90 / 18 px（24% / 5%）**，明显回退。
  - 机制：v3 门控把按键从 v2 的 29/33 次压到 9/11 次（gate veto 185/116 个候选 tick），处决从 2/2 次降到 1/0 次，r215 处决按钮 **0 次**。chip 攻击与处决窗的因果关系本轮数据不足以定因（真气随处决重置、局间波动大），但**输出回退是明确的**。
  - **结论：v3 回滚**，默认保持 `off`，不跑 8 对 8。c11 是防守链问题（本轮 v2 5/5、v3 5/10），另开独立防守里程碑；M2 的奖励必须用更长视窗（把后续 execute 窗口算进去），不能只看按键后 2 s 伤害。

## c11 防守链独立实验（2026-11-01）

- 触发：8 局 6 分钟批次里 v2 的 c11 接触 11/11 命中、off 0 次，c11 贡献约 0.48 挨打/分；`dufu-offense-online.md` §5.6 的 v3 回滚也指向防守。
- 数据（r185–r219，83 个 c11/c40 接触）：`k0:c11+c15+c23` 41、`k1:c11+c15+c23` 39、`k2:c11` 3，全部命中；链内每下间隔约 5–6 帧（典型 k0 → +10/+15/+21）。表里 k0 是 dodge（gold）、k1 是 parry（62.5% 历史）、k2 是不可卸的 dodge。第一下 dodge 的 live lead 中位约 **0 帧**（太晚），k1 的 parry 需要压在 k0 之前（k1−6 ≈ k0−1），当前一 tick 一决策做不到。
- 调度器开关 `args.c11Lead`（c11 组的 dodge 用表里的 14 帧而不是全局 5）：`094001b`。
- **2 对 2、6 分钟（r216–r219，offense:"off"）**：off 1.89 挨打/分、致命 90.4%（r216 6、r218 15 真值受击）；c11Lead=14 **2.40、90.2%**（r217 6、r219 19 且 5.2 分钟死亡）。c11 序列 1 vs 5（局间波动大），第一下 dodge 仍出现 lead −0.8；r217 的提前 dodge 在 lead 14.5 按下但没盖住接触，随后 −0.8 的第二下也命中。
- **结论：c11Lead 回滚**（默认 null），调度器只改提前量救不了 c11 链：提前 14 帧在 i-frame 外、按 0 帧又太晚；k1 的 parry 需要跨按键预排。下一步要么是独立防守重训（`loop.py train` + 8 对 8），要么是“双键预排”专门实验；在拿到证据前不再动默认防守。

## 2026-11-01 阶段 A：episode / 节拍数据（离线）

- 工具 `offense_episodes.py`（提交 `d5d3a5e`）：把 `contacts.json` 全部真值接触按 gap ≤ 30 帧聚成 episode；按局号排序后奇偶切 train/val，同一局不跨 split；输出 `data/moveid/offense/online/episodes.json` + `episodes.md`（gitignored）。
- 范围 `r185–r219` 共 **35 局**（任务书写的 31 局是 `r185–r215`；后者 c11 接触正好 83 个）。2709 个真值接触全部分配（100%），1839 个 episode / 2709 拍；多拍 episode 487、接触 1357（50.1%）；train 18 / val 17 局，无重叠。
- c11 主口径（全接触 episode 中首拍含 c11/c40）：**29 个 episode / 98 拍**；c11-only 交叉核对 32/95。两者差异来自首拍不是 c11 但后面含 c11 的 episode，以及 c11 之间夹了其它组。
- 节拍表：相邻 gap 两主档 **4–6 帧（36/69）** 与 **9–13 帧（22/69）**；累计 offset 中位 **i1=9、i2=15、i3=21**。固定的是链内累计节拍，不是每一段 gap；3 拍链常见 `9→6`、`10→5`、`11→4`。intended 键：i0 dodge 26 / parry 1，i1 dodge 10 / parry 6，i2 parry 7 / dodge 15。
- 第一下 dodge：29 个 c11 episode 里 28 个首拍 k0 是 hit，1 个从 k1 开始且没有 k0:c11 覆盖按键；c11-only 有 3 个 k1 开头，同样没有覆盖按键。按键级 151 条 k0:c11 dodge：real 23、uncertain 2、false positive 126；real 的实际提前量中位 **1.0 帧**（配置 lead=5 子集 0.8，lead=14 子集 12.2–18.3）。**没有 k0 闪避成功的证据**；失败不是没按，是默认 5 太晚、c11Lead=14 太早。
- 第 2/3 拍：c11 index 1/2 共 **52 拍，ok=0**；intended 里 k1 parry 6 条中位实际提前 **0.4 帧**、k2 dodge 15 条 **0.3 帧**，均太晚。对照全部 episode index 1/2 的 ok 率 **73.5%/78.2%**，ok 由 parry 支撑（intended actual lead 中位 7.5 帧）。
- 可行动上界（每拍 truth_resp + 默认 lead/冷却）：c11 **73/98 拍可排（74.5%）**，整链全可排 **9/29**；主要损失是 k2 dodge 与 k0 dodge 的 500 ms 冷却冲突（fast 档 k0→k2 只隔 10–11 帧）。
- **结论：c11 的杠杆在链内第 2/3 拍，不在第一下。** 阶段 B 优先预排 k1 parry + k2 dodge，并处理 k0 dodge 占用的 500 ms 冷却；离线覆盖达标后再上机。未改任何默认、未上机。

## 历史

- 方案设计（为什么换 / 目标 / 核心思路 / 运行时 / 模型 / 关卡 / 约束 / 顺序）：[dufu-moveid-plan.md](dufu-moveid-plan.md)
- 2026-10-24～2026-10-28 的顺序 1–6 进展（逐字归档）：[archive/dufu-moveid-2026-10.md](archive/dufu-moveid-2026-10.md)
- 工具旧 README（逐字归档）：[archive/dufu-moveid-tools-2026-10.md](archive/dufu-moveid-tools-2026-10.md)
- 旧 `dufu.js` 基线、老师规则、试过没用的方向：[dufu.md](dufu.md)
- 当前工具入口：[../tools/dufu_moveid/README.md](../tools/dufu_moveid/README.md)
