# 独夫防守执行/状态遥测：实现说明

> 本轮只加日志，不改默认策略、阈值、lead 或防守开关。`telemetry` 默认 `false`；关闭时 `events` / `presses` / `touch` 与改动前一致。本文是**实现与测试记录**，不是命中归因；逐条 `hit` 分析见 [telemetry-findings.md](telemetry-findings.md)（诊断跑之后生成）。

## 1. 用法

```bash
uv run maalow do skill dufu --workspace WhereWindsMeet --args '<737 的参数 + "telemetry":true,"predMs":50>'
```

`telemetry:true` 时新增/扩展五类日志：

| 日志 kind | 触发 | 用途 |
|---|---|---|
| `pred`（扩展） | 原有 `predMs` 节流（`predMs=50` 即约 20 Hz） | `def1` 五类概率 + argmax |
| `press result` | 每次 parry / dodge 按下后 5–10f | 按钮光 / `parry_ok` 模板；**首轮校验显示它与 ok 无判别力，不能当执行真值** |
| `press late` | 同一次按下后 14–18f | 第二次按钮光；用于看 5–10f 后是否才亮，仍不是架势 |
| `state` | 状态切换 | 幕布、硬直、off 动作、hp / qi |
| `would-plan` | 幕布内每 300ms | 如果幕布不抑制 `syncK`，会排什么（不建 plan / 不 press） |
| `goldline` | 逐帧金色亮线 on/off | 验证金光抓的更早 cue；只记日志，不触发 dodge |

`telemetry` 不进入任何计划、`press`、`touch` 或 `v8` 返回字段。关闭时 `telTick()` 第一行返回，连 `Date.now()` 都不调用。

## 2. 改动的文件

```text
workspaces/WhereWindsMeet/skills/dufu.js        telemetry 开关 + TEL_* 常量 + predMark / telTick
tests/dufu_scheduler.mjs                       4 条假时钟测试 + 按钮光 stub
workspaces/WhereWindsMeet/docs/telemetry-implementation.md   本文
```

没有改 `dufu-reads.js`、默认参数、`labels.json`、审计数据或守护规则。

## 3. 字段格式

### 3.1 `pred`（只在 telemetry 开启时追加）

原有内容完全保留，末尾追加：

```text
def1 p 0.01/0.96/0.01/0.02/0.00 arg parry
```

- 五个数依次是 `DEF_LABELS = [none, parry, dodge, curtain, unknown]` 的 p0–p4，保留两位小数。
- `arg` 是同一分布的 argmax（与前面的 `def1 parry` 相同来源，便于直接筛）。
- `predMs=50` 仍按原逻辑工作；没有改推理、`syncK`、`defAction` 或计划。

### 3.2 `press result`

parry：

```text
parry lit glow=210px parry_ok=-0.02 stance=unknown delay=6f press=+1002ms
parry none glow=63px parry_ok=-0.01 stance=unknown delay=6f press=+2502ms
```

dodge：

```text
dodge lit glow=535px delay=7f press=+8210ms (execution unverified)
dodge none glow=90px delay=6f press=+12792ms (execution unverified)
```

- `off=<state> busy=<ms> grab=<0|1>`：press 时自己的 off 状态、`offBusyUntil` 剩余毫秒、是否在 `flare_grab` tell 窗口内（用于区分“防守键落在自己的动作/金光抓里”）。
- `delay` 是从 `press=` 的按下时刻到本次读取的帧数；正常在 5–10f，循环卡顿超过 10f 时写
  `parry unknown delay=12f (read window missed)`，不伪造 lit/none。
- `glow` 是 ROI 内满足 `S<40, V>230` 的像素数（与 `data/tmp/dufu_yolo/glow.py` 同一掩码）。
- parry 阈值 150 px；dodge 阈值 250 px。阈值来自 r748 实测，见 §4。
- `parry_ok` 是 `combat/parry_ok.png` 在 `[815,391,75,75]` 的最高分（`threshold:-1`）。它是“重击派生”菱形，不是卸势架势本身。
- `stance=unknown` 是明确的未知：没有可靠的“卸势架势”视觉读数，不用按钮光冒充。
- 首轮校验发现 5–10f 按钮光与 ok 无判别力（见 `telemetry-findings.md` §9）；这个字段只能作为“当时有没有白闪”的原始记录，不能解释为“执行/没执行”。

第二次读取（press 后 14–18f，和上面的 `press result` 用 `press=+Nms` 对齐）：

```text
parry lit glow=210px early=none off=idle busy=0ms grab=0 delay=15f press=+120010ms
parry none glow=70px early=none off=idle busy=0ms grab=1 delay=14f press=+120010ms
dodge lit glow=990px early=none off=idle busy=120ms grab=0 delay=14f press=+198550ms
```

- `early` 是第一次（5–10f）的 `lit/none/unknown`；`press late` 用来区分“5–10f 没光、14–18f 才亮”的晚到闪。
- 这个晚到闪也可能是受击特效（r748 546/235 已看到俯卧时按钮白闪），仍然不是架势真值。

幕布影子（只在 `telemetry:true` 且 `inCurtain`、`curtainParryPlan:false` 时写；不建 plan、不 press）：

```text
would-plan k0 dodge c+14f | k1 parry c+37f
would-plan none
```

每 300ms 最多算一次，只在结果字符串变化时写。它回答“如果幕布不抑制 syncK，会不会有 plan、是什么动作”。

金色抓线索（只记日志，不触发 dodge）：

```text
goldline on w=780px count=49000 f3195
goldline off
```

逐帧检查 `FLASH` 金色掩码（H 8–35、S≥25、V≥235）在 `[150,120,780,440]` 里的宽 ≥300px、像素 ≥5000 的连通域；r750 95600–95750 的抓取金线是 780px 宽、23k–49k px，早于 tell 约 4–10f。100541 的金光抓没有这条线，需要另一条检测路径。

r752 设备验证（`docs/telemetry-findings.md` §16）：298s 内 27 段金线，只有 11 段靠近 grab tell，12 段靠近 `flare_other`；相对 tell 的偏移从 −615ms 到 +213ms，不是稳定的提前 cue。**因此没有把 `goldLineDodge` 保留为实现**；`goldline` 只作为原始读数，后续若要使用必须先找到“金线 + 其他条件”的细分。

抓取接触 dodge（`grabContactDodge`，默认 `false`，2026-10-21；**已上机 3 轮，未证明疗效**：r754 lead 10 有 2 条慢抓、都晚 3–5f；r755/r756 lead 13 没有慢抓目标）：

```text
grab contact c+23f at+13f lead=10f
plan + dodge k-1 tell at+433ms c+767ms tell flare_grab contact p78
press dodge left k-1 tell c+10f tell flare_grab contact p78
```

- 用户复核：金光抓的“已经不能动”是 **Boss 手/武器碰到玩家**；对延迟抓，`c1` 跟的是延迟 hp drop，catch 约在 `c1 - 9～10f`。r752 的 66128/190014/282626 与 r750 96597 都落在这个范围。
- 只在 `tellAnchor` + `flare_grab` + `c1 - now >= grabContactMinF`（默认 18f）时启用；`at = c1 - grabContactLeadF`（默认 10f）。
- 同时删掉目标同一 contact（`|cMs-c1| <= 12f`）的未按 fut dodge，避免它先占游戏 dodge CD；`executePlan` 里也会丢掉 tell 之后才出现的同 contact fut dodge。快速抓（`c1 < 18f`）保持原 anchor，因为它的 catch 已在 tell+1–2f，contact dodge 只会更晚。
- `tell flare_grab` 本身不是抓取检测器（普通金招/AoE 也会报）；这个开关必须默认关，先做 REAL_GRAB 标签的受控 A/B。返回的 `v8.grabContact` 只在开关打开时出现（`plans` / `droppedFut` / `fastKept`）。

抓取分类日志（`grabClass`，默认 `false`，log-only，2026-10-21）：

```text
grabclass p 0.10/0.80/0.10 arg grab tellp 0.86 c1 +21f
grabclass not ready tellp 0.62
```

- 在第一个 **sustained、p >= tellDodgeP** 的 `flare_grab` tell 上跑一次旧 `dufu/flare3.onnx`（`GRAB_CLASS_OPTS`：3 帧灰度 96×96，ROI `[240,30,600,600]`，`post:"softmax"`），记录 p[other/grab/slam] 与 tell 概率；不建 plan、不 press。
- 每个 episode 只跑一次（`grabClassFor = flareFirstAt`）；`ready` / `grab` / `other` / `slam` 计数在 `v8.grabClass`。
- 离线评估见 `telemetry-findings.md` §18.2b：REAL_GRAB 5/7 高 p，但普通金 AoE 有 0.98 假阳性，快速抓 106628 只有 0.07；**它不是干净的抓取检测器**，只用于收集设备数据/决定是否门控。

### 3.3 `state`

```text
telemetry start curtain=out hp=80% qi=300 off=off
curtain in
curtain out
stagger on +15f (500 ms) control=unknown
stagger moved to +12f
stagger over
hp 80% -> 70%
qi 300 -> 292 px
off hold:charge -> gate
```

- `curtain`：`inCurtain` 进入 / 退出。
- `stagger`：`staggerUntil` 设置 / 延长 / 到期。`control=unknown` 表示倒地 / 被按住没有独立检测；只能用 `hit` / `stagger` / `escape skip (heavy)` 时间近似，不能据此断言当时可行动。
- `hp`：与上次记录的基线相差 ≥ 2 个百分点才写；慢速漂移也会每 2% 报一次。
- `qi`：与上次基线相差 ≥ 8 px 才写（一次卸势量级）。真气读空时 `qiNow=-1`，只作为基线重建，不写 `-1 -> 0`。
- `off`：`off` = 所有 off 开关关闭；否则为 `idle` / `gate` / `tap` / `walk:<why>` / `hold:<action>`。用手指是否仍按下（`offUpAt`）区分 tap 与 gate。

## 4. 读数标定（r748，代理证据）

对象：`workspaces/WhereWindsMeet/recordings/20261020-154901/video.mp4`（6755 帧，30 fps），
`data/tmp/dense_pred/r748.run.utf8.json`（149 parry / 18 dodge press）。

| ROI | 掩码 | 空闲 p50 | 亮起样本 | 阈值 |
|---|---|---:|---:|---:|
| parry `[934,477,36,36]` | `S<40, V>230` | 67 px | 197–315 px（p97–max） | 150 |
| dodge `[906,656,36,36]` | `S<40, V>230` | 93 px | 535–1020 px（4 次） | 250 |

- parry 侧 149 次 press 中约 109 次在 0–40f 内能找到 ≥150 px 的亮起；约 40 次没有。没有亮起不等于输入没发出，可能只是闪一下被采样/编码漏掉，或当时被硬直/冷却吞掉。日志保留原始 px 数，分析时不把 `none` 直接当 `NOT_EXECUTED`。
- dodge 侧 18 次 press 只有 4 次出现 535–1020 px 的白闪，其余在 80–100 px 基线内。因此 dodge 的 `lit` 是**正证据**，`none` 不能证明没有进入闪避（标 `execution unverified`）。
- 读取点是按下后第一个 ≥5f 的循环帧；r749 实际分布为 5f 101 次 / 6f 128 / 7f 58 / 8f 18 / 9f 6，全部落在 5–10f。超过 10f 的读取写 `unknown`，不会为了凑窗口提前/延后。

以上是离线录像上的代理读数，不是人工逐帧确认；不同画质 / 场景亮度下阈值可能需要重标。

## 5. 测试

telemetry 4 条 + `grabContactDodge` 3 条 + `grabClass` 1 条假时钟测试（`tests/dufu_scheduler.mjs`）：

| 测试 | 覆盖 |
|---|---|
| `telemetry off adds no events or touches` | 关闭时 `presses`、完整 touch 流、`[elapsed, kind, detail]` 事件序列与默认完全一致；无 `press result` / `press late` / `state` / `would-plan` |
| `telemetry logs def1 probabilities and a 5-10f parry result` | `pred` 带 `def1 p ... arg ...`；parry press 后 5–10f 有 `press result`；14–18f 有 `press late` 且带 `early=`；`lit`、`stance=unknown`；hp / stagger 有 `state`；press / touch 次数不变 |
| `telemetry logs curtain would-plan without pressing` | 幕布内写 `would-plan`（k0/k1/k2 + 动作 + `c+Nf`），press / touch 次数不变；关闭时不写 |
| `telemetry reads a dodge press without extra touches` | dodge press 后有 `press result`，`lit` 可读；press / touch 次数不变 |
| `telemetry logs the golden grab line without pressing` | 金线在屏上时只写 `goldline on/off`，press / touch 次数不变；关闭时不写 |
| `grabContactDodge waits for a slow grab's contact and drops the fut dodge` | `c1=2000ms` 的慢抓：fut dodge 被丢掉，contact dodge 在 `c1-10f` 按下；`v8.grabContact.plans=1`、`droppedFut>=1` |
| `grabContactDodge leaves a fast grab on the anchor` | `c1=1000ms`（<18f）不快进 contact 分支，仍走 anchor；`plans=0`、`fastKept>=1` |
| `grabContactDodge off does not change the grab dodge` | 关闭时 events / touches 与默认逐字节一致，`v8.grabContact` 不出现 |
| `grabClass logs the flare3 grab probability without pressing` | 假 `infer` 返回 p `0.10/0.80/0.10`；只写一条 `grabclass`，press / touch 不变；关闭时不写 |

命令与结果：

```text
node --check workspaces/WhereWindsMeet/skills/dufu.js
node --check workspaces/WhereWindsMeet/skills/lib/dufu-reads.js
node --check tests/dufu_scheduler.mjs
node tests/dufu_scheduler.mjs        PASS ×26
uv run pytest -q                     40 passed
```

假时钟下 `color()` 的按钮 ROI 返回 `cfg.parryGlow` / `cfg.dodgeGlow`，不依赖设备；`match()` 返回未命中，`parry_ok=-`。

## 6. 限制

1. **没有卸势架势读数**：`stance=unknown` 是真实未知；`parry_ok` 是成功卸势后的“重击派生”菱形，出现晚且不覆盖所有成功卸势，不能当作逐次执行真值。
2. **按钮光不是动作真值**：`lit` 只证明按钮亮过；`none` 可能是采样太晚、编码丢失、硬直 / 冷却 / 幕布遮挡。r749 交叉校验中 `parry none` 与 `lit` 的 1s 内 ok 率是 54.8% vs 57.2%，36 个 `done ok` press 的 5–10f 读数是 `none`；因此 `none` **不能**解释为“没执行”。分析时必须与 `press`、`blocked`、`stagger`、`hit` 联读，且不能拿这个字段单独归因。
3. **dodge 光很稀疏**：r748 只有 4/18 次 dodge 有明显白闪；dodge 执行与否主要仍是 unknown。
4. **倒地 / 被按住没有独立检测**：`stagger control=unknown` 只是时间近似，不能区分“站着但硬直”“俯卧”“被抓住”。
5. **`delay` 用墙钟算**：读取的是循环帧；截图采集延迟、循环卡顿会让 `delay` 与视频帧差不完全一致。第一次超过 10f、第二次超过 18f 都显式标 unknown。
6. **单位与基线**：`hp` 是血条比例（量化约 0.4%），`qi` 是 px；`hp` 的 2% 基线会同时记录低血灰条误读的 17/21 抖动（P0b 已不让它触发 hit），这是预期，用于观察读数质量。
7. **只影响 telemetry 运行**：开启时每个 press 多 2–3 次小 ROI 读取和事件写入（5–10f、14–18f、parry_ok），幕布内每 300ms 多一次 `targetOf` 计算，`ms.reads` / `loop` 可能略升；关闭时没有额外读取。默认策略与 `v8` 字段不变。
8. **`off` 状态是派生值**：由 `offOn` / `offHold` / `offWalking` / `offUpAt` / `offOpenAt` 组合，不等于游戏内的每个动作；只用于把日志和动作时间对齐。
9. **goldline 不是抓取专属**：r752 设备验证 27 段/298s，只有 11 段靠近 grab tell，12 段靠近 `flare_other`；相对 tell 的偏移 −615…+213ms。它只作为原始读数保留，不触发 press；`goldLineDodge` 原型未保留（见 `telemetry-findings.md` §16）。金色亮线的 ROI / 掩码 / 宽 300px / 5000px 阈值仍来自离线 FLASH 掩码（r750）的代理读数，设备 `color(count, connected)` 的误报率未标定。
10. **`grabContactDodge` 未证明疗效**：r754 lead 10 的 2 条慢抓都在 catch 后 3–5f 才按下（计划 `c1-10f`，实际 `c1-7f`，派发延迟约 3.4f）；r755/r756 没有出现 `c1>=18f` 的慢抓，无法验证。r758 lead 13 有 2 条 contact：110638 用户复核不是抓，297102 用户复核是抓且 contact dodge 后 3s 无掉血（1 条正样本）。`tell flare_grab` 还会报普通金招/AoE，不能当抓取检测器；默认保持 false，等更多 REAL_GRAB 标签/轮次。
11. **`grabClass` 只是日志**：旧 `flare3.onnx` 离线对 7 条 REAL_GRAB 有 5 条 p>=0.6，但普通金 AoE 204180 有 0.98 假阳性、快速抓 106628 只有 0.07；不能单独当抓取开关。设备上的 p 还需要 r761 一轮确认。

## 7. 回滚

- 运行时：`telemetry` 不传或 `false` 即可，行为与改动前一致。
- 代码：删除 `dufu.js` 中 `TEL_*` 常量块、`telemetry` 默认值、`telProbes` / `telPrev` / `telOffState` / `telGlow` / `telReadPress` / `telReadLate` / `telWouldPlan` / `telGoldLine` / `telTick` 块、`predMark` 里的 `def1Tel` 追加、`syncPlan` 里的 `telWouldPlan` 分支和主循环末尾的 `telTick(Date.now())`；测试删除 4 条用例和两个 glow stub 分支即可。`grabContactDodge` 另删 3 个 args、`gcS`、`tellPlan` 的 contact 分支、`executePlan` 的 fut-drop、`v8.grabContact` 字段和 3 条测试；`grabClass` 删 2 个 args、`GRAB_CLASS_OPTS`、`gclsS`、`tellPlan` 的分类块、`v8.grabClass` 和 1 条测试。

## 8. 诊断跑（2026-10-20）

```bash
uv run maalow sync WhereWindsMeet --push --exclude 'docs/**' --exclude 'tools/**' --exclude 'README.md' --exclude 'skills/maalow.d.ts'
uv run maalow do skill dufu --workspace WhereWindsMeet --args '<737 参数 + telemetry:true + predMs:50>'
```

737 的完整参数见 `data/attack_audit/20261020/rounds.json` 的 round 737 `config_args`；本轮只加 `telemetry:true` 和 `predMs:50`。

第一轮（r749）：dead，6184 looks，26 hit / 88 ok，253 parry / 58 dodge，311 `press result`，470 `state`。
run JSON：`data/tmp/dense_pred/r749.run.json`（CLI 原样输出）与 `r749.run.utf8.json`（转码副本）；没有录像。

第二轮（r750，加了第二次读取和幕布影子）：

- 录像：`20261020-215616`，12881 帧，429s；已 pull 到 `workspaces/WhereWindsMeet/recordings/20261020-215616/`。
- dead，4752 looks，25 hit / 47 ok，177 parry / 38 dodge，215 `press result` + 215 `press late`，18 `would-plan`，320 `state`。
- `ms.reads` p95 6ms，`loop` p95 96ms。
- run JSON：`data/tmp/dense_pred/r750.run.json` / `r750.run.utf8.json`。

第三轮（r751，金光抓 anchor=0）：录像 `20261021-001130`；同 737 参数，`flareAnchor.flare_grab:0`；dead，27 hit / 44 ok，124 parry / 34 dodge；158 条 `press result`。抓取段 6 次，anchor dodge 3 次 `none`、1 次 `lit` 但仍有延迟掉血；结论是 tell anchor 0 仍不够，下一步应做金色亮线图像 cue。run JSON：`data/tmp/dense_pred/r751.run.utf8.json`。

逐条分析与四类计数见 [telemetry-findings.md](telemetry-findings.md)。录像复核结论是：**按钮光在 5–10f 和 14–18f 都不是架势真值**，所以这两轮的 `NOT_EXECUTED` 数字只能当原始读数，不能用来改默认策略。

默认关闭的回归对比：同一假时钟配置下，HEAD 版 `dufu.js` 与本版 `telemetry:false` 的 `events`、`presses`、`touch` 流逐字节相同（28 events / 19 touches）。

第四轮及以后（2026-10-21，goldline / grab contact）：

- r752（goldline 设备验证）：录像 `20261021-002639`；dead，298s，28 hit / 80 ok；27 段 `goldline`，不是 grab 专属。详见 findings §16。
- r753（`flare_grab` anchor 9）：录像 `20261021-025745`；dead，248s，26 hit / 65 ok；6 段 grab tell 里 5 段是普通金招/AoE，anchor 9 实际只按 1 次；A/B 无效。详见 findings §18。
- r754（`grabContactDodge` lead 10）：录像 `20261021-095537`；dead，302.7s，25 hit / 91 ok；2 条慢抓 contact，12 次 fut drop，press 在 `c1-7f`（晚 3–5f），两条都中。详见 findings §18.3。
- r755/r756（lead 13）：录像 `20261021-100519` / `20261021-101239`；dead，250.5s / 183.2s，23/48 与 24/48 hit/ok；`grabContact.plans=0`，没有慢抓目标，无法验证。详见 findings §18.4。
- r757/r759/r760（lead 13）：212.1s / 285.3s / 313.2s，22/66、25/63、26/83 hit/ok；`grabContact.plans=0`。
- r758（lead 13）：录像 `20261021-103128`；dead，313.4s，23 hit / 66 ok；`grabContact.plans=2`。110638 用户复核不是抓；297102 用户复核是抓、contact dodge 后 3s 无掉血（第一个正样本）。详见 findings §18.4。
- r761（lead 13 + `grabClass` log-only）：录像 `20261021-114002`；dead，252.0s，24 hit / 45 ok；`grabContact.plans=2`；`grabClass` 5 次调用仅 1 次 ready（119406，p 0.95 grab），contact dodge 后仍掉血 99→94%。3 帧 `infer` 历史不足是主要限制。
