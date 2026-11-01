# 独夫进攻：批次在线学习设计与数据 schema（2026-11-01）

状态：设计（M0 测量 / M1 学习型安全门控 / M2 动作排序 / M3 批次闭环）。默认策略不变：`args.offense` 默认 `"off"`，`"v2"` 保留为基线，新版本只做显式 opt-in。

关联：[dufu-offense-design.md](dufu-offense-design.md)（v2 规则引擎）、[dufu-current.md](dufu-current.md)（现状）、[dufu-moveid-plan.md](dufu-moveid-plan.md)（总计划）。

## 1. 目标与边界

- **目标**：在 6 分钟安全门（挨打/分 ≤1.5、致命 ≥90%、金被卸 ≤3%）下，把 v2 的约 32% / 6 分钟输出继续提高；形成“跑一批 → 入库 → 训练 → 2 对 2 筛 → 8 对 8 晋级/回滚 → 再跑”的小步闭环。
- **“在线”= 批次在线**：每 4–8 局更新一次；不在同一局内更新（无法验证、也不安全）。
- **硬边界**：
  - 学习层**只能否决/放行规则引擎已经允许的动作**，不能凭空新增动作；防守路径、老师规则（金光闪、红光卸、阶段一无红光、幕布、火球雨、金光火球）、关 2 阈值都不动。
  - 不降难度、只在演练场全自动、不点付费/确认按钮。
  - 一次 A/B 只改一个变量：测量（M0）/ 门控（M1）/ 排序（M2）不混批。
  - 不跑 10 分钟 Stage 1/2；旧 10 分钟数据只作参考。

## 2. 角色分工（谁学什么）

| 层 | 是否学习 | 说明 |
|---|---|---|
| 防守（卸/闪/喝药/幕布/火球雨） | **冻结** | `dufu1b` 与学生模型不动；c11 防守链问题另开独立里程碑 |
| 动作集 + 硬禁手（T0） | 规则 | `lib/dufu-offense.js` 的 `pick`，不学习 |
| 安全门控（M1） | **学** | 在 `pick` 之后、按下之前，估计该动作 commit+safety 窗内的受击风险，高则否决 |
| 动作排序（M2） | 学（M1 稳定后） | 只在规则候选内重排 execute/light/follow/qishu/no-op，不做反事实自由探索 |
| 阈值/权重发布 | 离线导出 | 线性模型点积或浅树，编译进 `skills/lib/dufu-offense-policy.js`，Pad 上纯 JS |

## 3. 数据 schema（机会级，`data/moveid/offense/online/`，gitignored）

一次“机会”不是一次按键，而是**每个决策 tick**（有 boss、且 `pick` 有候选或被硬门拦下），一行。这样 no-op 也有样本，才能学“什么时候不打”。

### 3.1 行字段

| 组 | 字段 | 来源 | 说明 |
|---|---|---|---|
| 身份 | `round`, `arm`, `t_ms`, `frame` | round/args/trace | `arm` ∈ `off` / `v2` / `v3`；`frame` 统一换成录像帧（与 `contacts.json` 同一时钟） |
| 状态 | `hp`, `qi`, `bossPx` | trace | `bossPx` 用修好的 ROI（§4）；`hp` 缺失保留 -1，特征里前向填充 |
| 状态 | `grp`, `grpP`, `gold`, `red`, `none`, `dodge`, `parry`, `rnone` | trace | 头部输出（不是未来标签） |
| 状态 | `med`, `p10`, `c7P`, `run` | trace | tte / 10 帧内接触概率 / 火球雨 |
| 状态 | `chainPos`, `chainLen`, `nextShare` | trace | 上一条接触的前缀链 |
| 状态 | `weapon`, `lock`, `near` | trace | 武器 / 锁 / near 门代理 |
| 状态 | `lastKind`, `lastKindAgeF`, `hitAgeF`, `okAgeF`, `hitsLast90F` | contacts | 最近接触类型与年龄、近 90 帧受击数 |
| 状态 | `c11Active` | contacts/表 | 最近接触属于 c11/c40 或 `goldNow` 窗 |
| 候选 | `candTier`, `candQ`, `candReason`, `pE42`, `pE61`, `pE70` | trace/引擎 | 规则引擎首选（被门控前）与各窗 P(empty) |
| 候选 | `exeBtn`, `blueDisc`, `qishuReady` | trace（新增） | 按钮类可用性 |
| 门控 | `gateScore`, `gatePass`, `policy` | trace（新增） | v3 打分与是否放行；`policy` 0/2/3 |
| 结果 | `hitNext61` | contacts | 本 tick 起 61 帧内是否有真值受击（安全标签） |
| 结果 | `hitNextAction` | contacts | 本 tick 起 `action` 的 commit+safety 窗内是否有真值受击 |
| 结果 | `c11Next` | contacts | 窗内是否有 c11/c40 接触（只统计，不当进攻责任） |
| 结果 | `damagePx`, `whiff`, `executed` | trace+ROI | 实际按下时：2 s 后 boss 掉血（无其它按键干扰才计）、是否空挥 |

### 3.2 标签定义

- **安全标签** `hitNextH`：真值 `hit` 接触帧 ∈ `(frame, frame + H]`。H = 动作的 commit+safety 帧（execute 45、light 42、follow 61、qishu 70）。真值来自 `contacts.json` 的 `truth`（视频帧、已对时），不用设备 `result.hits`。
- **伤害标签**：按下动作 `t0` 与 `t0+2 s` 的 `bossPx` 差，要求该窗口内没有另一次进攻按键；否则 `damagePx=null`（删失，不填 0）。`whiff = damagePx != null && damagePx <= 1`（1 px 是 ROI 噪声）。
- **c11 标签**：真值接触的 `dec.grp` 含 `c11`/`c40`，窗口同上。c11 是防守链问题，只用来监控，不能当“进攻输出”的收益/损失。

### 3.3 切分与报告

- **按局切分**：同一局只能进 train 或 val；训练用按局 leave-one-round-out / GroupKFold，报告 OOF。
- 报告：AUC、校准（每 0.1 分箱的实测受击率）、安全召回（在“真会挨打”的机会上否决率）、否决率、被否决动作的伤害损失。
- bootstrap 按局重采样，给 95% 区间。

## 4. M0：测量修正（不改实机策略）

### 4.1 BOSS_ROI

现状：`BOSS_ROI = [347, 27, 386, 6]`（6 行），`bossBar()` 用“红色像素数 / 6”当 px。UI 上下跳 1–3 行时只剩 3–5 行可见，读数按比例掉 1/6–1/2，再回弹——日志里的 ±100 px 假掉血、假 near 都是这个。

修法（**offense-only**，不动防守）：

- 新增 `bossFill(im)`：ROI `[347, 20, 386, 20]`，逐行统计红色像素数（RGB 170–255 / 0–130 / 0–130），取**单行最大计数**作为血条 px。行是 1 px 高，计数就是该行宽度，天然对 1–3 行 UI 位移不敏感。
- `dufu2.js` 保留 `bossBar()` 给防守（进场、boss 消失、结束判定、旧 `boss` trace 列）；进攻的 near 锚点、`bossPx` trace、`atk2Land` 伤害核算改用 `bossFill`。
- 离线复核：r199/r201/r203 逐帧（每 2–3 帧抽样）比较旧读数/新读数；指标 = 相邻帧 |Δ| 的 p95、假掉/假升次数（回弹 ≤2 s）、真实处决台阶（-57~-59 px）是否保留。**先出离线对照，再与 M1 一起上机**；如果新读数与旧读数在真实台阶上不一致，停。
- 防守 A/B 不受影响：`offense:"off"` 的触摸对拍（固定基线 `4c80b3c`，12 场景）必须继续 12/12。
- **离线结果（2026-11-01，r199/r201/r203，15 Hz）**：旧读数假掉/回弹 **320 次**（设备 4 Hz trace 同口径 183 次），新读数 **2 次**；5 次有效处决台阶 old 57.3–58.0 px、new 57.5–58.0 px，真实台阶保留。新读数弱点：红色描边/红雾会把单行顶到 386（+16–36 px），只偏高；离线伤害核算用 0.5 s 最大滤波 + 单调包络（`offense_boss_fill.py` 的 `envelope`），live 暂不做包络，`atk2Land` 的 dmg 在红雾帧可能低估。脚本 `offense_boss_roi.py`，输出 `data/moveid/offense/online/boss_roi.json/.md`。

### 4.2 trace 新列

在 `TRACE_COLS` 末尾追加（旧分析按列名查找，不改旧列）：

`bossPx`（改为修好的进攻读数）、`exe`, `disc`, `qishu`, `pE42`, `pE61`, `pE70`, `cand`, `gate`, `hitAge`, `pol`, `prop`

- `exe/disc/qishu`：0/1，按钮类读取结果（4 Hz 读，trace 按最近值）。
- `cand`：规则引擎首选动作的 tier（0 none / 1 execute / 2 qishu / 3 light+follow / 4 set / 5 charge），**门控前**。
- `gate`：v3 风险分 ×1000（0 = 未启用/未算）；`hitAge`：距上次真值受击的帧数（-1 无）；`pol`：0 off / 2 v2 / 3 v3；`prop`：按下概率 ×1000（M1 确定性策略恒 1000；M2 探索时记录）。
- 决策机会日志 = trace 每个 tick（有 boss）一行；`cand>0` 即“规则想打”，`atkTier` 是最终动作，`atkReason` 说明被哪一层拦下。

### 4.3 离线审计（r185–r211）

- 每局：攻击机会数、动作分布、execute/light/follow/qishu 的真实持续伤害（修好的 ROI）、空挥率、c11/受击标签。
- 输出 `data/moveid/offense/online/audit.json` + `audit.md`；作为 M1 的基线。

## 5. M1：学习型安全门控（第一个可部署版本）

### 5.1 决策流

```
pick(state) -> action (规则引擎，含 T0/串中/near/horizon)
if action == execute: 放行（气竭按钮窗，n=19 的 P(empty)=1.00；且处决是主要伤害）
v = valueModel(state, action)          # v3 唯一新增：P(这一下造成 >=2 px 持续伤害)
if v < threshold[action]: 否决（reason "gate"）
else: 按下
```

- 门控只做否决；不放宽任何现有门（`near`、`goldNow`、horizon、串中、T0 全保留）。
- `execute` 不门控（样本少、窗口本身安全、是主要伤害）；若离线显示 execute 后 61 帧受击率也高，再单独加。
- 安全型 hazard 门控先按要求实现并离线验证（§5.5），**在按键行上没有区分度，已否决**；可部署的 v3 用 value 门控（M1b），它仍然只否决规则动作。阈值按动作分（light/follow/qishu），默认取“OOF 保留 ≥95% 伤害”的最大否决阈值。

### 5.2 特征（v3 首版，全部来自现有 trace/contacts，旧局也能训练）

`hp`（填充后 0–1）、`qi`/100、`bossPx`/386、`grpP`、`p10`、`med`/46（无接触 = 0）、`pgold`、`pdodge`、`pparry`、`pnone`、`p7`、`nextShare`（缺失 = 0.5 并带 missing 标志）、`chainLen`/4、`chainPos`/3、`weapon` one-hot、`near`、`lock`、`hitAgeF`/300、`okAgeF`/300、`lastKind`（-1/0/1）、`hitsLast90F`/3、`c11Active`、`hp<0.3`、`bossFrac<0.25`。

- 不做逐帧卷积、不上大网络；先 logistic（L2），可解释、可直接编译成 JS 点积。
- 标准化参数（mean/scale）随权重一起导出。

### 5.3 训练与验证

- 样本：r185–r211 所有有 boss 的 tick；不按 arm 过滤（off 臂提供“没按也挨打”的对照分布），但报告分 arm。
- 标签：§3.2 的 `hitNextH`；H=61（light/follow 主门控），H=70（qishu）。
- 切分：按局 GroupKFold（约 5 折），OOF 预测；不随机切帧。
- 选择阈值：在 OOF 的 **v2 候选行**上扫阈值，目标“被否决行里真受击占比 ≥ 65%”且“否决率 ≤ 40%”；同时报告对 v2 实际按下的否决数、被否决按键的历史伤害合计。
- 出口条件（离线）：OOF AUC ≥ 0.70；校准斜率 0.8–1.2；否决的按键平均历史伤害 < 保留按键的 1/3；预计 6 分钟伤害损失 ≤ 8 px。
- 不达标 → 只保留测量，不上 v3。

### 5.4 运行时

- `args.offense: "v3"`；`v2`/`off` 不变；`off` 对拍必须 12/12。
- 权重/阈值导出到 `skills/lib/dufu-offense-policy.js`（`VALUE` / `value(action, s)` / `allow(action, s)`；hazard 模型 `risk(h, s)` 只留诊断），由 `s5_push.py` 推送。
- 每 tick 只在有候选动作时算一次点积（约 15 次乘法），不影响 30 fps。
- trace：`cand`、`gate`（value ×1000）、`pol=3`、`prop=1000`；`result.offense` 增加 `engine:"v3"`、`policy`（版本）、`gate:{vetoes, passes, threshold}`。
- `args.offenseGateThr` 覆盖 value 阈值做 A/B（0 = 全放行，1 = 全否决）；只影响非 execute 动作。

### 5.5 首轮离线结果（2026-11-01，r185–r211）

- 模型：logistic，28 特征，按局 5 折 OOF；**AUC 0.723（61 f）/ 0.705（70 f）**，base 5.5% / 6.2%。
- 机会级：475 次 v2 按键里 61 f 内受击 **20 次（4.2%）**，低于全体 v2 行的 6.2%——规则引擎已经把按键选在低风险窗；按键窗内并不更危险。
- 门控分在按键行上没有区分度：阈值 0.18 否决 131/475（28%），被否决按键的受击率 **16.0%**，保留的也是 **16.0%**；阈值 0.12 否决 63%，17.2% vs 14.0%。即“学到的风险”不能指出哪一次按键会挨打。
- **结论：以“按键后 commit+safety 窗内受击”为标签的安全门控不能把 v2 的挨打/分拉回 1.5**；部署它只会减少输出（被否决按键的平均伤害并不低于保留的）。按 §5.3 的出口条件不通过，不作为可部署版本；v3 接口保留，默认阈值不启用。
- 安全差距的构成（8 局 6 分钟批次）：v2 2.54 vs off 1.58；其中 c11 接触在 v2 有 11 次且全部命中，off 0 次，c11 贡献约 0.48 挨打/分。非 c11 部分 v2 1.95 vs off 1.51（4 对 4，bootstrap 95% CI [−0.17, 0.91]）；用全部 27 局比，v2 非 c11 2.23 vs off 1.53，差 0.71，CI [0.14, 1.35]。进攻会增加长期暴露，但不是“按键瞬间挨打”，逐次按键的即时风险门控抓不到它。
- **M1b（由数据推出的替代门控）**：学“这一下会不会造成持续伤害”，只否决空挥/零伤按键（execute 豁免）。目标是在 6 分钟伤害基本不变的前提下砍掉大部分无效按键和暴露；它仍然只是“否决规则动作”，不新增动作。离线验收：按局 OOF AUC ≥0.60，且 veto 的伤害损失 ≤5%。
- **M1b 首轮离线（bossFill 重放 14 个 v2 局）**：316 个可归因按键、56 个正样本（≥2 px），按局 OOF **AUC 0.647**。阈值 0.14 时 veto **46.8%** 按键，总伤害保留 **95.1%**（execute 1009 px 全部保留；损失的 5% 基本是 light/follow/qishu 的零星 chip）。阈值 0.12：veto 36.7%、保留 96.9%；0.10：veto 28.8%、保留 97.4%。**导出阈值取 0.14**（预先口径：总伤害 ≥95% 下最大否决）。这版的价值是“同样的输出、更少的无效按键/暴露”，不是把 c11 修好；安全收益必须在 2 对 2 里测，离线不能证明。
- **按键真实伤害（14 个 v2 局，bossFill）**：execute 18 次、中位 58 px、合计 1009 px（约 60% 总伤害）；light 230 个可归因、中位 0、86% 零伤、合计 116 px；follow 37 个、62% 零伤、合计 99 px；qishu 49 个、82% 零伤、合计 34 px。**输出主要靠 execute，chip 只占约 15%**——这决定了门控必须保留 execute、只能删空挥。
- **c11 防守链**：命中与是否按键无关（c11 接触在两个臂都是命中），是独立防守里程碑；不放进进攻门控，也不用重训防守模型掩盖进攻回归。

### 5.6 2 对 2 实机筛选与回滚（r212–r215，2026-11-01）

| 局 | 臂 | 结果 | 分钟 | 真值受击 | 挨打/分 | 致命 | boss 伤害 |
|---|---|---|---:|---:|---:|---:|---:|
| r212 | v2 | **dead** | 5.19 | 16 | 3.08 | 42/52 = 80.8% | 149 px (39%) |
| r214 | v2 | time | 5.79 | 23 | 3.97 | 83/93 = 89.2% | 148 px (39%) |
| r213 | v3 | time | 5.79 | 14 | 2.42 | 35/44 = 79.5% | 90 px (24%) |
| r215 | v3 | time | 5.81 | 11 | 1.89 | 43/49 = 87.8% | 18 px (5%) |

- 汇总（独立复算 `contacts.json`）：v2 **3.55 挨打/分、86.2% 致命、非 c11 3.10**；v3 **2.15、83.9%、1.64**。两臂都没过 1.5 / 90%，**筛选失败**。
- 输出：v2 39%/39%，v3 24%/5%，**v3 明显回退**。
- 机制：v3 把按键从 29/33 次压到 9/11 次（gate veto 185/116 个候选 tick），处决 2/2 → 1/0 次，r215 处决按钮 **0 次**。chip 与处决窗的因果关系本轮不足以定因（真气随处决重置、局间波动大）；**输出回退是明确的**。
- **决定：v3 回滚**（默认 `off`，v2 保留），不跑 8 对 8。c11 仍是防守链问题（本轮 v2 5/5、v3 5/10），另开独立防守里程碑。M2 的奖励/标签必须覆盖更长视窗（把后续 execute 机会算进去），不能只看 2 s 伤害。

## 5.7 阶段 A：episode / 节拍数据（2026-11-01，离线）

- **目的**：把防守决策从“逐接触反应”升级到“逐序列/逐节拍”。先只做数据，不改实机。
- **工具**：`tools/dufu_moveid/offense_episodes.py`（提交 `d5d3a5e`）。读阶段一 `live/rNNN/contacts.json`，全部真值接触按 gap ≤ 30 帧聚成 episode；按局号排序后奇偶切 train/val（同一局不跨 split）；输出 `data/moveid/offense/online/episodes.json` + `episodes.md`。
- **schema**：episode 行含 `round/split/start/end/n/first_grp/prefix/pre_gap_f/post_gap_f`；每拍含 `i/frame/gap/off/grp/k/kind/colour/truth_resp/dec_resp/med/tte_err/fatal/presses`；另加 **intended**（pressLog 的预测接触帧落在 beat ±4 帧内）`{key, group, remF, actual_lead}`，用于把按键归到目标拍；`post_gap_f` 用 `result.t0 + fightMs` 的视频帧映射。
- **审计**：r185–r219 共 35 局（31 局口径 = r185–r215，c11 接触 83 个）；2709 接触 100% 分配；1839 episode / 2709 拍；多拍 487、接触 1357（50.1%）；train 18 / val 17，无重叠。
- **c11 节拍**：全接触 episode 主口径 29 个 / 98 拍。gap 两主档 4–6（36/69）与 9–13（22/69）；累计 offset 中位 i1=9、i2=15、i3=21。intended 键 i0 dodge 26/parry 1、i1 dodge 10/parry 6、i2 parry 7/dodge 15。
- **三个答案**：
  1. 不是固定 gap，固定的是累计节拍位置（~9 / ~15 / ~21）；按 index 查表，不用单一 gap 常数。
  2. 没有 k0 闪避成功的证据：29 个 c11 episode 中 28 个首拍 k0 hit，3 个 k1 开头的 episode（c11-only）也没有 k0:c11 覆盖按键；按键级 151 条 k0:c11 dodge 中 real 23 条实际提前中位 1.0 帧（lead=5 子集 0.8，lead=14 子集 12.2–18.3），失败是太晚或太早，不是没按。
  3. c11 index 1/2 共 52 拍、ok=0；intended 里 k1 parry 中位提前 0.4 帧、k2 dodge 0.3 帧，均太晚。对照全部 episode index 1/2 的 ok 率 73.5%/78.2%，ok 由 parry 支撑（intended actual lead 中位 7.5）。
- **可行动上界**：按每拍 truth_resp + 默认 lead/冷却，c11 73/98 拍可排（74.5%），整链 9/29；主要损失是 k2 dodge 与 k0 dodge 的 500 ms 冷却冲突（fast 档 k0→k2 只隔 10–11 帧）。
- **阶段 B 候选（未实施）**：
  - **S（推荐）**：识别到 k0:c11 后跳过 k0 dodge（数据上 k0 dodge 从未盖住），预排 **k1 parry（offset1−10）** + **k2 dodge（offset2−5）**。离线覆盖上界：k1 27/27、k2 25/25，至少一拍 27/29、两拍 25/29（未计 episode 外冷却）。
  - **K（保守）**：保留 k0 dodge，再预排 k1 parry + k2 dodge；k1 parry 需越过 `armed.dodge` 的 6 帧 GRACE 阻挡，k2 dodge 在 fast 档与 k0 dodge 冷却冲突（仅 11/25 可排），三拍全排 11/29。
  - 两者都 arg-gated（`args.seqDefense`，默认 false），不改 `off` 行为；先在 `tests/dufu2_scenarios.mjs` 用 k0 1500 / k1 1510 / k2 1521 验证至少 2 个正确按键，再用 `episodes.json` 复核覆盖，不达标不上机。

## 6. M2：学习型动作排序（M1 稳定后）

- 候选仍是 `pick` 给出的可行动作（execute/light/follow/qishu/no-op）。
- **奖励窗口改为 15–30 s（2026-11-01 修正）**：`reward = 窗口内 boss 伤害 px - λ·挨打 - μ·致命 - ν·commit_ms`。2 s 标签会被 v3 的教训误导——chip 按键可能在给后续 execute 铺路，砍掉 chip 反而丢 execute（r212–r215）。窗口里同时记录 execute 次数、boss 真气变化和 c11 命中。
- 归因：同窗口内有多次按键时，用“第一次按键 + 后续按键折扣”或只取无其它按键的窗口；不能把整段伤害都算给一次按键。
- 模型：cost-sensitive 线性打分 / 浅表（contextual bandit 的离线近似）；安全是硬约束（防守链 / M1 门控先过滤）。
- 只在放行的状态做**安全探索**：ε ≤ 0.05，避开 c11、低血、防守忙、幕布、火球雨；记录 `prop`。
- 评估：IPS/DR；数据不足时只做“规则候选重排”，不假装能评估所有反事实动作。
- 上线顺序不变：2 对 2 → 8 对 8；每次只改一个变量（特征 / 门控 / 排序），失败回滚。
- 前置条件：c11 防守链里程碑先过；否则安全差异会盖过排序器的收益。

## 7. M3：批次闭环与策略注册表

每 4–8 局：

```
loop.py ab (v2 vs vN, 6 min) -> ingest -> offense_online.py build -> train -> eval
  -> 2 对 2 筛选 -> 8 对 8 晋级 -> promote / rollback
```

- 注册表 `data/moveid/offense/online/registry.json`：`tag`、训练局清单、特征/超参、OOF 指标、live A/B 指标、是否 promoted、回滚原因。
- 自动报告：安全（挨打/分、致命、金）、输出（6 分钟 boss %）、c11 窗、execute 成功率、每局明细、回滚原因。
- 晋级条件：6 分钟安全门全过 + 输出不低于上一版（≥30%，且不低于 v2 的 -2 pp）。只改一个变量；失败回滚，不重训防守掩盖。

## 8. Gate 与 A/B 口径

- **安全门**：6 分钟/局；挨打/分 ≤1.5、致命 ≥90%、金被卸 ≤3%（按汇总接触算）。
- **输出**：6 分钟 boss 伤害 ≥30%（stretch 35%）；v3 不能比 v2 低 2 pp 以上。
- **筛选**：2 对 2、6 分钟；**晋级**：8 对 8、16 局、6 分钟。
- 每批用 `contacts.json` / `result.json` 独立复算（`s5_ab` 只作参考），报告每局 c11、动作分布与真实持续伤害。
- c11 命中是防守链问题，不算进攻输出；门控只能减少进攻暴露。

## 9. 回滚与停止

- 任一门不过：不晋级，`args.offense` 默认仍是 `off`，v3 保留 opt-in 供复查。**首轮 v3 已按此回滚（§5.6）。**
- 新读数（§4.1）与旧读数在真实伤害台阶上冲突：停，先修读数。
- 训练集 < 6 局或 OOF 不达标：只积累数据，不上机。
- 出现死亡页/守卫长时间 busy/录像启动失败：按 `loop.py` 现状停批，不续跑，先看日志。
- 不在同一批里同时改防守模型、进攻 q、ROI 读数和门控。

## 10. 里程碑检查表

| 步骤 | 产物 | 通过标准 | 结果（2026-11-01） |
|---|---|---|---|
| M0.1 BOSS_ROI | `offense_boss_roi.py` + `boss_roi.json` | 假掉/假升显著下降，真实台阶保留 | **通过**：15 Hz 假掉 320 → 2；处决台阶 57.3–58.0 → 57.5–58.0 |
| M0.2 trace | `dufu2.js` 新列 + 测试 | pytest / node --check / off 对拍 12/12 | **通过**：41 passed、off 12/12 |
| M0.3 机会数据 | `offense_online.py build` + `audit.md` | 每局机会数、动作/伤害表可复算 | **通过**：27 局 / 244,458 行 / 16,853 机会 / 475 按键 |
| M1.1 训练 | `train` + `eval.json` | AUC ≥0.70，校准 0.8–1.2，否决伤害损失 ≤8 px | hazard AUC 0.723 但按键行无 lift；value AUC 0.647 |
| M1.2 导出 | `dufu-offense-policy.js` | 纯 JS、无依赖、pytest 通过 | **通过**（含 Python↔JS fixture 对拍） |
| M1.3 v3 | `offense:"v3"` 接线 | `off` 12/12，v2 不变 | **通过** |
| M1.4 筛选 | 2 对 2、6 分钟 | v3 安全不差于 v2 且输出不明显下降 | **失败/回滚**：v3 2.15 vs v2 3.55 挨打/分，输出 24%/5% vs 39%/39% |
| M1.5 晋级 | 8 对 8、16 局 | 安全门全过 + 输出 ≥30% | 未跑（筛选失败，按 §9 回滚） |
