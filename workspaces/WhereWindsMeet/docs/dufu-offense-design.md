# 独夫进攻 v2：设计与 gate（2026-11-01）

状态：设计已定，代码未写。防守关 2 不动；进攻默认关，只有本设计的 Stage 1/2 都过才考虑改默认。

数据来源：`data/moveid/offense/report.md`、`design-input.md`、`analysis.json`、`fps_check.json`、`boss_bars.json`、`sets.json`（30 fps 修正版）。旧 24 fps 版本只作对照，不引用。

## 1. 目标

- 阶段一/阶段二防守指标不变：致命应对 ≥90%、金招按成卸 ≤3%、挨打/分 ≤1.5。
- 进攻的指标是 **boss 掉血速度 / TTK**，不是“有攻击动作”。
- 先做阶段一；阶段二在阶段一 Stage 1/2 过了以后单独验证，不套阶段一伤害数字。

## 2. 已定决策（2026-11-01 用户确认）

1. **阶段一允许在安全长窗切横刀**：陌刀默认；长窗切横刀打 `light` / `follow`，短窗/防守回陌刀（首版暂不回切，见 §10）。金光闪、红光卸、幕布、火球雨规则不变。
2. **Gate 两段式**：先 8 对 8、10 分钟/局 A/B；过了再 8 局击杀确认（20 分钟上限）。
3. **阶段二放在阶段一之后**：阶段二没有进攻 A/B，不能把阶段一 TTK 直接套过去。

## 3. 离线结论（30 fps）

### 3.1 tte 不能当进攻门

OOF 在接触前 30 帧仍给 21–26% 的“空窗”，真值是 0；live trace 的 `rnone`/`med` 对 empty30 的 AUC 只有 0.48–0.52。调度改用**经验组表 `next.share` + 30 帧无接触 + 特殊窗**；tte 完整 47 箱仍写进 trace，留给以后校准。

### 3.2 空窗（可上线口径）

| 锚点 | 阶段一 P(empty 45/60/90) | 阶段二 P(empty 45/60/90) |
|---|---|---|
| ok 串中 | .178 / .066 / .000 | .113 / .032 / .001 |
| ok 串尾（oracle，只当上限） | 1.00 / 1.00 / .910 | 1.00 / 1.00 / .941 |
| ok 低 next.share + 30 帧 | .791 / .777 / .679 | .823 / .771 / .592 |
| hit 串尾 + 30 | .997 / .938 / .662 | .946 / .866 / .541 |
| quiet_far | .809 / .757 / .666 | .743 / .671 / .550 |
| 幕布 c18 + 6 | .963 / .667 / .556 | — |
| 火球雨链尾 + 10 | — | .911 / .911 / .616 |
| 金光火球第一发 + 6 | — | .042 / .008 / .000 |
| 火球雨第一发 + 6 | — | .009 / .000 / .000 |
| 处决按钮 + 6（n=19） | 1.00 / 1.00 / 1.00 | — |

上线**不用** `chain_pos == chain_len-1`（未来标签），只用 `next.share < 0.2 + 30 帧无接触` 和特殊窗。

### 3.3 动作经济（30 fps）

阶段一常态陌刀；`light`/`follow` 在横刀，切刀约 24 帧，旧引擎 `switch` 净 -5.15 px。

| 动作 | 前置 | commit+safety | q | 单次净 HP |
|---|---|---:|---:|---:|
| execute | 气竭按钮 | 45 f | .80 | 31.49 px |
| qishu | 长窗 / 气竭 | 70 f | **.85** | 28.30 px |
| light | 横刀（陌刀先切） | 18 f（+24 f = 42 f） | **.70** | 4.18 px |
| follow | 横刀 ok 蓝盘 | 37 f（+24 f = 61 f） | **.80** | 6.66 px |
| charge | 陌刀 | 46 f | **.85** | ~0 HP，+12 真气 |
| 整套 | 横刀 + burst 冷好 | 144 f | **.90** | 净 1.14 / 正步骤 7 px |

> q 不是离线分析的原始值。2 对 2 实机回归里旧 q（`.60/.70/.80/.85/.90`）v2 4.26 挨打/分，先收紧到 `.80/.85/.90/.90/.95` 仍只有 2.99 且伤害 21%/6min；现在取中间值 `.70/.80/.85/.85/.90`，同时保留 `pWithin(commit+safety) < .25` 的 horizon 硬门和 2.5 s c11/金光封锁。`args.offenseQ` 可覆盖做 A/B。
| hlight | 横刀 | 39 f | .60 | 1.69 px（不划算） |

关键修正：

- `strike` **不能独立按**，只是横刀整套 `switch → dash1 → burst → dash2 → strike` 的最后一步；607 套完成 68.2%，净 HP 中位 1.14 px，正步骤中位 7 px，真气中位 19.3 px。每 commit 帧 HP 只有 light 的约 1/8、execute 的约 1/18。整套只给阶段转换/开场，不当主输出。
- `charge` 基本不打 HP，价值主要是 12 px 真气；不作为 HP 输出。
- 真正可用的输出是 `execute` / `qishu` / `light` / `follow`。

### 3.4 总血量 / TTK

旧 71 个 clear：boss 血条 **N 中位 2，均值 2.51，p10–p90 = 1–4**；每条 381 px，总血量中位 **762 px**（IQR 762–1,143）。

当前 A/B 6 分钟 25.5% 是第一条血条的 25.5%；10 分钟约 162 px = 总血量 **21%**。

| 组合 | px/min | 总 TTK（N=2） |
|---|---:|---:|
| 当前 A/B 速率 | 16.2 | 47 min |
| 现实保守 | 45.2 | 16.9 min |
| 现实中位 | ~60 | ~12.7 min |
| 现实乐观 | 78.3 | 9.7 min |
| N=3 保守 / 乐观 | — | 25.3 / 14.6 min |
| 旧引擎实测（5.25 挨打/分，仅参考） | — | 3.77 min |

## 4. 结构

- 新 `workspaces/WhereWindsMeet/skills/lib/dufu-offense.js`：纯决策函数，不碰触摸。输入：now、phase、接触历史（上一次接触/结果/组/k/`next.share`）、boss HP、真气、武器、特殊窗、防守忙闲；输出：动作、tier、q、原因。
- `dufu2.js`：接线；进攻走 contact 3；防守 contact 1/2 完全不变；防守随时抢占，`atkRelease` 立即松手。
- boss 包：
  - 阶段一：幕布 c18+6/c5+6、抓取、气竭按钮；无红光。
  - 阶段二：火球雨 c7 链尾 +10、金光火球两发之间禁止、气竭按钮、无幕布。
- 武器包：
  - 阶段一：陌刀默认；长窗切横刀打 light/follow，短窗/防守回陌刀（首版暂不回切，见 §10）。
  - 阶段二：横刀原生 light/follow/qishu/execute/整套。

## 5. 调度

### 5.1 硬禁手（T0）

串中、金光火球两发之间（c11 first+6）、火球雨第一发 +6、`k2:c30` 中串、幕布 covered、喝药、处决前摇、挨打后 1 秒、`decide(now)` 有防守按键到期：不动作。

### 5.2 判定

```
can_attack(action):
  if 特殊禁手窗 / 喝药 / 处决前摇 / 挨打<1s: false
  if group.next_share >= 0.2 and 距上次接触 < 30f: false
  if action == set and P(empty 154f) < 0.90: false
  if action == qishu and P(empty 70f) < 0.80: false
  if action == light and P(empty 42f) < 0.60: false
  if action == execute and not execute_button: false
```

- 长窗优先级：`execute` > `qishu`（火球雨尾/ok 低 share 长窗）> `light`（短窗）> `follow`（蓝盘）> `整套`（阶段转换）> `charge`（攒气，可选）。
- `P(empty)` 用离线经验表/组表查，不靠 tte。
- 阶段一武器 stance：切横刀前先确认窗口足够长（至少够 light 42f 或 follow 61f 的 q），一次切换尽量打多个动作；防守/短窗回陌刀（首版暂不回切，见 §10）。不要每个动作都切。
- 处决按钮窗优先 execute；没有按钮只 light。`qishu` 只在长窗；`整套` 只在阶段转换/开场；`charge` 只攒气。

## 6. 开关与日志

- 新增 `args.offense: "off" | "v2"`，默认 `"off"`；旧 `args.attack` 保留为 legacy 对照，验证完后删。
- trace 每帧加：`chainPos/chainLen/nextShare/weapon/atkTier/atkQ/atkReason/bossPx/lock/range`。
- 动作日志：press/land/cancel 时间、boss HP 前/后 2 秒、真气前/后、取消原因。
- `loop.py` 的 `gate` 目前按 `attack` 分组；新增/改成按 `offense` 分组（`s5_ab --by offense` 或等价），不要把 legacy `attack` 和新 `offense` 混在一起。

## 7. Gate（已批准）

### Stage 1：8 对 8，10 分钟/局（16 局，约 2.7 h）

- 两臂：`offense:"off"` vs `offense:"v2"`，fresh，交替。
- 安全：**挨打/分 ≤1.5**、致命应对 **≥90%**、金招按成卸 **≤3%**（按汇总接触算，不看 8 局均值）。
- 伤害代理：10 分钟 boss 掉血 **≥1 条（381 px，约 50% 中位总血）**；当前是 0.42 条。
- 动作统计：execute/qishu/light/follow 次数与成功率、取消原因。
- 不过安全线就停，不跑 Stage 2。

### Stage 2：8 局击杀确认（20 分钟上限，约 2.7 h）

- 只跑 `offense:"v2"`，fresh。
- **TTK 中位 ≤20 分钟（primary）**；**15 分钟 stretch**；至少 6/8 局在 20 分钟内击杀。
- 安全线与 Stage 1 相同。
- 20 分钟未击杀记删失，报告击杀率 + 10 分钟掉血，不硬推中位数。

### A/B 规模

- 8 对 8 能检测约 16.3% 的 damage 差（80% power，SD=11.7）；15% 用 12 对 12，10% 用 24 对 24。
- hits/min 局间 SD=0.79，8 对 8 检测不了 1.5 vs 1.8；安全性用汇总接触算卸势率。

## 8. 实施顺序

1. 设计文档 + plan/current 进展提交。
2. 子代理 C：实现 `lib/dufu-offense.js` + `dufu2.js` 接线 + trace 日志 + `offense` 开关；保留防守路径；至少 6 个防守场景 old-vs-new touch 对拍；加进攻 fake tests（execute 按钮、qishu 长窗、light 短窗、串中禁手、金光火球禁手、切武器 stance、取消原因）。
3. lead 复核 diff/测试/对拍；不通过不实机。
4. 子代理 D：同一时间只一个子代理碰 Pad；先 Stage 1，再 Stage 2。
5. 阶段二：Stage 1/2 过了以后单独 8 对 8、10 分钟；不套阶段一伤害。

## 9. 风险 / 停止条件

- 不降难度；只在演练场全自动；不点付费/确认类按钮。
- 不改老师规则：金光闪、红光卸、阶段一无红光、幕布走缝/快扫闪、火球雨先跑再闪、金光火球只闪。
- 不改关 2 阈值/分层结构；要改先问用户。
- 遇到幕布/抓取特殊机制、Stage 1 安全不过、Stage 2 gate 失败：停下来问用户，不自动降级。
- 进攻默认关；只有 Stage 1/2 都过才考虑改默认。
- 每批结束用 `contacts.json`/`result.json` 独立复算，不只看 `s5_ab`。

## 10. 首版实现状态（2026-11-01）

已落地、未上机：

- 新 `skills/lib/dufu-offense.js`（纯决策）+ `dufu-offense-table.js`（`next.share` 编译表）；`dufu2.js` 的 `args.offense: "v2"` 接线、contact 3 动作、trace 10 列、`result.offense` 日志；`args.offense` 默认 `"off"`，legacy `args.attack` 保留。
- 工具：`s5_offense_table.py` 重新生成 `next.share`；`s5_push.py` 已把两个新 lib 加入推送清单；`loop.py gate` 自动按 `offense` / legacy `attack` / `run` 分组。
- 测试：`pytest` 39 passed；`dufu2_scheduler` **34 条**；`dufu_offense` **13 条**；固定基线 `4c80b3c` 的 `offense:"off"` 对拍 12/12 场景逐条一致。
- 首版边界（有意保留）：
  - T4 `set` 只有接口，`dufu2` 恒传 `allow.set=false`；T5 `charge` 默认关，启用时才在陌刀窗口优先于切刀轻击。
  - 幕布 v1 **整段 `inCurtain` 封锁**，设计里的 c18+6 轻击窗暂缓；Stage 1 先看伤害是否够。
  - 阶段一首次切横刀后**不回切陌刀**；charge/set 默认关，回切只多 24 f 风险，若要严格回切再加状态机。
  - near 门沿用 legacy `dufu2` 的 **1500 ms**（不是旧 `dufu.js` 的 3 s）；ok / boss 血条下降刷新。
  - trace `range` 是 near 门代理 0/1，不是真实距离；`lock` 是锁图标。
  - 开场奇术按旧 `qsTick` 放行（boss 血条已出现、无 contact、15 s 内，P(empty70)=1）；可能远距离空放，Stage 1 观察。
  - 处决按钮 4 Hz 读取（最多 250 ms 延迟）；切刀 pending 在 3 s / 新 contact / 特殊窗 / near 过期时取消。
- **实机安全回归（2026-11-01）**：
  - 6 分钟单局 smoke（r185）：boss 381 → 238（约 37.5%），但 2.43 挨打/分、致命 86.8%；动作 17 light / 17 follow / 5 qishu / 1 execute。
  - 2 对 2、6 分钟（r186–r189，旧 q）：`off` 1.44 挨打/分、fatal 105/117 = 89.7%；`v2` **4.26 挨打/分、fatal 103/126 = 81.8%**，r189 3.2 分钟死亡。loop p50/p95 与 off 同量级，不是 CPU。
  - 已收紧 q 并加 horizon（见 §3.3）；**Stage 1 暂停**。
  - 新 q 2 对 2（r190–r193）：`off` **1.63 挨打/分、fatal 112/129 = 86.8%**；`v2` **2.99 挨打/分、fatal 122/139 = 87.8%**。v2 只剩 20 个动作（17 light / 2 qishu / 1 execute），6 分钟 boss 约 21%。q/horizon 降低了动作和伤害，但 hits/min 仍 >1.5；这批 off 自己也只有 86.8%，对局偏难。
  - 关键 bug：v2 的 **c11 窗口 10 个里 7 个挨打**，off 7 个里 0 个。`dufu1-table` 里 `k2:c11` 是 `dodge/unparryable/fatal`，不是普通招；已加 `goldNow`：goldSeq / 当前金 tell / 最近 c11·c40 接触（按表的 dodge/unparryable 语义）后 2.5 s 封锁，阶段一/二都生效。
  - q 取中间值 `.70/.80/.85/.85/.90`；测试 34/13/39。
  - c11 修复 + 中间 q 的 2 对 2（r194–r197）：`off` **2.25 挨打/分、fatal 118/134 = 88.1%、c11 11 窗 9 中**；`v2` **1.90 挨打/分、fatal 125/141 = 88.7%、c11 6 窗 0 中**；v2 6 分钟 boss 约 22%。v2 在这一批反而优于 off，c11 撞车已消失；伤害仍低，进入正式 Stage 1。
  - **Stage 1 6/16 中止**（2026-11-01）：loop 在 r203 后的 `fresh_reset` 停在“重伤/再次训练”页，Pad idle；非技能崩溃。
    - off：r198 1.84、r200 dead 2.63、r202 dead 3.54；3 局 2 死。r198 boss 381→381（0 伤害）。
    - v2：r199 1.83、r201 1.84、r203 2.04；3 局 0 死。10 分钟 boss 掉 104/172/142 px（27% / 45% / 37%）。
    - 部分 gate：off 2.90 挨打/分、fatal 196/232 = 84.5%；v2 2.20、fatal 320/362 = 88.4%；金 0/82、0/110；两臂都过不了 ≤1.5/≥90%。
    - 结论：**10 分钟 off 对照自己就死亡/超线，Stage 1 的 10 分钟安全门不成立**；不能用它判断进攻是否拖防守。Stage 1 中止，未跑 Stage 2；6 局已 ingest，Pad 5 个旧录像未动。
    - 下一步需定：6 分钟安全 A/B（沿用已验证的 6 分钟防守口径）+ 单独 10 分钟 v2 伤害/存活；或先重训防守提高 10/20 分钟存活；或放宽 10 分钟安全线。当前 v2 不是主要瓶颈，10 分钟防守寿命才是。
