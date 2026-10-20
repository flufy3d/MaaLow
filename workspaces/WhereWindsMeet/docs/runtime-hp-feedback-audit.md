# 737 低血 HP 反馈振荡：运行时复现与修复（2026-10-20）

本轮只读本地录像、逐帧特征、运行日志和存档源码；没有运行游戏，没有推送工作区，没有修改 `labels.json` / 审计样本 / 守护 / 调度参数。改动只在两个 Skill 文件、测试文件和本报告，均未 commit。

## 结论

737 末段的 7 次 `21%/20%->17%` 不是 7 次独立扣血。离线 HP 在 f5960–6060 只有两个量化值：`16.93%`（43/254）和 `17.32%`（44/254）；7 次运行时 hit 的 after 全部落在 `16.9%–17.3%`，before 却在 `19.7%–21.3%`。这次真实下降在事件 2744 / f5867 已经单独记录；2790–2850 的 7 条都是同一扣血的重复读数，低血灰条读数反复回到约 21%，每次回落后又被当成一次新 hit。

根因有两层：

1. `health()` 先读灰条，只要灰条非空就返回。低血时血条已经是红条，但红条右端的亮边、旧血灰色残影/受击白闪也能被“低饱和 + 高亮度”的灰条掩码命中，连通域从 `HP_LEFT` 一直延伸到填充右侧约 8–11 px，于是同一帧读出 21% 而不是红条的 17%。运行时截图是设备原始全色度画面；离线录像经过 H.264 4:2:0，色度被压掉/变暗，同一位置的灰掩码读不到，所以离线只看到红条 17%。这是采集介质差异，不是两份 HP。
2. `feedback()` 把 `hpNow` 同时当作“显示/喝药值”和“受伤基线”。任何一次向上误读都会把基线抬到 21%，下一次正确的 17% 就满足 `h < hpNow - 0.025`，再次调用 `onHit()`。`onHit()` 又加 stagger、清/保留计划、安排 hitEscape 卸势和 posthit，形成“误 hit -> 额外动作/白闪 -> 再误读”的放大器。

修复分两处，互为兜底：

- `health()`：灰条 > `HP_RED_MAX` 时保持原行为（高血完全不变）；低血区间优先红条，红条不可读时才回退灰条。
- `feedback()`：新增 `hpBase` 作为已确认受伤基线；向下走时更新，向上跳变只有喝药 `+POTION_HEAL`、喝药确认后的回填窗口、或无喝药的整 `+POTION_HEAL` 回血才重置。`hpNow` 仍记录最新读数，喝药的晚到回血逻辑不变。

## 1. 复现证据

### 1.1 数据与时间对齐

- 运行日志：`data/tmp/dufu_ml/unified/r737.run.json`，`value.start=1792461937469`，3272 条事件，`hits=34`、`oks=42`。
- 逐帧特征：`data/tmp/dufu/r737.json`，7318 帧；`hp` 列由 `data/tmp/dufu/f6.py` 调用 `hpchain.health(f, True)` 生成（灰条优先，和运行时同一个规则）。
- 源码快照：`data/tmp/dufu_breakthrough/review30/r737.source.js`，SHA256 `2eac9b45f032…`；其 `feedback()` 与修复前的当前实现逐行一致，`health()` 从 `./lib/dufu-reads.js` 导入（历史 lib 字节未记录，见“限制”）。
- 对齐沿用审计注册表：`estimated_video_frame = (event_epoch_ms - seff) * 30 / 1000`，737 的 `seff=1792461937446`（`data/attack_audit/20261020/alignment.json`）。事件 2797 得到 f5970.33，与计划里写的 f5970 一致。

### 1.2 事件表（events 2790–2850）

| event | epoch_ms | 估计帧 | 运行时 hit | drop | 该帧离线 hp | onHit 后的 stagger / escape 行为 |
|---:|---:|---:|---|---:|---:|---|
| 2797 | 1792462136457 | 5970.33 | `21%->17%` | 3.5% | 17.32（窗口 17.32） | 100 ms；escape parry at +100 ms，计划内 k0 卸势正好在附近，press +156 ms |
| 2818 | 1792462137425 | 5999.37 | `21%->17%` | 4.3% | 16.93（窗口 16.93–17.32） | **300 ms**（`staggerByDrop` 的 >4% 档）；escape parry +300 ms，press +336 ms；401 ms 后下一条 hit |
| 2824 | 1792462137826 | 6011.40 | `20%->17%` | 2.8% | 16.93（窗口 17.32–16.93） | 100 ms；escape parry +100 ms，随后 `parry given up (+214 ms past the stagger end)`；387 ms 后下一条 hit |
| 2829 | 1792462138213 | 6023.01 | `21%->17%` | 3.9% | 16.93（窗口 16.93–17.32） | 100 ms；escape parry +100 ms，126 ms 后被下一条 hit `superseded` |
| 2833 | 1792462138339 | 6026.79 | `20%->17%` | 2.8% | 17.32（窗口 17.32） | 100 ms；`superseded by a new hit`，press +164 ms；537 ms 后下一条 hit |
| 2839 | 1792462138876 | 6042.90 | `21%->17%` | 3.5% | 16.93（窗口 16.93–17.32） | 100 ms；press +107 ms；301 ms 后下一条 hit |
| 2844 | 1792462139177 | 6051.93 | `21%->17%` | 3.9% | 16.93（窗口 16.93–17.32） | 100 ms；press +99 ms；窗口内没有下一条 hit |

表中 `drop` 来自运行时日志。反推 before 的量化值约为 `19.7%–21.3%`（50–54/254），after 为 `16.9%–17.3%`（43–44/254）。7 次事件分布在 f5970–f6052，约 2.7 s，间隔 126–968 ms 不等；不是 7 次均匀到来的攻击。

**这 7 条之前已经有一条真实下降。** 事件 2744（估计 f5866.9）报过 `21%->17%`（drop 3.5%，stagger 100 ms，escape parry），正好对齐离线 f5863–f5878 的下降（`21.65% -> 19.69% -> 18.9% -> 17.72% -> 17.32%`，之后稳定在 `17.3/16.9%`）。2790–2850 的 7 条都发生在离线 `17.3/16.9%` 平台之后：第一条 2797 已比真实下降晚约 103 f（按 `seff` 估计），后面 6 条更晚。因此这 7 条全部是同一扣血的重复读数，不是“1 真 + 6 假”，也不是 7 次新扣血。

### 1.3 离线 HP 没有 7 次下降

`data/tmp/dufu/r737.json` 的 f5960–6060（101 帧）只有：

| 离线 hp | 计数 |
|---:|---:|
| 0.173228（44/254） | 59 |
| 0.169291（43/254） | 42 |

没有 0.20–0.21 的帧。f5983 有一个 `44/254 -> 43/254` 的 0.4% 量化变化，远低于 `HIT_DROP=2.5%`，不是扣血；它可能是某些“最近扣血”对齐把 2797 吸到 5983 的原因，但不能解释 4% 的运行时 drop。用 OpenCV 独立重读录像 f5960–6061 的 HP ROI（同一套 `hpchain` 掩码）得到：灰条 `None` 102/102 帧，红条 `16.93%` / `17.32%`。也就是说，离线文件里的 17% 是红条读数，录像上灰条根本没有 21% 的有效读数。运行时的 21% 只能来自运行时截图上的灰条分支（或同一帧上灰条先返回），而不是另一份离线 HP。

另：该 JSON 的 `grey` 列是 `f6.py` 对画面中部 `S<=30` 的比例（约 0.045–0.093），不是灰条 HP，不能拿来解释 21%。

### 1.4 计数影响

737 运行日志 `hits=34`，离线 seq hit=29。34 里已经包含 2744 那条真实下降；2797–2844 的 7 条是重复。全部去掉是 27；如果 P0a 按簇保留其中一条作 primary，则是 28。两种算账分别是 -2 / -1，剩余差异来自两套检测/采样，不应靠这次修复解释。审计报告的 p90 29.53 f 主要就是这簇重复事件，P0a 的去重仍应按原计划单独做，本报告不改 `alignment.json`。

## 2. 根因

### 2.1 `health()` 为什么在 17% 读出 21%

修复前：

```js
const grey = read(HP_GREY);
if (grey != null) return grey;
const red = read(HP_RED);
return red != null && red <= HP_RED_MAX ? red : null;
```

- `HP_GREY` 的掩码是 `S<=45, V>=140`（不饱和、亮），原本用于高血的灰色血条。
- 最符合现有证据的解释：低血时血条本体是红色，红条本身不满足灰掩码；但红条右端的抗锯齿边、旧血灰色残影、受击白闪是“亮 + 低饱和”的。`read()` 只要求第一个连通域从 `HP_LEFT` 开始，然后按 `HP_GAP=12` 把后续小框拼起来；红条左端 + 右端灰色残影会被拼成一个从 415 到约 469 的灰条，得出 `(469-415)/254 ≈ 21%`，而红条只到约 458（17%）。
- 运行时截图是设备原始全色度画面（`SkillRun.screenshot()` 直接取 Maa image）；录像 H.264 4:2:0 会平均/压低右端色度，使同一位置不再满足 `S<=45, V>=140`。因此离线重读只看到红条 17%，运行时却间歇看到灰条 21%。这解释了“离线稳定 17、运行时 21”而不需要假设两次不同扣血。
- 21% 只间歇出现（7 次/2.7 s），符合“亮边/白闪只在部分帧成立”而不是持续的第二条血条。

### 2.2 `feedback()` 为什么把一次扣血变成 7 次

修复前：

```js
const h = hpRead();
if (h != null) {
    if (hpNow != null && h < hpNow - HIT_DROP && h > hpNow - 0.35) onHit(now, hpNow, h);
    hpNow = h;
}
```

`hpNow` 同时是显示值、喝药判断值和受伤基线。序列是：

```text
读 17  -> hpNow=17
读 21  -> 向上，不判 hit，hpNow=21
读 17  -> 21-17=4% > HIT_DROP 2.5%，onHit，hpNow=17
读 21  -> 向上，hpNow=21
读 17  -> 又 onHit
...
```

每次 `onHit()` 的副作用都在放大问题：

- `staggerUntil = max(staggerUntil, now + stg)`，把后续防守动作继续往后推；
- `keepPlanOnHit` 下保留/丢弃计划项，日志里能看到 `- parry k0 hit pressed`、`0/0 dropped` 等；
- `hitEscape` 在每个 hit 的 stagger 结束安排一次卸势；新 hit 会 `superseded` 旧的，或让旧的 `given up`；
- `posthit` 还会追加保险卸势。

所以这不是“多记了 6 个数”，而是多推了 6 次 stagger、多发了若干次 escape 卸势，确实会放大死亡末段的动作阻塞。

## 3. 补丁

### 3.1 `skills/lib/dufu-reads.js` — 低血优先红条

```js
const grey = read(HP_GREY);
// 高血：灰条权威，保持原来的一次读取路径（也保持原来的开销）
if (grey != null && grey > HP_RED_MAX) return grey;
// 低血：血条本体是红条；灰掩码会把红条右端的亮边/白闪读成更长的灰条
// （737 f5970-6051：17% 红条被读成 21%）。红条可读时优先红条，灰条只做回退。
const red = read(HP_RED);
if (red != null && red <= HP_RED_MAX) return red;
return grey;
```

和任务里建议的两个方向相比，这里采用了更强的“低血红条优先”，而不是只加 `grey-red > 0.02`：

- 在 `grey <= HP_RED_MAX` 的区间，血条按 `combat.js` 的注释本来就是红条，灰条读数在该区间不是可信来源；无论灰条偏高还是偏低，都应让红条说话。
- 高血行为被 `grey > HP_RED_MAX` 的提前返回完全保护：灰条 46% 以上时不会读红条，也不会被红条特效覆盖。
- 离线抽查五轮（733/734/737/738/745）中，离线 hp 28–50% 的帧红条全部不可读（每轮 40 帧），10–30% 的帧灰条和红条从未同时有效（737/738/745/733 各抽查 120 帧；734 该区间没有帧）。所以这个分支在正常录像上几乎不改变读数，只在运行时“灰条有效且红条也有效”的分歧帧生效。

代价：低血时每帧多一次 `color()`。`health()` 是 `perFrame` 缓存、每帧一次；现有 `ms.reads` p50 3 ms / p95 5 ms（run.json），预算 40 ms，风险很小。

### 3.2 `skills/dufu.js` — 已确认受伤基线

状态：

```js
let hpNow = null;   // 最新读数：显示 / 喝药
let hpBase = null;  // 已确认受伤基线：只跟下降或被解释的回血
```

`feedback()`：

```js
const h = hpRead();
if (h != null) {
    if (hpBase == null) hpBase = h;
    else if (h < hpBase) {
        if (h < hpBase - HIT_DROP && h > hpBase - 0.35) onHit(now, hpBase, h);
        hpBase = h; // 每个下降步都跟，避免小扣血累积成延迟 hit
    } else if (h > hpBase) {
        const drink = potionPend ?? potionLate;
        const healing = (drink != null && h >= drink.hp0 + POTION_HEAL)
            || (lastPotionOkAt > 0 && now - lastPotionOkAt <= POTION_SETTLE_MS)
            || h - hpBase >= POTION_HEAL;
        if (healing) hpBase = h;
    }
    hpNow = h;
}
```

理由：

- **同一扣血只触发一次**：after 写入 `hpBase` 后，下一次回到 17% 不再满足 `h < hpBase - HIT_DROP`。21% 的向上跳变只有 4.3 个百分点，小于 `POTION_HEAL=8`，没有喝药解释时不会重置基线。
- **真实下降仍触发**：80%->75% 是 5 个百分点，超过 2.5%，照常 `onHit`；高血读数也不经过新的红条分支。
- **喝药不被吞**：`potionPend/potionLate` 下，只有读数达到 `hp0 + 8%` 才抬基线，和 `potionTick()` 的确认阈值一致；确认后的 `POTION_SETTLE_MS=2500 ms` 内继续接受血条回填。20%->40% 会被认作回血，随后 40%->35% 仍会触发一次真实 hit。
- **晚到回血**：`potionLate.hp0` 是喝药中被打后的当前血；之后回到 `hp0+8%` 以上时 `potionTick()` 本来就会计一次 late heal，`feedback()` 同步抬基线，不会在回血后再误报一次 hit。
- `hpNow` 仍是每帧最新读数，喝药判断、`aux[7]`、日志显示的行为不变；它可能仍在 17/21 之间抖，但不再参与 hit 判定。

没有改 `combat.js` 的同名 `health()`（`zhenshou.js` 等还在用），也没有改 `dummy.js` 的灰条专用读取。它们是否也要低血红条优先，属于另一个改动面，见“风险/后续”。

## 4. 测试

### 4.1 新增覆盖

都在 `tests/dufu_scheduler.mjs` 的现有假时钟框架里；HP 由 `globalThis.color` 的 ROI 分支返回一个宽度可变的框（`cfg.hp(time)`），没有调用真实 `color()` / `screenshot()`，也不依赖设备。

| 测试 | 覆盖 |
|---|---|
| `health prefers the red bar over a low-HP grey overread` | 灰 21.26% / 红 16.93% 同帧时返回 43/254；灰偏低 13% 时同样取红 16.93%；灰不可读时红条仍工作 |
| `health keeps the grey bar above the red range` | 灰 60% / 红 20% 时仍返回灰 60%；灰 21% / 红不可读时保留灰回退 |
| `a 21/17 low-HP oscillation triggers one hit` | 21/17 方波只产生 1 次 hit；同文件内的 `legacy` 计数器证明旧“每次读数比大小”的规则会在同一序列上触发 ≥3 次 |
| `a real 80%->75% drop still triggers` | 高血真实 5% 下降仍恰好 1 次 hit |
| `a potion 20%->40% is not a hit and the heal is not swallowed` | 喝药回血不计 hit，`potion.healed=1`，随后 40%->35% 仍计 1 次 hit |
| `a late potion heal after a hit during the drink is still counted` | 喝药中被打 20%->10%，晚到回血到 50% 计 `lateOks=1`，随后 50%->45% 仍计 hit |

晚到回血测试额外传了 `potionRetryMs: 5000`，只用于避开一个**既存**的喝药重按路径：当前 `potionTick()` 在喝药中被打后会清 `potionPend`、设 `potionLate`，但 `slowPotion()` 不检查 `potionLate`，过了 `potionRetryMs`（默认 600 ms）还可能再点一次，测试里会看到 `healed 2/1`。这不是本次改动引入的，也没有在本次修复（超出 P0b 范围），已在风险里列出。

### 4.2 命令与结果

```text
node tests/dufu_scheduler.mjs
PASS ×17（含上述 6 条新测试）

uv run pytest -q
40 passed in 1.71s

node --check workspaces/WhereWindsMeet/skills/dufu.js
node --check workspaces/WhereWindsMeet/skills/lib/dufu-reads.js
node --check tests/dufu_scheduler.mjs
全部通过
```

旧行为的区分度：

- 振荡测试里的 `legacy` 计数器按 `h < prev - 0.025` 逐帧比较，同一方波得到 4 次 hit；新实现只 1 次。若有人把 `feedback()` 改回逐读数比较，这条测试会失败。
- 旧 `health()` 在同一测试帧会先返回灰条 54/254（21.26%），新实现返回红条 43/254（16.93%）；`health prefers...` 会失败。

## 5. 风险与限制

1. **低血红条优先的误读风险**：如果红条掩码在低血区间被红色特效误命中，可能把 17% 读成更低。红条掩码要求左端在 `HP_LEFT+8` 内、`H 0–6/174–180`、`S 100–175`、`V 165–255`，且连通域至少 4 px；离线五轮抽查没有发现 28–50% 区间红条可读的帧，10–30% 区间也没有灰/红同时有效的帧。但这是抽样，不是全量证明。
2. **每帧多一次颜色读取**：只在灰条 `<=45%` 时发生。若上机发现 `ms.reads` p95 明显上升，可把红条读取限制在“灰条存在且灰条 <=45%”并保留缓存；当前未做额外优化。
3. **无喝药的大跳变**：`h - hpBase >= 8%` 会当作回血重置基线。单帧灰屏/特效造成 8–35% 的虚假上跳仍可能在随后下跌时产生一次误 hit（>35% 的下跌被 `h > hpBase - 0.35` 挡住）。737 的实际误读只有 4.3%，低于 8%，不会触发。如果上机看到这种大跳变，建议改成“连续 2 帧保持”再重置，而不是放宽。
4. **小于 8% 的非喝药回血**：不会重置基线，之后如果真实 hit 落在旧基线之上，可能漏一次。当前已知的回血来源是喝药（`potionPend/potionLate/lastPotionOkAt`），已覆盖；没有证据表明独夫还有别的回血。
5. **`hpNow` 仍可能显示 21%**：它保留“最新读数”语义，显示/喝药阈值可能仍看到 17/21 抖动；hit 判定和喝药确认已不受影响。若要求显示也稳定，可在无解释上跳时令 `hpNow = hpBase`，但那会把真实的小回血藏起来，本次不做。
6. **`combat.js` 的同名 `health()` 未改**：`zhenshou.js` 等仍灰条优先；如果它们也有低血误读，需要单独评估，不能假设本次修复覆盖所有 Skill。
7. **历史 lib 字节未知**：`rounds.json` 只登记主源码 SHA256，`r737.source.js` 的 `health()` 来自 `./lib/dufu-reads.js`，历史 lib 未被逐字节保存。能确认的是：快照的 `feedback()` 与修复前当前代码一致，当前 `health()` 是灰条优先，且 737 的 21/17 现象与之吻合；不能证明当时加载的 lib 与当前文件逐字节相同。
8. **既存喝药重按**：见 4.1，`potionLate` 等待期间 `slowPotion()` 可在 600 ms 后再点一次，导致 `healed 2/1`。本次测试用 `potionRetryMs` 避开，未修改生产逻辑。
9. **不改审计数据**：`alignment.json`、`labels.json`、90 样本和 P0a 的去重输出都不动；本报告只解释运行时 hit 重复，不把 7 条从离线统计里删掉。

## 6. 上机验证项（只列，未执行）

1. **低血重复 hit**：在 15–25% 血段跑一局，抓 `hit` 事件；确认不再出现连续 `21%->17%` / `20%->17%`，同一段只应有一条真实下降。对照 `hits` 与离线 seq 的差值是否从 737 的 +5 降到 ±1–2。
2. **红条读数**：低血时连续截 30 帧，分别用灰/红掩码读 HP；确认红条有效时不再返回灰条的 21%，灰条不可读时仍有回退值。
3. **真实高血下降**：80%->75%（或任意 5% 下降）仍只报 1 次 hit，`staggerByDrop` 档位仍按 drop 选 100/300/500 ms。
4. **喝药**：20% 喝药到 40%，确认 `potion healed`、`gains≈0.20`，回血过程不产生 hit；随后一次真实 40%->35% 仍报 hit。
5. **晚到回血**：喝药中被打后回血，确认 `lateOks=1` 且没有在回血后补报 hit；同时记录是否会触发第 8 条的二次点药。
6. **性能**：看 `result.ms.reads` 的 p95 和 `loop` 预算；低血段每帧多一次 `color()` 不应把 p95 推过预算。
7. **显示**：`aux[7]`/potion 日志仍可能看到 17/21 抖动；确认它不再改变 hit、stagger、escape 计数。
8. **回滚**：只需回退 `dufu-reads.js` 的 `health()` 尾段和 `dufu.js` 的 `hpBase` + `feedback()` 两处；没有新增 args、配置或数据文件。回滚后 737 式重复 hit 会回来。

## 7. 文件与 diff 摘要

改动文件：

```text
workspaces/WhereWindsMeet/skills/lib/dufu-reads.js   health() 低血红条优先
workspaces/WhereWindsMeet/skills/dufu.js             hpBase + feedback() 确认基线
tests/dufu_scheduler.mjs                             6 条新测试 + HP stub
workspaces/WhereWindsMeet/docs/runtime-hp-feedback-audit.md  本报告
```

没有 `git add` / `commit`；没有改 `labels.json`、`data/attack_audit/20261020/` 的样本或 `alignment.json`。`dufu.js` 在本轮之前已有未提交改动，本次只在其 `feedback`/状态段追加，未回退既有改动。

关键 diff（完整内容见文件）：

```diff
--- a/workspaces/WhereWindsMeet/skills/lib/dufu-reads.js
+++ b/workspaces/WhereWindsMeet/skills/lib/dufu-reads.js
@@
-    const grey = read(HP_GREY);
-    if (grey != null) return grey;
-    const red = read(HP_RED);
-    return red != null && red <= HP_RED_MAX ? red : null;
+    const grey = read(HP_GREY);
+    if (grey != null && grey > HP_RED_MAX) return grey;
+    const red = read(HP_RED);
+    if (red != null && red <= HP_RED_MAX) return red;
+    return grey;
```

```diff
--- a/workspaces/WhereWindsMeet/skills/dufu.js
+++ b/workspaces/WhereWindsMeet/skills/dufu.js
@@
     let hpNow = null;
+    let hpBase = null;
@@ feedback()
-            if (hpNow != null && h < hpNow - HIT_DROP && h > hpNow - 0.35) onHit(now, hpNow, h);
+            if (hpBase == null) hpBase = h;
+            else if (h < hpBase) {
+                if (h < hpBase - HIT_DROP && h > hpBase - 0.35) onHit(now, hpBase, h);
+                hpBase = h;
+            } else if (h > hpBase) {
+                const drink = potionPend ?? potionLate;
+                const healing = (drink != null && h >= drink.hp0 + POTION_HEAL)
+                    || (lastPotionOkAt > 0 && now - lastPotionOkAt <= POTION_SETTLE_MS)
+                    || h - hpBase >= POTION_HEAL;
+                if (healing) hpBase = h;
+            }
             hpNow = h;
```

测试入口：

```text
node tests/dufu_scheduler.mjs
uv run pytest -q
node --check workspaces/WhereWindsMeet/skills/dufu.js
node --check workspaces/WhereWindsMeet/skills/lib/dufu-reads.js
node --check tests/dufu_scheduler.mjs
```
