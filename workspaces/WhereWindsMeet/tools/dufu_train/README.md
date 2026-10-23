# dufu_train：独夫阶段二 head 微调

从 `unified_head9s.onnx` 微调出阶段二 head（`model/dufu/unified_head_p2.onnx` + `.json`）。backbone `unified_back9.onnx` 不动：trace 里存的就是它每帧的 192 维特征，head 只在这些特征 + 15 列 aux 上训练。

## 数据

`data/p2/rNNN/`（git 忽略，脚本每次重新扫描，没写完的轮次自动跳过）：

- `trace.json`：`dufu.js` 的 `trace:"feat"` 事件块。一行 = 一个 backbone 帧 = 设备特征环的一项：`wall, seq, cap` + 15 列 aux（与环里相同，取 3 位小数）+ `feat_f16_b64`。
- `result.json`：`maalow do skill dufu` 的输出，`value.events` 里有 `hit`/`ok`/`flare`/`dead` 等标记。
- `rec.txt`：录像 id，只有 `check_align.py` 用。

采集命令：`uv run maalow do skill dufu --args '{"phase":2,"trace":"feat"}'`，跑完从 `/events?type=skill_event` 取 `dufu_trace`（见 dufu.js 的 TRACE_EVENT 注释）。

## 命令

GPU（RTX 50 系要 cu130 的 torch；没有 CUDA 时自动用 CPU，数据量小，CPU 也能跑）：

```
# 训练 + 5 折按轮交叉验证 + 导出 model/dufu/unified_head_p2.onnx/.json
uv run --with torch --index https://download.pytorch.org/whl/cu130 --with onnx --with onnxruntime \
    python workspaces/WhereWindsMeet/tools/dufu_train/train.py data/p2

# 只看指标、不导出；换名字、换验证方式
... train.py data/p2 --no-export --name p2try
... train.py data/p2 --cv 0 --val-every 5        # 单一划分：轮号 %5==0 做 val，导出早停的那个模型

# 用 onnxruntime 给导出的文件打分（例如只看训练之后新采的轮次）
uv run --with numpy --with onnxruntime python workspaces/WhereWindsMeet/tools/dufu_train/evaluate.py data/p2 \
    --heads dufu/unified_head9s.onnx dufu/unified_head_p2.onnx --from r019

# 对时：录像里血条 / 真气条台阶相对 trace 行的帧差
uv run --with numpy --with opencv-python-headless python workspaces/WhereWindsMeet/tools/dufu_train/check_align.py data/p2 r002
```

上机：`uv run maalow do skill dufu --args '{"phase":2,"head":"dufu/unified_head_p2.onnx"}'`（先 `maalow sync WhereWindsMeet --push`）。不给 `head` 时仍用 head9s；阶段一行为不变。

## 文件

| 文件 | 内容 |
|---|---|
| `data.py` | 读轮次；窗口 = 第 i 行往前 30 行，不够时用最早一行在前面补齐（同 dufu.js `seqData` / 设备环），环里有 12 行才跑 head |
| `model.py` | head9s 的 PyTorch 移植（2 层 GRU 128 + 各输出头；ONNX 门序 z,r,h → torch r,z,n），从 ONNX 读权重，按同样的 IO 导出（opset 17） |
| `labels.py` | 接触点和逐行目标（见下） |
| `metrics.py` | 调度器口径的触发指标 |
| `train.py` | 蒸馏 + 监督微调、交叉验证、导出 |
| `evaluate.py` | 用 onnxruntime 给任意 head 文件打分 |
| `check_align.py` | 用录像核对标签时间 |
| `replay.py` | 卸势按键策略的离线回放评估器（`validate` / `tune`），含现行调度器的近似和节拍策略 |
| `cache_heads.py` | 把 head 在每一行的输出缓存给 replay.py |
| `train_press.py` | 训练 lead1f 分支，导出 `unified_head_p2e.onnx`（head p2 原样 + 追加列） |

## 标签

- **接触点**：`hit` 标记（dufu.js 的 hpBase 逻辑，掉血 ≥2.5%）对应的行；掉血发生在上一行和这一行的截图时刻之间（取中点），接触 = 该时刻 − 5 帧（阶段一的定义：受击比血条变化早约 5 帧）。卸势成功 = boss 真气台阶（8–80 px）且我方 24 帧内按过卸势（自己进攻打中也会削真气，那种不带近期卸势）；时间取台阶中点。ok 和 hit 相隔 6 帧以内算一次。
- **fut1–3**：从该行截图时刻到后面第 1/2/3 个接触的帧数，按 head 的 11 档分箱（>60 帧为 none）；**fut1f**：1–45 帧上 σ=1 帧的高斯软标签。
- **def1–3**：接触前 2–30 帧内有金光（aux `flare` 的图像规则起点）→ 闪避，否则卸势；没有接触 → none。阶段二没有幕布，def 不出 curtain。
- **def 按结果（`--def-from-outcome`）**：非金光接触的 def 改由我方按键的结果定：ok → 卸势；掉血且接触前 4–15 帧（墙钟）内按过卸势（96% 的 ok 在这个窗口里有一次按键，ok 的按键集中在 6–12 帧）→ 闪避（“卸势接不住”）；掉血但窗口里没按 → 未知，这一项 def 权重 0（fut 不变）。抓取过场的后续几下（掉血串：间隔 ≤1.6 s，第一个间隔 1.25–1.55 s、后两个 0.6–0.85 s）也算未知。金光照旧闪避。val 额外报 def1 P(dodge) 在 ok 与“卸势接不住”接触上的分离度（接触前 10–19 帧行的均值；AUC 和 0.3/0.5/0.6/0.7 阈值下两边被判闪避的比例）。配合 dufu.js 的 `defDodgeP` 用。
- **跳过轮次（`--skip r058-r067`）**：r058–r067 的 aux `flare` 是逐帧图像规则，噪声大，训练时排除。
- **权重**：死亡那一下之后、以及没死却到了 trace 末尾 60 帧内的行权重为 0；前方 60 帧内有闪避按下、或有没接上接触的金光的行权重 0.3（闪开的那下看不见，“没有接触”不可靠）。接触前 4–19 帧的行再乘 `--pos-w`（默认 6；交叉验证里 3 的覆盖率低很多，6 在 0.45 阈值下的误触发 runs 和原 head 持平）。
- **蒸馏**：combo、stage、ours、cont、land 向原 head 在同一窗口上的输出做 KL；tell 也蒸馏，但幕布类的概率挪到 none，暗场类在非暗行（aux `dark3`=0）也挪到 none。fut1 另加一点向原 head 的 KL（`--kd-fut`），所有可训练参数加 L2-SP（`--l2sp`）拉向原权重。
- 默认只训练第 2 层 GRU 和各输出头（`--train gru2`）；`heads`（只训输出头）在交叉验证里明显差，`all` 和 gru2 差不多但更容易过拟合。

## 指标

S1 = fut1 的 4–19 帧档概率和，调度器在 S1 ≥ 0.45（`TRIG_TH`）时出手。

- **覆盖率**：接触前 19..3 帧内有一行 S1 ≥ 0.45 的接触占比，按 hit / ok / 金光分开报。
- **误触发**：存活且未被屏蔽的行里，S1 ≥ 0.45 但后面 25 帧内没有接触的行数/分钟；`runs` 把连续的这种行算一次，大致对应一次多余的按键。
- `sweep`：同样的指标在 0.3 / 0.6 阈值下的值，用来在相同误触发量下比较排序能力。
- 交叉验证的 val 指标是 out-of-fold 的：每一轮都由没见过它的那一折模型来打分。导出的模型用全部轮次训练，epoch 数取各折最佳 epoch 的中位数 + 1；它的 in-sample 指标只作参考。

## 存疑

- 阶段二很多 S1 高的行后面既没掉血也没有真气台阶。在录像里看，一部分是 boss 离得远、真的没打过来，另一部分是招打空了，或者卸势了但真气没动。后者在标签里算“没有接触”，所以误触发数字偏高，模型也会被往保守方向拉。
- 掉血的对时很紧：录像里血条台阶相对行时刻的帧差，在同一轮内 75% 落在中位数 ±1 帧以内（399 次掉血）。卸势 ok 的接触时间取的是真气台阶出现的时刻，没有像掉血那样减 5 帧（沿用阶段一的定义）。112 个 ok 里约 70% 和掉血那一列一致，约 30% 的录像台阶要早 6–12 帧。这些可能是 trace 的真气读数滞后，也可能是录像读数器把别的台阶当成了这一次；但这些 ok 前我方卸势按下的间隔（约 10 帧）和其余 ok 一样，所以暂按 trace 时间。
- 录像和 trace 的时钟每轮差一个常数（r001 约 7 帧，r002 约 4 帧，可能是录像开始的延迟），所以 `check_align.py` 只看同一轮里的相对值。

## 卸势按键策略：离线回放（`replay.py`）

```
# head p2 每行输出缓存（GPU 约 10 秒；replay 读 data/tmp/p2policy/heads/<head>/rNNN.npy）
uv run --with torch --index https://download.pytorch.org/whl/cu130 --with onnx --with onnxruntime \
    python workspaces/WhereWindsMeet/tools/dufu_train/cache_heads.py data/p2 unified_head_p2
# 评估器自检：记录的按键 / 模拟的现行调度器 vs 实际挨打
uv run --with numpy python workspaces/WhereWindsMeet/tools/dufu_train/replay.py validate data/p2
# 节拍策略门限网格 + 按轮 5 折选参（--extra 加上 p2e 分支的 out-of-fold 输出；网格结果缓存在 data/tmp/p2policy/tune_grid.pkl）
uv run --with numpy python workspaces/WhereWindsMeet/tools/dufu_train/replay.py tune data/p2 --extra unified_head_p2e_oof \
    --gates 0.02 0.05 0.1 0.15 0.2 0.3 0.4 0.5 --his 16 24 --budgets 60 120
# p2e：5 折 out-of-fold（给 tune 用），再用全部轮次导出 model/dufu/unified_head_p2e.onnx + .json
uv run --with torch --index https://download.pytorch.org/whl/cu130 --with onnx --with onnxruntime \
    python workspaces/WhereWindsMeet/tools/dufu_train/train_press.py data/p2 --no-export
... train_press.py data/p2 --cv 0 --final-epochs 2
```

**回放**：逐行重放 trace，策略在第 i 行看到该行的 head 输出（设备同款 30 行窗口）和自己的按键 / 反馈历史，决定这一帧按不按卸势。按键时刻 = 行的 loop 时间 + 21 ms（trace 实测：按键标记在所属行之后 18–26 ms）。约束：脚本冷却 220 ms；游戏锁 330 ms（距上一次*生效*的卸势不到 330 ms 的按键被吞，期间有 ok 则解锁）；挨打硬直（按掉血查表，从检测到掉血起算）和喝药后 2 s 内不按；闪避、喝药按记录原样保留。

**结果模型**：每个接触（labels.py）的有效按键 = 前一个接触之后、提前量 ≥2 帧的最后一次生效按键；提前量 = 接触（截图时钟）− 按键时刻，延迟已含在内。P(ok) = 记录数据拟合的「ok 率–提前量」曲线（fresh 接触，每帧一档：2–10 帧约 0.85，11 帧 .76，12 帧 .65，13 帧 .56，14 帧 .46，15 帧 .31，≥16 帧约 0），其他类别同形状乘系数（postHit 0.57，quick 1.0，chainHeavy 0.04）；没有有效按键用该类别的无按键 ok 率。金光（aux flare）和抓取后续几下保持记录结果，不归卸势策略管。抽样结果驱动后续状态（ok 解锁、挨打进入硬直），计分用期望（Σ 1−P(ok)），多个种子平均；区间是按轮 bootstrap。

**有效性**（只在 head p2 没训练过的 r043 之后的轮次上测）：

| 轮次 | 实际可卸挨打/分 | 结果模型 + 实际按键 | 模拟调度器 |
|---|---|---|---|
| 默认调度（77 轮） | 8.50 | 8.37 | 8.23 |
| parryJitter（30 轮） | 7.25 | 7.15 | 7.34 |
| leadF 11 + secondTapF 13（8 轮） | 9.55 | 9.75 | 9.86 |
| p2d + defDodgeP（8 轮，曲线外推） | 9.13 | 9.64 | – |

逐轮相关 0.86–0.88。模拟调度器的按键 ~98/分（实际 ~106），有效按键提前量四分位 5.9/8.7/12.2（实际 5.9/9.0/12.7）。leadF 在同一批 16 轮上模拟出 +0.65/分（变差），实机对照也是变差。

限制：开环——head 的输入是记录的 trace，里面有记录的按键（aux since_parry / pressed / since_ok，画面里的卸势姿势），boss 后续出招按记录的结果走。p2e 分支把三列 aux 换成常数，去掉了前一种；画面的那种去不掉（同一真实提前量下，「1–8 帧前按过」的行门限值高 0.02–0.06，分不清是泄漏还是调度器本来就在该按的时候按）。「空按只花一次锁」这一点有数据支撑：上一下空按 330–450 ms 后再按，ok 率 .88–.94（n 约 250），和单按一样；但节拍策略每分钟按 115–160 下，比记录数据多，冷却不止 330 ms 的惩罚（例如连续空按）没法从数据排除——2 s 内有 ≥3 次空按时 ok 率 .82 vs .88，加这个惩罚（`--spam 0.93`）结论不变。

**结果**（123 轮、244 分钟，r043–r165；可卸 = fresh + postHit + quick + chainHeavy）：

| 策略 | 可卸挨打/分 | 与现行之差 [95%] | 全部挨打/分 | 按键/分 | 有效按键在 3–9 帧 |
|---|---|---|---|---|---|
| 现行调度器（模拟） | 7.90 | – | 10.28 | 94 | 49% |
| 期望值策略（fut1f × 曲线；等预测上更好的时刻，4 帧内） | 7.79–9.76 | −0.09 … +1.88 | | 61–96 | |
| 节拍，门限 = fut1f，CV（不限按键） | 5.65 | −2.25 [−2.51, −1.93] | 8.03 | 160 | 59% |
| 节拍，门限 = fut1f，CV（≤120 按键/分） | 6.58 | −1.32 [−1.56, −1.09] | 8.96 | 114 | 55% |
| **节拍，门限 = p2e lead1f，CV（≤120 按键/分）** | **5.87** | **−2.03 [−2.29, −1.74]** | **8.25** | 115 | 59% |
| 节拍，门限 = p2e lead1f，CV（≤现行 94 按键/分） | 6.40 | −1.50 [−1.73, −1.26] | 8.78 | 91 | 57% |
| 上限：已知真实接触，提前 3–9 帧按一下 | 4.96 | −2.94 | 7.34 | 21 | 94% |

lead1f 门限是 out-of-fold 的（5 折按轮号，见下）。fut1f 的门限校准很差（预测 P(2–20 帧内有接触) 平均 0.56，实际 0.19；39% 的行 ≥0.7），只能靠多按；lead1f 平均 0.30，30% 的行 <0.05（实际 0.02），同样的命中少按约 25%。

结论：卸势时机的空间主要在「按得密」而不是「算得准」——ok 窗口（2–10 帧，约 300 ms）和锁（330 ms）差不多长，锁一结束就再按，有效按键就落在窗口里。期望值策略（等预测上更好的时刻）比现行更差：接触往后拖时预测也一直往后挪。就算时机完美（上限一行），全部挨打也只到约 7.3/分：金光 ~1.2、抓取 ~1.3、postHit / chainHeavy、窗口内仍有约 15% 失败，都不是按键时机能解决的。

### `unified_head_p2e.onnx`（`train_press.py`）

head p2 原样（out[0:133] 与 p2 逐字节相同），后面追加 46 列 `lead1f`：下一次接触相对「现在按下」的提前量（帧，0..44 每帧一档 + none），提前量 = 接触 − （本行 loop 时间 + 21 ms），即和上面的按键时钟一致，设备上不用再换算截图延迟。分支是 head p2 两层 GRU 的拷贝（两层都训练）+ 新线性层，输入里 since_parry / pressed / since_ok 换成常数（10 / 0 / 10）：输出不依赖我方按键历史，回放评估才成立，设备上也不会因为自己按了就更想按。单独 ONNX 也可以，但追加列只要一次调用（PC 上 0.24 → 0.47 ms），现有切片不动。

训练：labels.py 的接触，σ=1 帧高斯软标签，行权重同 labels.targets，前方 0–20 帧有接触的行 ×4（`--pos-w`）；跳过 r058–r067。5 折按轮号（`--cv 5 --no-export` 把每轮的 out-of-fold 输出写到 `data/tmp/p2policy/heads/unified_head_p2e_oof/`，replay 的 `--extra` 读它），最佳 epoch 1–3（很快过拟合），导出用全部 156 轮训 2 个 epoch（`--cv 0 --final-epochs 2`）。导出模型在 r043 之后的轮次上门限开启比例比 OOF 低 3–5 个百分点（同门限少按一点）。

### dufu.js 集成规格（阶段二，节拍卸势）

只在 `phase === 2` 且 head 是 p2e 时启用；out[0:133] 与 p2 相同，tell / combo / def / 进攻 / 喝药里读 head 的地方都不用改。

- **输入**：`lead = softmax(out, 133, 46)`；门限值 `G = Σ lead[b], b = 2..METRO_HI`（bin b = 提前量 [b, b+1) 帧，时钟就是本帧 loop 时间 + 约 21 ms，不用再减截图延迟）。
- **状态**：新增 `exeAt` = 脚本推算的「游戏最后一次执行的卸势」。每次卸势落指（任何来源）时：`if (now - exeAt >= LOCK_MS || lastOkAt > exeAt) exeAt = now`。`lockEnd = lastOkAt > exeAt ? 0 : exeAt + LOCK_MS`。
- **规则**（每帧，decode 之后、executePlan 之前）：`G >= METRO_G && now >= lockEnd + METRO_PAD_MS && now - lastParryAt >= PARRY_CD_MS && now >= staggerUntil && now >= potionHoldUntil && !inDodge && !qp.shown && !dodgeDue(now) && !potionYield(now)` → `tap(PARRY)`，`mark("press", "parry metro G0.xx")`。
  - `dodgeDue(now)`：plan 里有未按的 tell 闪避且 `atMs - now <= 100`（闪避优先，回放没模拟金光，保守起见）。
  - `potionYield(now)`：喝药到期且紧急（`hpNow <= POTION_URGENT` 或已等 `POTION_WAIT_MAX_MS`）时，节拍停最多 600 ms 让药按出去。不紧急时药照现有 `potionUnsafe` 等门限关着的空档（g 0.1 时每分钟约 6.5 段 ≥1.2 s 的空档，g 0.05 约 4.7 段；fut1f 门限只有 1.5 段）。
- **常数**：`METRO_HI = 16`，`METRO_G = 0.05`（回放 ~115 按键/分，可卸挨打 −2.0/分）；想和现行按键量持平用 `0.1`（~100/分，−1.7）或 `0.15`（~88/分，−1.4）。`LOCK_MS = 330`（= `PARRY_RELOCK_MS`），`METRO_PAD_MS = 15`，`PARRY_CD_MS = 220` 不变。
- **替换掉的**（阶段二）：syncK 的 fut 卸势项（k0–k2、branch、contact moved / second tap / late fill 重按、relock 等待）、expire 里的重按、hitEscTick 和挨打后的 insurance 卸势（硬直一结束、门限开着，节拍自己就会按）。阶段二 def 头的闪避本来就改成了卸势，所以 syncK 在阶段二可以整个不跑。
- **保留的**：tell / 金光闪避（slowFlare、flareHold / split、锚点）、喝药计划、进攻、气竭处决、锁定 / 进场等。
- **进攻**：tap() 会让按着的蓄力先放（offYield）。门限开着就是「20 帧内可能有招」，进攻起手应同样避开：冷 / 热蓄力和整套横刀起手前要求 `G < METRO_G`（在现有 OFF_CHARGE_FREE / offHorizon 判断之外再加一条）。回放没模拟进攻，这一条是保守建议。
- **只有 head p2 时的退路**：`G = Σ fut1f[d]`，d 满足 `d - lag ∈ [2, 16]`，`lag = (now + 21 - 截图时刻) / 33.3`；fut1f 校准差，门限 0.4–0.5 对应 ~117–103 按键/分、可卸挨打 −1.4 / −0.8（≤120 按键时 CV 选的就是这一档）。
- **上机要看的**：按键间隔分布（应集中在 340–380 ms）；有效按键前 330–450 ms 内有一次空按时的 ok 率（记录数据 .88–.94，按得更密后要确认没变）；被锁吞掉的按键数；挨打/分按类别（fresh / postHit / quick），8 对 8 交替。
