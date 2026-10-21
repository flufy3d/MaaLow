# 独夫防守遥测：首轮结果（2026-10-20）

> **口径**：本文区分“日志事实”（事件时间、press lead、按钮光 px、HP 差）、“代理推断”（分类、俯卧/被按住）和“待人工确认”（按钮光是否等于卸势架势、某招是否真的不可卸）。没有写 `labels.json`，没有宣称人工确认。实现见 [telemetry-implementation.md](telemetry-implementation.md)。

## 1. 一句话结论

第一遍按“press 后 5–10f 按钮光”分类时，最大的一类是 `NOT_EXECUTED`（r749 26 条中 15 条；r748 21 条中 5 条），`NO_PRESS_STATE` 次之（r749 3 条、r748 8 条），`EXECUTED_UNPARRYABLE` 很少（r749 3 条、r748 1 条）。**但追加校验发现 5–10f 按钮光并不能区分成功/失败**：r749 里 `parry none` 的 press 在 1s 内有 54.8% 随后出现 ok，`lit` 是 57.2%；36 个被调度器判为 `- parry ... done ok` 的 press 在 5–10f 读数是 `none`。30 条录像代理标签（§12）进一步显示：hit 相关样本里 **0 条**在 hit 前有清楚架势，2 条 `STANCE` 都是对照；主问题集中在“状态/起手/时序”，不是“不可卸”。所以“按了没执行”这个结论目前**不成立**，下一步应先补可靠的执行读数，不能拿这批分类去调默认策略。

## 2. 数据与方法

| 数据 | 内容 | 用途 |
|---|---|---|
| `data/tmp/dense_pred/r749.run.utf8.json` | 2026-10-20 21:10 诊断跑，737 参数 + `telemetry:true` + `predMs:50`；dead，6184 looks，26 hit / 88 ok，253 parry / 58 dodge | 运行时 `press result` / `state` / `pred` 概率 |
| `data/tmp/dense_pred/r748.run.utf8.json` + `recordings/20261020-154901` | 旧 r748 诊断轮，21 hit / 45 ok，149 parry / 18 dodge；没有 telemetry | 用同一按钮光掩码离线重建 5–10f 读数 |
| `data/attack_triage/20261020/r748_review/`、`ground_review/` | r748 逐帧复核（代理证据） | 970 / 3947 的俯卧/被按住上下文 |

分类口径（严格按任务定义）：

- `NOT_EXECUTED`：该 hit 前 30f 内有 press，但 press 后 5–10f 的按钮光 < 阈值；
- `EXECUTED_UNPARRYABLE`：5–10f 内有光，press lead 在 4–22f，仍然中；
- `EXECUTED_TIMING`：5–10f 内有光，但 press 太晚（lead < 4f）或太早（lead > 22f），或光的首发在 hit 之后；
- `NO_PRESS_STATE`：hit 前 30f 没有可用的 press（幕布 / 倒地 / 被按住 / 硬直 / CD）；
- `MEASUREMENT`：灰屏、读条伪影等。

按钮光阈值：parry `[934,477,36,36]`、dodge `[906,656,36,36]`，`S<40, V>230`；parry ≥150 px、dodge ≥250 px（r748 标定：parry 空闲 p50 67、亮起 197–315；dodge 空闲 p50 93、白闪 535–1020）。r748 离线读的是录像帧，不是运行时截图；事件到录像帧的映射用 `(event_epoch − meta.started) × 30 / 1000`。

## 3. r749：运行时遥测逐条（26 hit，737 参数）

`result` 是 press 后 5–10f 的一次读取；`lit/none` 后面的 px 是原始值。`lead` = hit − press（帧）。

| event | t (s) | HP | press (lead) | result (5–10f) | state | 分类 | 备注 |
|---:|---:|---|---|---|---|---|---|
| 239 | 11.9 | 100%→96% | parry 7.5f | lit 250px | - | EXECUTED_TIMING | 光窗口跨接触，无法分早/晚 |
| 266 | 12.4 | 96%→91% | parry 11.9f | none 147px | - | NOT_EXECUTED | 147 接近阈值 |
| 1148 | 45.8 | 91%→82% | dodge 0.1f | none 90px | heavy | NOT_EXECUTED | 同帧 parry 8.3f 也 none |
| 2094 | 83.1 | 82%→75% | parry 20.9f | none 78px | - | NOT_EXECUTED | press 偏早 |
| 2480 | 102.9 | 75%→70% | dodge 13.4f | none 95px | - | NOT_EXECUTED | dodge 无光 |
| 2516 | 103.4 | 67%→65% | parry 2.8f | lit 275px | - | EXECUTED_TIMING | 太晚 |
| 2694 | 109.2 | 62%→59% | parry 3.1f | none 102px | - | NOT_EXECUTED | - |
| 3569 | 141.7 | 59%→54% | parry 17.5f | lit 204px | - | EXECUTED_UNPARRYABLE | 有光仍中 |
| 3626 | 143.7 | 54%→48% | parry 4.0f | lit 207px | - | EXECUTED_TIMING | 边界偏晚 |
| 3727 | 145.7 | 48%→40% | parry 3.7f | none 74px | heavy | NOT_EXECUTED | dodge 被 CD 挡 |
| 3815 | 149.6 | 39%→35% | dodge 14.6f | none 122px | - | NOT_EXECUTED | dodge 无光 |
| 3900 | 153.5 | 35%→22% | parry 0.1f | none 130px | heavy | NOT_EXECUTED | 130 接近阈值 |
| 4090 | 161.9 | 91%→84% | - | - | curtain | NO_PRESS_STATE | 幕布内无 press |
| 4322 | 175.9 | 83%→77% | parry 22.8f | none 73px | - | NOT_EXECUTED | press 偏早 |
| 4455 | 180.4 | 76%→72% | parry 13.5f | lit 218px | - | EXECUTED_UNPARRYABLE | 有光仍中 |
| 5018 | 199.0 | 71%→63% | parry 1.6f | lit 234px | heavy | EXECUTED_TIMING | 太晚 |
| 6031 | 237.3 | 63%→56% | - | - | curtain | NO_PRESS_STATE | 幕布内无 press |
| 6167 | 245.8 | 56%→51% | parry 5.7f | none 135px | - | NOT_EXECUTED | 135 接近阈值；幕布刚结束 |
| 6209 | 246.6 | 50%→45% | parry 15.2f | lit 230px | - | EXECUTED_UNPARRYABLE | 有光仍中 |
| 6308 | 250.6 | 45%→35% | - | - | heavy | NO_PRESS_STATE | 10.2%，无 press；俯卧/被按住 unknown |
| 6509 | 257.1 | 35%→32% | dodge 14.1f | none 146px | - | NOT_EXECUTED | dodge 无光 |
| 6540 | 257.4 | 30%→27% | parry 5.6f | none 75px | - | NOT_EXECUTED | 同帧 dodge 也 none |
| 6562 | 257.6 | 27%→24% | parry 1.1f | none 106px | - | NOT_EXECUTED | 太晚且无光 |
| 6755 | 263.8 | 22%→19% | parry 8.2f | lit 212px | - | EXECUTED_TIMING | 光窗口跨接触 |
| 6990 | 272.8 | 19%→10% | dodge 1.4f | none 94px | heavy | NOT_EXECUTED | 同帧 dodge 无光；早前 dodge 有光 |
| 7890 | 307.5 | 10%→3% | parry 4.1f | none 74px | curtain | NOT_EXECUTED | press 与幕布 onset 同帧 |

### r749 计数与 maxHP

按每条 hit 后 `stagger` 事件的 `drop X%` 相加（比 `hit` 文本里的取整百分比更准；最大 1 位小数）：

| 分类 | n | maxHP | 占 hit 数 |
|---|---:|---:|---:|
| NOT_EXECUTED | 15 | 0.899 | 57.7% |
| EXECUTED_UNPARRYABLE | 3 | 0.149 | 11.5% |
| EXECUTED_TIMING | 5 | 0.229 | 19.2% |
| NO_PRESS_STATE | 3 | 0.236 | 11.5% |
| MEASUREMENT | 0 | 0 | 0% |
| **合计** | **26** | **1.513** | |

r749 的 press 光统计：`parry lit` 138 / `parry none` 115；`dodge lit` 9 / `dodge none` 49。dodge 光很稀疏，`none` 不能当“没闪避”。

## 4. r748：21 条 hit 的离线重建

r748 没有 telemetry；下表用录像同一 ROI/掩码重建 press 后 5–10f 的最大光值，`first glow` 是 press 后第一次 ≥150 px 的帧数（只找 25f）。`state` 里的“幕布/重击”来自当时日志；970 / 3947 的“俯卧/被按住”来自既有视频复核（代理证据）。表里的 HP 百分比是 `hit` 文本的取整；下面的 maxHP 用 `stagger` 的 `drop X%`（例如 970/3947 文本显示 12%，精确 drop 是 11.4%）。

| event | t (s) | HP | press (lead) | glow 5–10f | first glow | state | 分类 | 备注 |
|---:|---:|---|---|---:|---|---|---|---|
| 189 | 9.0 | 98%→96% | dodge 7.2f | 555 | 10f | - | EXECUTED_TIMING | 光在 hit 后 |
| 235 | 9.5 | 93%→91% | parry 10.3f | 247 | 5f | - | EXECUTED_UNPARRYABLE | 光在 hit 前 5f 仍中 |
| 397 | 13.3 | 88%→80% | parry 1.1f | 222 | 7f | heavy | EXECUTED_TIMING | 光在 hit+6f |
| 546 | 19.7 | 79%→69% | parry 5.3f | 84 | 12f | heavy | NOT_EXECUTED | 5–10f 无光，首发 hit+6.7f |
| 890 | 34.4 | 69%→64% | dodge 7.8f | 102 | none≤25f | - | NOT_EXECUTED | dodge 无光 |
| 970 | 38.4 | 64%→52% | parry 18.0f | 57 | 25f | heavy | NO_PRESS_STATE | 俯卧/被按住（unknown）；严格口径为 NOT_EXECUTED |
| 1309 | 54.0 | 52%→45% | parry 28.4f | 62 | none≤25f | heavy | NO_PRESS_STATE | 幕布刚结束；旧 press 太早 |
| 2001 | 85.2 | 45%→38% | - | - | - | curtain | NO_PRESS_STATE | 幕布内无 press |
| 2074 | 89.9 | 38%→31% | - | - | - | curtain | NO_PRESS_STATE | 幕布内无 press |
| 2314 | 99.0 | 94%→84% | dodge 15.2f | 86 | none≤25f | heavy | NOT_EXECUTED | dodge 无光 |
| 2404 | 103.6 | 83%→75% | parry 0.1f | 203 | 8f | heavy | EXECUTED_TIMING | 光在 hit+8f |
| 2712 | 120.3 | 75%→70% | parry 17.3f | 70 | 18f | - | NOT_EXECUTED | 5–10f 无光；首发 hit+1f |
| 2735 | 120.9 | 70%→65% | parry 8.6f | 198 | 9f | - | EXECUTED_TIMING | 光在 hit−0.5f |
| 2806 | 123.8 | 65%→58% | - | - | - | curtain (just over) | NO_PRESS_STATE | S1 .96 无 plan；幕布内 |
| 2919 | 127.4 | 57%→50% | parry 1.0f | 200 | 7f | curtain | EXECUTED_TIMING | 光在 hit+6f |
| 3337 | 143.1 | 50%→42% | parry 1.9f | 191 | 9f | heavy | EXECUTED_TIMING | 光在 hit+7f |
| 3605 | 158.2 | 42%→35% | - | - | - | curtain | NO_PRESS_STATE | 幕布内无 press |
| 3638 | 160.3 | 35%→28% | - | - | - | curtain | NO_PRESS_STATE | 最后一次 parry 在 46f 前 |
| 3872 | 172.3 | 28%→23% | dodge 10.3f | 90 | none≤25f | - | NOT_EXECUTED | dodge 无光 |
| 3947 | 176.3 | 23%→11% | parry 1.6f | 214 | 7f | heavy | NO_PRESS_STATE | 俯卧/被按住（unknown）；严格口径为 EXECUTED_TIMING |
| 4630 | 207.5 | 11%→6% | parry 7.9f | 234 | 9f | - | EXECUTED_TIMING | 光在 hit+1f |

### r748 计数与 maxHP

同样用 `stagger` 的 `drop X%`：

| 分类 | n | maxHP | 占 hit 数 |
|---|---:|---:|---:|
| NOT_EXECUTED | 5 | 0.353 | 23.8% |
| EXECUTED_UNPARRYABLE | 1 | 0.028 | 4.8% |
| EXECUTED_TIMING | 7 | 0.454 | 33.3% |
| NO_PRESS_STATE | 8 | 0.642 | 38.1% |
| MEASUREMENT | 0 | 0 | 0% |
| **合计** | **21** | **1.477** | |

如果把 970 / 3947 按“严格 press-result”算（不看俯卧/被按住），970 → `NOT_EXECUTED`，3947 → `EXECUTED_TIMING`，则四类变成 `NOT_EXECUTED 6 / 0.467`、`TIMING 8 / 0.568`、`NO_PRESS_STATE 6 / 0.414`、`UNPARRYABLE 1 / 0.028`。两种口径的结论方向不变：执行/状态占大头，`UNPARRYABLE` 很小。

## 5. 四个已知案例的证据

### 5.1 r748 2712（横向扫击，75%→70%，5.1%）

日志事实：

- 2708（119.9s）`S1 0.49 ... def1 dodge`；2709 `def1 parry`；2710 `S1 0.56 ... def1 parry`。
- 2701（119.7s）`press parry k0 fut c+13f pred k0`，距 hit **17.3f**。
- press 后 5–10f 的 parry 光最大 **70 px**（基线 60–70）；第一次 ≥150 px 在 press 后 **18f**，即 hit **+1f**。
- 没有幕布 / stagger；hit 后 `escape parry at +300 ms`。

分类：**`NOT_EXECUTED`**。press 确实发了，但 5–10f 内没有按钮光；光直到 hit 之后才出现。旧的“def1=dodge、计划=parry、类型/方向错”解释在这条数据上**没有得到支持**：计划确实是 parry，问题更像是“按早了/游戏没有在窗口内起架势”。这是代理推断，待视频人工确认。

### 5.2 r748 970（64%→52%，11.4%）

日志事实：

- 955（38.18s）`press parry k0 fut c+14f pred k0`，距 hit **18.0f**。
- 5–10f 内 parry 光最大 **57 px**；第一次 ≥150 px 在 press 后 **25f**（hit+5f）。
- hit 后 `stagger 500 ms (drop 11.4%)`、`escape skip (heavy)`。
- 既有 `r748_review` / `ground_review` 记录：玩家俯卧/被按住（代理证据）。

分类：**`NO_PRESS_STATE`（俯卧/被按住，unknown）**。严格按 press-result 是 `NOT_EXECUTED`；状态口径说明当时的 press 不代表可行动。运行时没有俯卧检测，只能靠 `hit`/`stagger`/`escape skip (heavy)` 时间近似。

### 5.3 r748 3947（23%→11%，11.4%）

日志事实：

- 3931（175.93s）`press parry k0` 距 hit 16.6f；3943（176.29s）`press parry k1` 距 hit **1.6f**。
- 近端 press 后 5–10f 光最大 **214 px**；第一次 ≥150 px 在 press 后 **7f**，即 hit **+5f**。
- `stagger 500 ms (drop 11.4%)`、`escape skip (heavy)`；既有复核记录俯卧/被按住。

分类：**`NO_PRESS_STATE`（俯卧/被按住，unknown）**。严格 press-result 是 `EXECUTED_TIMING`（光在 hit 之后）；两种口径都不支持“可行动但卸势失败”。

### 5.4 r748 2806（65%→58%，6.7%）

日志事实：

- 2772（122.07s）`curtain image: panels + edge` 进入幕布。
- 2796（123.288s）`S1 0.96 bin 3(10-12) c1 +12f def1 parry ...`；2801 `S1 0.68`；2802 `S1 0.38`。
- 没有 plan / press：`inCurtain` 时 `syncK` 被跳过。
- 2803（123.694s）`curtain over`，距 hit 仅 4f；2806（123.828s）hit。

分类：**`NO_PRESS_STATE`（curtain）**。这确认了旧诊断：不是 `off` 门控，而是幕布状态让计划根本没有建立。S1 0.96 说明模型看见了，但调度器在幕布里主动不排 plan。

## 6. 分类敏感性与读数限制

1. **5–10f 单次读取会漏晚到的光**。r748 里 546 / 2712 / 970 的第一次 ≥150 px 分别在 press 后 12 / 18 / 25f，严格 5–10f 口径都记 `none`；如果实际架势在 11–18f 才出现，`NOT_EXECUTED` 会偏高。这是本轮最大的测量风险。r749 没有录像，不能补看这些 press 的后续帧。
2. **阈值附近的 `none` 不是确定的“没亮”**。r749 的 266（147 px）、3900（130 px）、6167（135 px）都贴近 150；若把阈值降到 120，这 3 条会变成 `lit`（其中 266/6167 的 lead 在 4–22，分类会从 `NOT_EXECUTED` 变成 `EXECUTED_UNPARRYABLE`，3900 仍偏晚）。按钮 px 已原样保留，复核时可重判。
3. **dodge 光非常稀疏**。r749 58 次 dodge 只有 9 次 ≥250 px；r748 18 次只有 4 次明显白闪。`dodge none` 不能证明没有进入闪避，只能说明按钮没有明显白闪。
4. **按钮光 ≠ 卸势架势**。parry 光可能是按键动画、受击白闪或接触特效；`parry_ok` 模板又是“重击派生”菱形，不是逐次架势。`stance=unknown` 是真实未知，不能把 `lit` 当作“卸势成功”。
5. **俯卧/被按住没有运行时检测**。970 / 3947 的 `NO_PRESS_STATE` 依赖既有视频复核（代理证据），不是 telemetry 自己判出来的；`stagger control=unknown` 只能给出时间近似。
6. **两轮不可直接比**。r749 是 26 hit / 88 ok / dead，r748 是 21 hit / 45 ok / dead；参数、模型调用、幕布/气竭阶段和血量都不同。分类计数只能看方向，不能当通关率或总体比例。

## 7. 下一步建议（只基于数据，不直接改默认）

1. **做一次“架势/状态”人工标定，而不是继续用按钮光**：从 r750（和 r748）抽 30 个 press，按 press−2 / +0 / +5 / +8 / +10 / +12 / +15 / hit 抽帧，标 `STANCE`（清楚的横向持刀架势）/ `NO_STANCE`（站立但没起架势）/ `DOWN`（俯卧、被击飞、受击硬直）/ `UNKNOWN`（遮挡/特效）。只标 hit 前 30f 内有 press 的样本，先回答“hit 前到底有没有起架势、当时能不能动”。
2. **按标定结果重算三类占比**：`STANCE 且 hit` 才进入“执行了仍中/时序”分支；`DOWN` 归状态；`NO_STANCE` 才是真正需要研究的执行失败。没有这 30 个标签，任何 `NOT_EXECUTED` 比例都不能用来改 lead。
3. **幕布做一次 log-only 的影子结论 + 受控实验**：r750 的 `would-plan` 给出 18 条；其中 81786/86337 在幕布内、92628/92770/93169/123103 在幕布结束前后，都有 `k0/k1 parry|dodge` 的目标。先确认这些目标是否真的在窗口内（用视频/标签），再考虑一个“幕布内允许 plan（parry + dodge）”的默认关闭 A/B；不要直接开旧 `curtainParryPlan`（它只排 parry，且旧 A/B 净零）。
4. **`parry_ok` 不能当成功信号**：r750 的 137579/204491 序列里它长期 0.98–0.99，明显是处决/重击派生图标，不是逐次卸势反馈。后续如果要用，必须限定非处决窗口并做正负对照。
5. **不要重新启用已否决的开关**：本轮没有产生支持 `curtainDodgeFirst` / `defDodgeReplan` / `offDefend` 的新证据；`curtainParryPlan` 的旧 A/B 仍是净零。先做标签和幕布影子，再谈开关。

## 8. 限制与待确认

- 所有分类是**代理推断**，不是人工确认；没有写 `labels.json`。
- r749 没有录像；r748 有录像但离线读数与运行时截图存在采集差异（H.264、时间映射），按钮 px 可能相差几帧。
- `press result` 只覆盖 parry/dodge；potion、offense、走路没有执行反馈。
- `state` 的 `off` 是派生状态（`offHold`/`offWalking`/`offUpAt`/`offOpenAt`），不是游戏内动作真值。
- 倒地/被按住、不可卸、架势起止帧都仍需视频或人工复核。

## 9. 追加校验：5–10f 按钮光不是执行真值

在完成上面的分类后，用同一份 r749 数据把 `press result` 与后续 `ok` / `done ok` 做了交叉检查：

| 指标 | `parry lit` (n=138) | `parry none` (n=115) |
|---|---:|---:|
| press 后 600ms 内有 ok | 65 / 138 = **47.1%** | 53 / 115 = **46.1%** |
| press 后 1s 内有 ok | 79 / 138 = **57.2%** | 63 / 115 = **54.8%** |
| 调度器 `- parry ... done ok` 归因 | 40 | **36** |
| `parry_ok` 模板分均值 | 0.32 | 0.275 |

结论：

- `none` 的 press 并不比 `lit` 更容易失败；36 个明确 `done ok` 的 press 在 5–10f 根本没有按钮光。按钮光在这个窗口里**不是执行/成功的判别信号**，更可能是按键动画、受击白闪、接触特效或采样相位差异。
- 因此 §3/§4 的 `NOT_EXECUTED` 分类只能作为“当前读数下没有光”的记录，**不能解释为“游戏没有执行”**；`EXECUTED_UNPARRYABLE` 也不能因为“有光”就升格为不可卸证据。
- `ok` 本身仍有玩家输出混淆（审计：332 条 ok 中 58% 有输出/蓄力），但 lit/none 两组 ok 率几乎相同，这个混杂不会把差异抹平成 1 个百分点；更像按钮光与执行无关。
- 下一步应先解决“什么读数代表卸势架势/执行”，再重跑分类；在解决之前，不建议基于本文的 `NOT_EXECUTED` 比例改默认 lead、阈值或开关。

## 10. 录像复核：按钮光在两种方向上都会错

r750 录像 `20261020-215616`（12881 帧，429s）和 r748 录像都做了逐帧抽图。结论不是“按钮光有噪声”，而是**它和架势不是同一个东西**：

| 案例 | press / 结果 | 5–10f 光 | 视频（逐帧） | 结论 |
|---|---|---|---:|---|
| r750 13196 | parry，`none/none`，900ms 内无 hit/ok | 133 px | press+5..+10 清楚横向持刀架势，之后收势 | **假阴性**：有架势但没光 |
| r748 709（press 26319） | parry，ok +334ms | 66 px | press+5..+10 同样清楚横向持刀架势 | **假阴性**：有架势但没光 |
| r750 116413 | parry，`lit/lit`，ok +496ms | 234/253 px | press+5..+18 玩家倒地/被 Boss 压着，未见架势 | **假阳性**：光在倒地时亮 |
| r750 15031 | parry，`none/none`，ok +496ms | 74 px | press+0..+12 玩家被击飞/倒地；press+10..+12 按钮反而亮 | **假阳性 + 采样漏光** |
| r750 155568 | parry，`lit/none`，hit +6.3f | 209 px | press+0..+6 玩家在受击/特效中，未见架势；光更像受击闪 | **不是架势** |
| r750 197208 | parry，`none/none`，hit +6.1f | 132 px | press+0..+6 玩家在受击/低姿态 | **不是架势** |
| r750 92733 | parry，`none/lit`，hit +37ms | 130→213 px | 晚光出现在受击之后 | **晚光是受击特效** |
| r748 546 | parry，`none`，heavy hit | 84 px | press+10..+15 玩家清楚俯卧；+12 按钮亮 | **假阳性**：光在俯卧时亮 |
| r748 235 | parry，`lit`，hit | 247 px | press+5..+12 玩家在受击/低姿态 | **假阳性** |

直接结论：

- 5–10f 的 `lit` **不是**“有架势”，`none` **不是**“没架势”；两种错误都在录像里出现。
- 14–18f 的 `press late` 也不能修正：r750 15031 的光在 10–12f（两个窗口之间），r750 92733 的晚光是受击特效。
- 角色外观/场景会变（r750 后半段出现白光/红衣/绿金 Boss），简单的全屏模板或固定 ROI 不可靠。
- 因此 §3/§4/§5 的 `NOT_EXECUTED`/`UNPARRYABLE` 数字只能当作“按钮光读数”，不能作为策略依据。

## 11. r750 验证跑（第二次采样 + 幕布影子）

- `data/tmp/dense_pred/r750.run.utf8.json`；录像 `recordings/20261020-215616`；dead，4752 looks，25 hit / 47 ok，177 parry / 38 dodge。
- 215 条 `press result` + 215 条 `press late`（每次 press 两次读）；`would-plan` 18 条；`ms.reads` p95 6ms，`loop` p95 96ms。
- 早/晚组合：`lit/none` 71、`none/none` 84、`none/lit` 14、`lit/lit` 8。`none/lit`（晚光才亮）在 600ms 内 ok 只有 7.1%，hit 21.4%；`lit/lit` ok 75%、hit 0%——但样本只有 8，且晚光常是受击特效，不能反推“晚光=成功”。
- 按早读的旧口径：`NOT_EXECUTED` 18 / 1.04 maxHP、`NO_PRESS_STATE` 4 / 0.213、`EXECUTED_TIMING` 2 / 0.056、`EXECUTED_UNPARRYABLE` 1 / 0.071。这个分布和录像复核冲突，进一步说明按钮光口径不可用。

`would-plan`（只在幕布内、不建 plan）的证据：

| hit | 时间 | 当时状态 | 前 1.2s 的 would-plan | 备注 |
|---:|---:|---|---|---|
| 81786 | 81.8s | 幕布内 | `k1 parry c+15f / k2 parry c+17f` | 76ms 后中 |
| 86337 | 86.3s | 幕布内 | `k0 parry c+12f` | 302ms 后中 |
| 92628/92770/93169 | 92.6–93.2s | 幕布结束后 0.1–0.7s | `k0 dodge c+9f / k1 dodge c+16f / k2 dodge c+22f`（92.16s，幕布内） | 连续 3 hit |
| 123103 | 123.1s | 幕布结束后 0.38s | `k0 dodge c+13f`（122.67s，幕布内） | 10.2% |
| 155777 | 155.8s | 幕布内（进入后 64ms） | 之前只有 `none` | 首扫，没有 plan |

这说明幕布抑制 plan 确实漏掉了可计划的目标：4 组（6 条 hit）在幕布内/刚结束时已经有 `parry/dodge` 的 would-plan，其中 2 组是 dodge（旧 `curtainParryPlan` 只排 parry，不会覆盖）。但 would-plan 只是“如果算的话”，还没有证明按下就会中/能防住；需要标签和受控实验。

## 12. 30 条架势/状态标定（代理标签）

从 r750 选 15 条、r748 选 12 条 hit 前 30f 内有 parry press 的样本，另加 3 条对照（r748 709、r750 13196、r750 116413），共 30 条。每条看 press−1 / +5 / +10 / 结果帧（hit 或 ok），标 `STANCE`（清楚横向持刀架势）/ `NO_STANCE`（站立但没起架势）/ `DOWN`（俯卧、被击飞、受击硬直）/ `UNKNOWN`（遮挡/特效）。原始标签和帧号在 `data/tmp/telemetry_review/labels30.json`，contact sheet 在 `data/tmp/telemetry_review/label_*.jpg`。

### 总数

| 标签 | n | 说明 |
|---|---:|---|
| STANCE | 3 | 3 条都是对照/成功卸势，不是 hit（r748 709 ok、r750 13196 无结果、r750 116413 ok） |
| NO_STANCE | 16 | 站立但前 10f 没有清楚架势 |
| DOWN | 9 | 俯卧/被击飞/受击硬直；其中 2 条是金光抓（GRABBED） |
| UNKNOWN | 2 | Boss 披风/特效挡住（970、3947） |

**27 条 hit 相关样本里没有一条在 hit 前出现清楚的横向持刀架势**（3 条对照/成功案例是 `STANCE`）。这不是“有架势但不可卸”的证据；它说明 hit 前的执行/状态还没被正确读数。

用户复核修正了 5 条（见 §15）：116413 其实是成功卸势（`STANCE`），96597/100541 是金光抓后期（`DOWN/GRABBED`），201663 是突进+受击（`NO_STANCE/ACTION_LOCK`）。

### 只看 k0（同一接触）的 9 条 hit

| 标签 | n | 案例 |
|---|---:|---|
| STANCE | 0 | — |
| NO_STANCE | 6 | 2712、2735、4630、2919、1446、3996 |
| DOWN | 2 | 1653、3868 |
| UNKNOWN | 1 | 970 |

6 条 `NO_STANCE` 又能分成两组：

- **press 偏早但没架势**：2712（lead 17.3f）、2735（8.6f）、4630（7.9f）。frame 复核显示：
  - 2712：press+10..+25 都没有横向架势；按钮在 hit 附近亮的是受击/特效，不是架势。press 17f 提前也没有产生架势。
  - 4630：press+10 还没有；press+15 才出现横向架势，但 hit 在 press+7.9f，架势已经晚了。
  - 2735：架势在 press+10 左右出现，hit 在 press+8.6f，晚约 1–2f。
- **press 偏晚**：2919（lead 1.0f）、1446（1.5f）、3996（4.7f）。press 已接近或落在接触上，没有时间起架势。

### 解释

- **架势外观可能随阶段/外观变化**：r748 的横向持刀架势在 r750 后半段（红光/绿金 Boss、玩家外观变化）并不以同样形状出现；同样的“横向持刀”标签在 r750 的 5 条干净早期 press 里 0 条命中，但不能据此说 r750 没起架势，可能是阶段/外观/动作不同。跨轮/跨阶段不能直接比，后续标定要先记录阶段/外观。
- 当前最大问题不是“不可卸”，而是 **hit 前没有可用的架势**：要么 press 太晚，要么架势起手太慢（约 5–15f），要么玩家已经在 DOWN。
- 2712 是最关键的反例：press 17f 提前仍然没有架势，说明不是简单“再早一点”能解决；可能是输入被忽略、角色在别的动作里，或架势只在某个窗口才出现。
- 4630/2735 更像“架势起手慢”：press 8–9f 提前，架势在 hit 后 1–2f 才出现。
- **但 2712 不是所有早期 press 的通病**：另抽了 10 条“k0、c+≥10、前后 1s 无 hit/ok”的干净 press，r748 的 5 条里有 3 条在 +10..+15 出现了清楚的横向架势（p5562、p15476、p58861），1 条 `NO_STANCE`，1 条 `UNKNOWN`。说明早期 press 是能起架势的；2712 需要单独看当时角色状态/输入是否被忽略。
- 因此下一步必须把 `NO_STANCE` 再分成 `STANCE_LATE`（架势出现但晚）和 `NO_STANCE_IGNORED`（一直没有架势），否则 lead 调整会继续盲调。

### 下一步（基于这 30 条）

1. 把 k0 样本扩到 30 条，专门看 **press 偏早（lead >= 8f）** 的 case：抽 press+5/+10/+15/+20/+25，标 `STANCE_READY`（hit 前出现）/ `STANCE_LATE`（hit 后出现）/ `NO_STANCE`（一直没有）。这能直接区分“起手慢”和“输入被忽略”。
2. 对 `DOWN` 的 8 条，回看前一击的 drop 和 down 时长；如果 hit 前 0.5–1.5s 都在 down，调度器应按状态跳过，而不是继续发 parry。
3. `UNKNOWN` 的 4 条（970、3947、2549、2635）不要计入执行率；需要换视角/录像或人工确认。
4. 在完成 1–2 之前，不改默认 lead、不加防守开关；幕布 would-plan 的 A/B 也等标签完成后再做。

## 14. 阶段限制：late phase 的自动架势标定不可靠

r750 后半段（约 90s 后，玩家外观变红/白、Boss 绿金、特效密集）出现两个新问题：

- **架势外观不同**：r748 的“横向持刀”在 late phase 的干净早期 press 里 0/5 命中；不一定是没起架势，可能是阶段/外观/动作不同。
- **多次 press 重叠**：例如 r750 201663 的 `ok` 归因给该 press，但 press−1 帧已经有横向架势（来自前一次 press），无法把这次 ok 单独归因给 201663。
- **特效遮挡**：116413/2549/2635 等被爆炸、披风、白光盖住，只能 `UNKNOWN`。

因此目前可下的结论只限 **early phase / 单次 press**：

- 干净早期 k0（c+≥10、前后 1s 无 hit/ok）的 r748 5 条里 3 条在 +10..+15 出现横向架势；说明早期 press 是能起架势的。
- k0 hit 的 9 条里 0 条在 hit 前有清楚架势；其中 2712 是“17f 提前仍无架势”（输入可能被忽略），4630/2735 是“架势在 hit 后 1–2f 才出现”（起手慢），2919/1446/3996 是“press 太晚”。
- late phase / 重叠 press 的 stance 标签暂不作为执行率；需要阶段专用参考或一个小的状态分类器。

## 15. 用户复核（2026-10-21）

用户逐条看了 A 包（`data/tmp/telemetry_review/help_A/`），修正/确认了 5 条。原始记录在 `data/tmp/telemetry_review/user_review.json`。

| case | 用户标签 | 用户描述 | 机制 |
|---|---|---|---|
| r750 201663 | `NO_STANCE / ACTION_LOCK` | “刚刚点的突进进入了一小下 然后挨了boss一下 估计是那时候按了卸势没用” | 自己的突进/动作中按 parry 被吞；不是架势问题 |
| r750 116413 | `STANCE / STANCE_OK` | “没倒地啊 接的不错 卸势成功了的” | late phase 也能成功卸势；画面低姿态不等于 DOWN |
| r748 4630（207252） | `NO_STANCE / HITSTUN` | “没卸势动作 挨打僵直了” | 挨打僵直，没有起架势 |
| r750 96597 | `DOWN / GRABBED` | “金光技能抓人 已经被抓住了 按啥都没用了 要被抓之前 闪避才可以 这个伤害是延迟的 金光抓 抓过来 玩家倒地 然后BOSS再补刀 扣血” | **金光抓**：parry 无效；必须抓之前闪避；HP 掉血是延迟的 |
| r750 100541 | `DOWN / GRABBED` | “和上面一样 金光抓人 这画面是被抓后期了 无力回天的” | 同上；这条 tell 没报 grab，def1 是 unknown |

对下一步的含义：

1. **金光抓要单独处理**。96597 有 `tell flare_grab`，scheduler 在 96009 按了 anchor dodge（距估计接触 22f），之后 96596 的 fut dodge 太晚、96597 的 parry 完全无效；100541 则 `tell none / def1 unknown`，scheduler 默认排了 parry。抓人被抓住后再按任何键都没用，正确做法是抓之前闪避。下一步要量化：anchor dodge 是太早/被 CD 吃掉，还是没执行；以及 no-tell grab 能不能用金色 VFX/动作模板提前识别。
2. **自己的动作锁**：201663 是突进/动作中按 parry 被吞。`press result` 目前只记游戏结果，不记当时 `offBusyUntil`/offense 动作；下一步应在 press 时记录 `off` 状态，统计“防守键落在自己动作里”的比例。
3. **late phase 的低姿态不一定是 DOWN**：116413 被我们误标为 DOWN，用户确认是成功卸势。后续不要把“玩家低/特效多”直接当倒地，至少要看 Boss 是否在抓/玩家是否有受击硬直。
4. **不要把 `ok` 都当成功**：201663 的 `done ok` 被用户描述为“按了没用”，ok 很可能是突进/输出造成的真气下降；116413 的 ok 才是成功卸势。`ok` 仍需过滤输出/动作。

### 金光抓的两条日志事实

- **96597**：`tell flare_grab` 首报 95820；anchor dodge 计划 95923（at+30ms），实际 press 96009（首报后约 5.7f，`c+22f`）；之后 96596 的 fut dodge 太晚，96597 的 parry 完全无效，96604 才掉血。用户说抓人后按啥都没用，伤害延迟。
- **100541**：附近 `tell none`、`def1 unknown`（p≈0.9）；100094 排 parry k0，100541 排 parry k1，100622 掉血。用户说画面已经是抓后期；抓的起手在 100200 之前，两个 parry 都在抓之后。
- 结论：金光抓需要**抓之前**的 dodge，parry 无效；96597 有 tell 但 anchor 可能太早/太晚，100541 则没有 tell。要修这条，先要知道金光抓的起手/判定相对 tell/金色 VFX 的时间，以及 no-tell 抓能否用模板提前识别。

### 录像上的抓取起手（代理观察）

- **96597**：95700ms 有一条横贯屏幕的金色亮线（抓取起手/VFX）；95800–95900 玩家已经被压到低姿态；95820 才是 `tell flare_grab` 首报；anchor dodge 实际在 96009（金线后约 9f、tell 后约 5.7f）；玩家说“没看到闪避动作，已经被抓了”。也就是说 **anchor 很可能已经在抓取之后**，不是“闪避早了”。
- **100541**：99000–100200 的画面主要是 Boss 披风/金色护甲，玩家在 100000 左右已经不可见/被抓；`tell` 全程 `none`，def1 unknown≈0.9。抓的起手在视野里没有稳定、容易模板化的金色手掌；这条更像“被 Boss 动作/镜头吃掉”，不是当前 tell 能覆盖的。
- 用户补充：“抓的瞬间前 应该是；我有时候闪避早了还是被抓”——窗口很窄，早了也会被抓。96597 的 anchor 在 tell 后 5.7f 已经晚了；但把 anchor 提前太多也可能因为 i-frame 过期而失败。下一步应做 **anchor 0/1/2 的受控 A/B**，而不是一次改死。

### r751：flare_grab anchor = 0 的实测

`data/tmp/dense_pred/r751.run.utf8.json`，录像 `20261021-001130`，同 737 参数，只把 `flareAnchor.flare_grab` 从默认 4 改成 0。dead，3411 looks，27 hit / 44 ok，124 parry / 34 dodge；158 条 `press result`。

本轮的 `tell flare_grab` 段与 anchor press：

| tell 首报 | anchor press | press result | 附近 hit | 备注 |
|---:|---:|---|---:|---|
| 16861 | 16948 dodge c+12 | `none 116px`，busy 0 | 21770 | 4.8s 后掉血，像抓取延迟伤害 |
| 27399 | 27497 dodge c+22 | `lit 991px`，busy 443ms | 28155 | 光已亮，但 0.75s 后仍掉血（可能是抓后补刀） |
| 61724 | 61811 dodge c+17 | `none 113px`，busy 447ms | 无近 hit | 自己的动作忙，dodge 被吞 |
| 110835 | 111084 dodge c+9 | `none 122px`，busy 0 | 113564 / 113929 | 2.5–2.8s 后连续掉血 |
| 135714 | 135768 dodge c+14 | `none 117px`，busy 0 | 136195 | 0.4s 后掉血 |
| 130518 / 135799 | 无 anchor press / parry | - | 132256 / 136195 | tell 有，但没形成有效 dodge |

结论：**anchor 0 仍然不够**。

- 4 次可用的 anchor dodge 里 3 次 `none`（16848/111084/135768），busy=0，说明不是自己的动作锁，更像抓取已经生效、dodge 被游戏忽略。
- 唯一 `lit` 的 27497 仍在 28155 掉血，可能是抓取后的补刀，dodge 只躲过了第一段。
- tell 首报本身可能已经晚于金色亮线（r750 96597 的金线约在 tell 前 4f），所以把 anchor 从 4 改到 0 只是提前 4f，仍不够。
- 下一步不是继续调 anchor，而是做**金色亮线的逐帧图像 cue**（或更早的抓取预测），让 dodge 在 tell 之前/同时发出；no-tell 的 100541 仍需要另一条检测路径。

离线用 `FLASH` 金色掩码扫 r750 96597 段：95600–95750ms 有 780px 宽、23k–49k px 的金色横线，比 `tell flare_grab` 首报 95820 早约 4–10f；这就是比 tell 更早的 cue。100541 段没有同样的金线（最大 count 只有 ~3k），所以 no-tell 抓需要另一条路径。已在 telemetry 里加 **log-only `goldline` on/off**（逐帧、只记日志、不 press），测试 22 PASS；下一步先跑一轮确认设备上的 `color` 读数能复现这条金线，再考虑默认关闭的 `goldLineDodge`。

## 16. r752：goldline 的设备验证（2026-10-21）

> 这是**第一次**在设备上跑带 `goldline` 日志的一轮。r748/r750/r751 的 run JSON 里 **0 条 `goldline` 事件**；之前关于这三轮的金线数字都是离线扫 mp4 的代理测量，不能当设备读数。

- 录像：`recordings/20261021-002639`（601s；skill 实际跑 298s 后 dead，录像后段是死亡页）。
- 参数：737 + `telemetry:true` + `predMs:50`，默认 `flareAnchor`（`flare_grab:4`, `flare_other:14`）。
- 结果：28 hit / 80 ok，199 parry / 46 dodge；`loop` p95 121ms（r750 96ms），`reads` p95 4ms。
- run：`data/tmp/dense_pred/r752.run.utf8.json`。

### 16.1 设备读数

`goldline` 在 298s 内出现 **27 段**（54 条 on/off）。宽/计数从 330–780px、5004–46282px，和 r750 离线扫到的金线量级一致，说明设备 `color` 能复现这类金色横线。

| 关系（±1s 内） | 段数 | 说明 |
|---|---:|---|
| 有 `tell flare_grab` | 11 | 其中 8 段是同一批 tell 的首报/尾段 |
| 有任意 `hit` | 13 | 包括普通金招、金光抓、处决/特效 |
| 有 `flare_other` tell | 12 | 不是抓取 |
| 无 tell、无 hit | 6 | 纯特效/空放 |

- 金线相对 `tell flare_grab` 首报的偏移：**−615、−342、−266、−157、−27、−25、+21、+213ms**（约 −18.5…+6.4f）。**不是稳定提前**；r750 96597 的 −220ms 只是其中一个样本。
- 8 段抓取相关金线里，只有 2 段在 tell 前 ≥6f；3 段在 tell 后 ≤1f；3 段与 tell 同时/略后。
- 金线本身不是抓取专属：r752 的 27 段里，只有 11 段靠近 grab tell；r750/r751 的离线扫描同样是 25/18 段里只有 6/4 段靠近 grab tell，更多靠近 `flare_other`（详见 §19）。

### 16.2 结论（日志事实 + 录像代理观察）

- **goldline 能复现，但不能单独作为“金光抓”的触发器**。它更像 Boss 金色武器/金招的通用 VFX；宽度 780px 也不唯一（普通金招同样满宽）。
- 如果按每个上升沿都 dodge，r752 会多按 **27 次/298s ≈ 5.4 次/分**，其中大部分不是抓取；会占用游戏 dodge CD，反而可能吞掉真正的 tell/fut dodge。
- 因此 **不启用 `goldLineDodge`**，也不把它作为默认候选。保留 `goldline` 只读日志，用于以后按“金线 + 其他条件”细分；当前没有证据支持它单独触发。

## 17. 抓取时序：anchor 太早，`c1` 跟的是延迟伤害

> 本节“catch 帧”是**代理看录像**的估计（玩家开始被拉/镜头切近景/进入金色旋风的第一帧），不是人工逐帧认证。原始帧在 `data/tmp/telemetry_review/r752/*_fine.jpg`，表在 `data/tmp/telemetry_review/r752/grab_catch_labels.json`。

r752 的 8 段 `tell flare_grab` 加上 r750 96597 / 100541：

| case | tell | `c1` | 金线 onset | anchor press / 结果 | catch（代理） | hp drop | tell→drop |
|---|---:|---:|---:|---|---:|---:|---:|
| r752 20759 | 20759 | 13f | −10f | 无（fut dodge +3f） | **+1f** | 21381 | +18.7f |
| r752 66128 | 66128 | 26f | +8f / +25f | 66266 none busy448 | **+10f（用户复核）**；镜头近景 +19f | 66956 | +24.9f |
| r752 85467 | 85467 | 14f | −0.6f | 无（fut dodge +4.7f） | 未知 | 无 | — |
| r752 179578 | 179578 | 13f | −6.4f | 无（fut dodge −6.4f） | **+1.5f** | 179950 | +11.2f |
| r752 190014 | 190014 | 23f | +4.7f | 190244 **lit 1011** | **+13.5f** | 190715 | +21.1f |
| r752 214228 | 214228 | 20f | +0.8f | 无（fut dodge +2.9f） | 未知 | 无 | — |
| r752 278698 | 278698 | 17f | +0.8f | 无（fut dodge +4.4f） | 未知 | 无 | — |
| r752 282626 | 282626 | 24f | +10.2f | 282937 none busy0 | **+15.5f** | 283447 | +24.7f |
| r750 96597 | 95820 | 26f | −6.5f | 96009 none busy0 | **+16f**（代理） | 96604 | +23.5f |
| r750 100541 | 无 | — | 无 | — | 抓取早于 99821 | 100622 | — |

### 17.0 用户复核的机制（2026-10-21）

用户回答了两个关键问题（原文意思）：

- **“已经不能动/已经被抓”的判定 = Boss 的手/武器碰到玩家时**，不是金线出现、也不是镜头切近景。镜头切近景是抓取后的表现；金线只是起手/特效。
- **快速抓有起手：金色手掌/锁链特效**（手或锁链先出现，再拉人）。这为快速抓提供了一条可能的视觉路径，但需要识别“手掌/锁链”本身，不能只用通用金色掩码。

对时序的含义：`c1` 是**延迟 hp drop** 的估计，不是 catch。用户后来逐帧看 66128，判定 catch 是 **+10f（链条挨着身体）**，不是镜头近景 +19f；r761 的三条（297102 +5–9、14022 +6–8、119406 +4–6）也都落在 **tell+4–10f**。所以：
- 正常抓：catch ≈ **tell+4–10f**，不是 c1-10；`c1-10` 对 66128（c1=26 → +16）和 14022（c1=26 → +16）都已经晚于 catch。
- 快速抓：catch ≈ **tell+1–2f**，需要金线/手掌/锁链的前置 cue。
- 画面上的镜头近景（+13–19f）通常晚于 catch，不能拿来当 catch 标签；之前用近景标的 +13–19 需要按用户口径重标。

### 17.1 两类抓取

- **快速抓**（20759、179578）：tell 首报时抓取几乎已经开始，catch 在 **tell+1～2f**。当前 anchor 4（press 后还要 3–4f 才显示）必然晚；只有金线（−6～−10f）或更早的 Boss 动作 cue 能覆盖。
- **正常抓**（66128 +10、297102 +5–9、14022 +6–8、119406 +4–6）：catch 在 **tell+4～10f**；anchor 4 的 press 显示约 +7f，理论上落在这个窗口。66128 的失败是 **busy=448ms、press result none**：dodge 很可能被自己的动作吞了，而不是“anchor 太早”。190014/282626/96597 的 +13–19 是代理按镜头近景标的，按用户口径需要重标；不能直接当 catch。
- `c1`（fut head 的期望接触帧）更接近 **hp drop**（12–25f），不是 catch；`c1 - 10f` 对 66128/14022 都已晚。**不要**把 `c1` 当 catch 真值，也不要再用 c1-10 作为主抓取时机。

### 17.2 与旧 combat.js 的对照

旧 `combat.js` 的注释（`FLARE_GRAB_AT=9`、`FLARE_LAG_MS=110`）说：抓取扑上来在 flare 首帧后 **+13～14f**，dodge 应在 **+9f 显示**。按用户新口径，catch 在 +4–10f，anchor 4–9 反而更接近；r751 把 anchor 从 4 改到 0 更差也符合“太早”。旧注释里的 +13–14 很可能是镜头近景/扑倒，而不是手/武器接触，需重标。

但快速抓（+1～2f）仍需要更早的 cue；**一个固定 anchor 不能同时覆盖 +1 和 +10**。另外，66128 的 busy=448 说明 **执行/动作锁** 是独立问题：即使 anchor 时机对，dodge 也可能没出。

### 17.3 下一步候选（都保持 default off）

1. **`flare_grab` anchor 4–9 的受控 A/B**：按用户新口径，catch 在 +4–10f，anchor 4–6 的显示窗口最接近；anchor 9 可能对 14022/119406 更合适。但 66128 的 busy=448 说明必须先排除动作锁，否则 A/B 会被“dodge 没出”污染。
2. **动作锁（P2）**：66128 的 anchor 时机在 catch 前 5f，但 `press result none busy=448`，dodge 很可能被自己的动作吞。用户 201663 也是同类。先统计 grab tell 时 `busy>0` 的比例，再考虑 `grabYield`（收到 grab tell 立刻放开蓄力/停止进攻）或防守优先级；不要直接改 anchor。
3. **不要启用 `flare2`**：旧 live A/B 的 flare2 臂 6 轮 hit 8.90/min vs A 6.56/min、dead 4/6 vs 1/6；旧注释也明确说“flare2 的第二下对 grab 没用”。固定 +300ms 的第二下也覆盖不了 +1–10f 的 catch。
4. **快速抓**：需要 Boss 抬手/金色手掌/锁链的模板或分类器；金线太广，no-tell 100541 也仍不可防（§19）。先做 catch 帧数据集（`data/tmp/telemetry_review/grab_catch_review/`）。

## 18. r753：`flare_grab` anchor 9 的 A/B（无效轮）

- 参数：737 + `telemetry:true` + `predMs:50` + `flareAnchor:{"flare_other":14,"flare_grab":9}`；录像 `recordings/20261021-025745`；dead，248s，26 hit / 65 ok，188 parry / 42 dodge。
- run：`data/tmp/dense_pred/r753.run.utf8.json`。
- 6 段 `tell flare_grab` 首报：36991、106628、127442、204180、220700、221263（220700/221263 只差 563ms，视频里是同一段金招，不是两次抓）。

| tell | c1 | 金线 | 有效 dodge | press result | 随后 hit | 录像代理标签 |
|---:|---:|---:|---|---|---:|---|
| 36991 | 17f | +0.7f | fut +5.5f，anchor 被 dodge CD 挡 | none 122px | +19.3f | **NOT_GRAB**：+8f 起玩家正常战斗 |
| 106628 | 22f | +2.5f | fut +7.7f | none 115px | 无 | **REAL_GRAB**（快速）：金线 −6～−8f，tell 时玩家已低姿/被链拉 |
| 127442 | 19f | +0.8f | fut +6.3f | none 140px | 无 | **NOT_GRAB**：+6f 起玩家红黑外观正常战斗 |
| 204180 | 14f | −0.8f | anchor +7.8f | none 100px | +9.1f | **NOT_GRAB**：金光 AoE，玩家站着继续打 |
| 220700/221263 | 23/10f | +14.5/−2.4f | fut +16.7f / 同段 | none 117px | 无 | **NOT_GRAB**：+8f 玩家突进/输出，Boss 转武器 |

- **anchor 9 实际只按了 1 次**（204180），其余 5 段的 dodge CD 先被 fut dodge 占用（`plan + dodge k0 fut ...` 后 `blocked ... dodge cd`）。所以这轮并没有真正测到 anchor 9 的时机；它测到的是“fut dodge 先占 CD”的调度行为。
- 204180 是 NOT_GRAB 的金光 AoE：anchor 在 hit 前 1.3f，仍然中；这说明对这类金招，dodge 时机关系不是唯一问题，可能还有 AoE/判定范围。
- 106628 是唯一的 REAL_GRAB：金线在 tell 前 6–8f，tell 时玩家已经被拉低；当前的 fut/anchor 都在 +7f 左右，已经晚于 catch。这个案例再次说明快速抓需要 **金线或更早的 pose cue**，而不是 tell 后的 anchor。

### 18.1 结论

**r753 不能用来判断 anchor 9 是否更好**：样本里只有 1 条 REAL_GRAB，且 `tell flare_grab` 的 5/6 是普通金招/AoE。把“tell 后 1.8s 内有没有 hit”当抓取成功率会被假 tell 主导。默认 anchor 仍保持 4；不因这轮改默认。

更重要的方法学修正：**`tell flare_grab` 不是抓取检测器**。它和 `grabParry` 的旧注释一致（“the same label fires on normal swings / golden AoE, so it is not a grab detector”）。后续任何抓取 A/B 都必须先有视频/人工的 REAL_GRAB 标签，不能只用 tell 计数。

### 18.2 金色手掌/锁链：静态颜色/形状不能分离

用户指出快速抓的起手是“金色手掌/锁链特效”。离线用同一 HSV 掩码（H 8–35、S≥25、V≥235）在 `[150,120,780,440]` 内取连通域，比较 REAL_GRAB 与 NOT_GRAB 的金线形状（±8f 内最大连通域）：

| case | 标签 | w | h | fill=count/(w·h) | w/h |
|---|---|---:|---:|---:|---:|
| r752 20759 | fast REAL_GRAB | 780 | 291 | 0.196 | 2.7 |
| r752 66128 | slow REAL_GRAB | 643 | 128 | 0.213 | 5.0 |
| r752 179578 | fast REAL_GRAB | 586 | 115 | 0.198 | 5.1 |
| r752 190014 | slow REAL_GRAB | 714 | 148 | 0.239 | 4.8 |
| r752 282626 | slow REAL_GRAB | 603 | 80 | 0.191 | 7.5 |
| r753 106628 | fast REAL_GRAB | 666 | 113 | 0.171 | 5.9 |
| r753 127442 | NOT_GRAB | 738 | 132 | 0.246 | 5.6 |
| r753 204180 | NOT_GRAB | 780 | 131 | 0.161 | 6.0 |
| r753 36991 | NOT_GRAB | 780 | 165 | 0.227 | 4.7 |
| r750 96597 | slow REAL_GRAB | 780 | 200 | 0.274 | 3.9 |

- REAL_GRAB 与 NOT_GRAB 的 w/h/fill 完全重叠；`w>=780`、`h>=200`、`fill<0.2` 等都不能单独分开。
- 这说明“金线”检测到的是**金色特效的整体**，不是手掌/锁链的语义。要利用用户的“金色手掌/锁链”知识，需要**模板/分类器**（在抓手区域裁图，区分手掌/链与普通金甲/金 AoE），而不是再调颜色阈值。
- 我们没有训练数据/模型；本轮不硬编码。下一步如果要继续抓取方向，先做 **REAL_GRAB 前置帧数据集**（人工标 20–30 条，含正负样本），再谈模板/小分类器。

### 18.2b 旧 `flare3.onnx` 的离线评估（2026-10-21）

旧 `combat.js` 的 3 类模型 `dufu/flare3.onnx`（输入 3 帧灰度 96×96，ROI `[240,30,600,600]`，输出 other/grab/slam）还在 `model/dufu/`。离线按同一预处理在 goldline onset ±12f 扫最大值：

| case | 标签 | max p(grab) | 备注 |
|---|---|---:|---|
| r750 96597 | REAL_GRAB slow | **0.988** | 命中 |
| r752 20759 | REAL_GRAB fast | **0.986** | 命中 |
| r752 190014 | REAL_GRAB slow | **0.960** | 命中 |
| r752 282626 | REAL_GRAB slow | **0.802** | 命中 |
| r758 297102 | REAL_GRAB slow（用户复核） | **0.708** | 命中 |
| r752 179578 | REAL_GRAB fast | 0.437 | 漏 |
| r753 106628 | REAL_GRAB fast | 0.068 | 漏 |
| r753 204180 | NOT_GRAB（普通金 AoE） | **0.982** | **假阳性** |
| r753 127442 | NOT_GRAB | 0.425 | 低于 0.6 |
| r758 110638 | NOT_GRAB（用户复核） | 0.142 | 低于 0.6 |

- 阈值 0.6：REAL 5/7、NOT 2/3；但 204180 的普通金 AoE 被当成 grab 0.98，106628 快速抓只有 0.07。**它不是干净的抓取检测器**，但比 `tell flare_grab` 本身有信息量。
- 这说明“金色手掌/锁链”在模型里有一部分可分（慢抓高 p），但快速抓/普通金 AoE 仍混。下一步先做 **log-only `grabClass`**（设备上记录 p），验证离线结果；再决定是把它当 `grabContactDodge` 的门控，还是重训一个专门的手/链模型。

### 18.3 r754：`grabContactDodge` lead 10 的第一轮

- 参数：737 + `telemetry:true` + `predMs:50` + `grabContactDodge:true`（`grabContactLeadF:10`, `grabContactMinF:18`），anchor 仍为默认 4；录像 `recordings/20261021-095537`。
- 结果：dead，302.7s，25 hit / 91 ok，227 parry / 41 dodge；hits/min 4.95，ok/min 18.0。`v8.grabContact = {plans:2, droppedFut:12, fastKept:5}`。
- 11 段 `tell flare_grab` 首报；其中 2 段进入 contact 分支（其余为快速/false tell）：

| tell | c1 | plan | 实际 press | press 时 c | 随后 hit | 录像代理 |
|---:|---:|---|---:|---:|---:|---|
| 25830 | 28f | `contact c+18f at+8f` | +420ms（+12.6f） | c+7f | +633ms（+19f） | 近景/抓取在 +10–14f；press 落在抓取中 |
| 66988 | 25f | `contact c+24f at+14f` | +629ms（+18.9f） | c+7f | +719ms（+21.6f） | 玩家 +9–10f 被抬起，+15–24f 近景；press 在近景开始 |

- **机制生效**：两段都先把同 contact 的 fut dodge 丢掉（共 12 次），contact item 确实抢到了 dodge 槽，没有被 `dodge cd` 挡。
- **但时序仍晚 3–5f**：计划 `at = c1-10f`，实际 press 在 `c1-7f`（循环/派发约 3.4f 延迟），而 catch 在 `c1-10～15f`；两段都中。不是“没按”，而是“按晚了几帧”。
- 总 hit/min 比 r752（5.64）和 r753（6.29）低，但轮间波动、阶段和 false tell 都不同，**不能当疗效**。下一轮只改 `grabContactLeadF:13`（补偿 3.4f 派发延迟，目标实际 press 落在 `c1-10f`），见 §18.4。

### 18.4 r755：lead 13 的第一轮没有目标事件

- 参数：同 r754，只把 `grabContactLeadF` 改成 13；录像 `recordings/20261021-100519`。
- 结果：dead，250.5s，23 hit / 56 ok，180 parry / 37 dodge；hits/min 5.51，ok/min 13.4。`v8.grabContact = {plans:0, droppedFut:0, fastKept:9}`。
- **9 段 `tell flare_grab` 全部是 `c1 < 18f` 的快速抓/false tell**，没有一条进入 contact 分支。因此这轮**没有测到 lead 13**；总 hit/min 也不能和 r754 比（ok/min 13.4 vs 18.0，轮间波动很大）。

r756（lead 13 第二轮）：dead，183.2s，24 hit / 48 ok，126 parry / 24 dodge；hits/min 7.86，ok/min 15.7；`grabContact = {plans:0, droppedFut:0, fastKept:3}`。仍然**没有慢抓目标**。

- lead 13 两轮（r755/r756）合计 **0 条** `c1>=18f` 的 contact 目标；lead 10 一轮（r754）2 条。延迟抓出现率约 **2 次/5 分钟**，1–2 轮 A/B 很容易一条都碰不到。
- 三连轮 hits/min：r754 **4.95**、r755 **5.51**、r756 **7.86**；ok/min 18.0 / 13.4 / 15.7。轮间波动大于任何小效应，**不能用总数判断 contact 开关的疗效**。
- 结论：contact 机制（丢掉 fut dodge、按 c1 定时）已实现并通过假时钟测试；r754 的 lead 10 两条都晚/中，r755/r756 没有目标。

r757（lead 13 第三轮）：dead，212.1s，22 hit / 66 ok，165 parry / 26 dodge；hits/min 6.22；`grabContact = {plans:0, droppedFut:0, fastKept:7}`。仍无 `c1>=18f` 且被 `tellPlan` 接受的慢抓；高 c1 的 tell 多数在 `tellPlan` 时已被 fut head 下调到 13–16f，属于快速/中速抓，contact 分支按设计不接管。

r758（lead 13 第四轮）：dead，313.4s，23 hit / 66 ok，184 parry / 49 dodge；hits/min 4.40；`grabContact = {plans:2, droppedFut:1, fastKept:5}`。两条 contact：

| tell | c1 | plan | 实际 press | press 时 c | 3s 内 hit | 录像代理 |
|---:|---:|---|---:|---:|---:|---|
| 110638 | 25f | `contact c+25f at+12f` | +479ms（+14.4f） | c+10f | **无** | **用户复核：不是金光抓**（普通金招） |
| 297102 | 19f | `contact c+19f at+6f` | +292ms（+8.8f） | c+10f | **无** | **用户复核：是金光抓**；contact dodge 后 3s 无掉血 |

- 两条都按计划在 **`c1-10f`** 实际按下（lead 13 补偿了约 3f 派发延迟）。
- **297102 是 lead 13 的第一个正样本**：用户确认是金光抓，contact dodge 在 +292ms（`c+10f`）按下，之后 3s 没有 hp drop；录像里玩家在 +5–9f 低姿/红特效，但没有进入后续的抓取/补刀。按用户口径，这属于“抓之前闪避”成功（用户复核，不是独立认证）。
- 110638 是普通金招，不能算抓取成功；这再次说明 `tell flare_grab` 有假阳性。
- 累计（r758 时点）：lead 10 的 2 条 REAL_GRAB contact **0/2 躲开**（两条都中）；lead 13 的 1 条 REAL_GRAB contact **1/1 躲开**（297102）。r761 又加入 1 条高 p REAL_GRAB 仍中（119406），所以 lead 13 目前是 **1/2 躲开**；样本仍不足以定论，但 lead 13 的方向与用户机制一致。
- 仍保持默认 `false`；下一步再攒 1–2 条 lead 13 的 REAL_GRAB，然后进入 option 2（REAL_GRAB 分类器/模板）。

r759/r760（lead 13 第五/六轮）：r759 dead，285.3s，25 hit / 63 ok，`grabContact.plans=0`；r760 dead，313.2s，26 hit / 83 ok，`plans=0`。仍无慢抓 contact。

r761（lead 13 + `grabClass` log-only）：dead，252.0s，24 hit / 45 ok；`grabContact = {plans:2, droppedFut:6, fastKept:3}`；`v8.grabClass = {calls:5, ready:1, grab:1, other:0, slam:0}`。

| tell | c1 | `grabClass` | contact press | 3s 内 hit | 备注 |
|---:|---:|---|---:|---:|---|
| 14022 | 26f | **not ready**（3 帧历史不足） | +432ms（c+11f） | +645ms | 无法用 p 判断 |
| 119406 | 18f | **p 0.02/0.95/0.03 arg grab** | +211ms（c+11f） | +412ms | p 高，确认真抓；但 contact dodge 仍晚，掉了 99→94% |

- `grabClass` 的 3 帧 `infer` 只有 1/5 ready：`tell` 时 `img` 的 3 帧历史经常不齐。对 log-only 来说可以先接受；若要在设备上实时门控，需要 fallback 到单帧重复 3 次，或提前缓存。
- 119406 是“高 p 真抓 + contact dodge 仍中”：说明 **p 分类不是瓶颈，catch 时机才是**。c1-10f 对这条仍晚；可能 catch 在 c1-15f 甚至更早，单靠 c1 不够。
- lead 13 累计（r758+r761）：4 条 contact，1 条用户确认 REAL_GRAB 成功（297102）、1 条高 p REAL_GRAB 仍中（119406）、2 条普通/未知仍中。样本仍不足以证明 lead 13 优于 lead 10；但 297102 是第一个“机制 + 用户标签”都成立的案例。

### 18.4b r761 的 catch 帧（录像代理）

| case | c1 | catch（代理） | contact press | 结果 |
|---|---:|---:|---:|---|
| 297102（r758） | 19f | +5–9f（低姿/红特效） | +8.8f（c+10f） | 无 hit（用户确认真抓） |
| 14022（r761） | 26f | **+6–8f**（近景，Boss 抱住玩家） | +13.0f（c+11f） | hit +19.4f；press 晚 5–7f |
| 119406（r761） | 18f | +4–6f（低姿） | +6.3f（c+11f） | hit +12.4f；borderline/晚；**用户复核：是金光抓** |

- 这三条用户确认/录像明确的抓取，catch 都在 **tell+4–9f**，而不是 c1-10f；c1 是延迟 hp drop（12–25f）的估计。
- r752 的 66128/190014/282626（代理看镜头近景）catch 标在 +13–19f；如果那也是 hand/weapon contact，则存在 **+4–9f 和 +13–19f 两簇**，固定 lead/anchor 无法同时覆盖。当前样本太少，不能确定是两种抓取变体还是代理标定偏差。
- 结论：`c1` 不能当 catch 真值；`flare3` 的 p 可帮助筛选“是不是抓”，但不提供 catch 时机。下一步 option 2 的核心是 **catch-onset 数据集/检测器**（手/武器接触或第一帧近景），而不是继续调 lead。
- 具体目标：标 10–20 条 REAL_GRAB 的 catch 帧，拟合 `catch - tell` / `catch - c1`，或用模板/小模型检测手/链接触；在此之前不再调 lead。`grabClass` 的 3 帧历史问题（5 次调用仅 1 次 ready）也要在设备端 fallback（单帧重复或缓存）后再用于门控。

## 19. 对前文的修正（r750/r751 复核）

1. **§15 的 “已加 goldline 日志” 不适用于 r750/r751**：这两份 run 里没有 `goldline` 事件；只能离线扫 mp4。设备读数第一次是 r752（§16）。
2. **金线不是 grab 专属**：r750 离线 25 段里只有 6 段靠近 grab tell，12 段靠近 `flare_other`；r751 18 段里 4 段 grab、9 段 `flare_other`。不要按“金线=抓取”设计开关。
3. **§11 的 would-plan 可防性偏高**：r750 的 4 组 would-plan 里，只有 122667（c+13f）与实际 +13.1f 对齐；81710 预测 +15f 实际 +2.3f，86035 +12f 实际 +9.1f，92158 +9f 实际 +14.1f。4 组共 6 hit / maxHP 0.320（32.0 个百分点）；其中幕布内 2 条 0.134、幕布刚结束 4 条 0.186。只有 81786、86337 是“无 press 且随后 hit”（0.134）。
4. **201663 的“动作锁”不是日志事实**：r750 没有 `busy/off` 字段；该 press 的 `press result` 是 `lit 221px`，±1s 内没有 `hit`，最近的 hit 在 +1.58s（drop 2.8%）。用户的“突进中被吞”是重要复核，但不能用这份 run 的 `ok` 或 hit 证明。
5. **k0 干净样本 / 动作锁**：r751 共 17 条（`lead c+>=8f`、±1s 无 hit/ok），`busy>0` 2 条（78127 323ms、107392 99ms）。r752/r754/r755 同样口径：40/30/40 条，`busy>0` 分别 1/2/4 条（约 2.5–10%），`off` 几乎全是 `idle`；所有干净 k0 的 `press result` 都是 `lit`。这**不支持**“防守键经常落在自己的动作里”作为主因；201663 的动作锁是个案，不能外推。注意 `busy` 是 press 后 5–10f 读取时的 `offBusyUntil` 剩余，不是按下瞬间的值，只能近似。
6. **r755 的 contact 目标为空**：9 段 `tell flare_grab` 全是 `c1<18f` 的快速/false tell，`v8.grabContact.plans=0`。延迟抓出现率约 2 次/5 分钟，1 轮 A/B 可能一条都碰不到；contact 时机需要更多轮次或可复现触发。
6. **100541 仍不可防**：无 tell、无金线；`def1 unknown>=0.9` 最早 99821，但画面里玩家已经趴下（代理看帧），不是提前 cue。r750 的 `unknown>=0.9` 5 段里 4 段在幕布内，幕布外只有 99821 一段（n=1），不能把 `unknown` 直接改成 dodge。

## 20. r762–r764：lead16 与 catch 时机复核（2026-10-21）

> 自动 episode / catch 评估的完整表在 `data/tmp/telemetry_review/grab_auto/report.md`（`data/` 不进 git）。本节只记结论和证据口径；没有改默认，没有写 `labels.json`。

### 20.1 设备轮

三轮都是 737 + `telemetry:true` + `predMs:50` + `grabContactDodge:true` + `grabContactLeadF:16` + `grabClass:true`，args-only，不是 A/B。**这是诊断配置，不是游玩配置**：默认 r737/r748 的 loop p50 30–32ms、p95 101–105ms；这三轮 p50 58–77ms、p95 121–137ms。诊断轮的 0/16 通关不能和默认的 2/25（约 8%）直接比。

| run | 时长 s | hit | ok | contact plans | grabClass ready/calls |
|---|---:|---:|---:|---:|---:|
| r762 | 275.2 | 23 | 68 | 1 | 2/5 |
| r763 | 290.0 | 26 | 83 | 0 | 2/4 |
| r764 | 209.8 | 26 | 38 | 2 | 0/7 |

- r762 201670：plan +8，实际 press +12.0，`busy=448`，hit +17.7；和 r752 66128 一样，press 已发但被自己的动作吞掉。
- r764 69905：plan +3，实际 press +7.3，`busy=0`，hit +15.5。
- r764 183046：plan +9，实际 press +15.5，`busy=0`，3s 内无 hit；可能是成功，也可能不是抓。
- 计划 `at` 与实际 press 差 3.4–6.5f；改 lead 不会 1:1 移动 press。3 轮 lead16 没有证明比 lead13 好。

### 20.2 catch 时机

只有 7 条有可用 catch 窗口（3 条用户复核、4 条代理）；96597/190014/282626 只有镜头近景，按用户口径不算 catch。候选（catch 估计，不含 press 显示延迟）：

| 规则 | 7 条内命中 | MAE | 留出 r758/r761 |
|---|---:|---:|---:|
| tell+4 | 1 | 2.14 | 1/3 |
| tell+6 | 3 | 2.29 | **3/3** |
| tell+8 | 2 | 3.14 | 2/3 |
| c1-10 | 1 | 4.00 | 1/3 |
| c1-12 | **4** | 2.57 | 2/3 |
| c1-16 | 1 | 2.57 | 0/3 |
| goldline onset | 1 | 2.99 | 1/3 |
| 帧差+光流首个动作 | 3/6 | 2.00 | 2/3 |
| flare3 p peak | 1 | 6.29 | 1/3 |

- `tell+6` 留出集 3/3，但全体只有 3/7；用户复核的 66128（catch +10）会早 4f。
- `c1-12` 全体 4/7 最高，但留出集 2/3；66128/14022/106628 偏晚 4–8f。
- 视觉 cue 都不稳定：p 峰值、金线 onset、帧差/光流峰值都不能稳定落在手/武器接触帧。
- 快抓（20759/179578/106628）的 catch 在 tell+0–2f，是另一簇；任何 tell 后的 anchor 都晚。

### 20.3 结论

**没有写 `grabCatchDodge`，默认保持 anchor 4 / `grabContactDodge:false` / `grabClass:false`。** 下一步优先级：

1. 修 `grabClass` 的 3 帧历史（ready 4/16），让实时 p 可用；contact 分支（c1≥18）的离线窗口最大 p≥0.6 是 REAL 7/8、NOT 0/3，但这是 oracle 窗口值，实时 p 还要验证。
2. 做 default-off 的 `grabYield`/动作锁实验：66128、r762 201670 的失败都指向 press 已发但 `busy=448`。
3. 快抓需要 tell 前的金线/手掌/锁链 cue；固定 tell 偏移解决不了。
4. 如果还要测 lead：数据支持 `catch ≈ c1-12…-20`，按 press 延迟 3–6f 反推，lead 20–22 比 16 更接近，但只应作为下一轮受控 A/B 的假设。

## 21. 默认 737 基线复核（2026-10-21）

诊断轮 0/16 看起来像“比之前差”，但它们是 `telemetry:true` + `predMs:50` 的诊断配置（loop p50 58–77ms）。为确认默认路径，按 737 原参数（`data/tmp/dense_pred/baseline737.args.json`，**不传** `telemetry` / `predMs` / `grabContactDodge` / `grabContactLeadF` / `grabClass`）跑了 5 轮：

| run | result | 时长 s | hit | ok | loop p50 | loop p95 |
|---|---|---:|---:|---:|---:|---:|
| r767 | dead | 204.1 | 25 | 37 | 32 | 104 |
| r768 | dead | 234.6 | 24 | 83 | 31 | 102 |
| r769 | **cleared** | 279.0 | 15 | 85 | 34 | 106 |
| r770 | dead | 233.2 | 25 | 60 | 34 | 107 |
| r771 | dead | 195.9 | 27 | 60 | 35 | 107 |

- **1/5 cleared**。历史基线是 2/25（约 8%）；按 8% 算，P(1/5)≈29%，5 轮的 95% CI 很宽（约 0.5–72%），所以这只能确认“默认还能通”，不能证明通过率提高。
- loop p50 **31–35ms**、p95 **102–107ms**，与 r737/r748 的 32/105 一致：默认路径没有性能回归。
- r765/r766 是 `do skill dufu` **不带 args** 跑的，拿到的是代码默认（很多 737 功能默认关），不是用户基线；不计入上表。
- 结论：最近的 0/16 不是默认路径变差，而是诊断配置变慢 + 8% 基线的正常波动；默认通关率仍约 8%，没有证据说提高或降低。
