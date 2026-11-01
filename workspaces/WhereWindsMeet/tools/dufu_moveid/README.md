# dufu_moveid：当前入口（2026-10-31）

独夫招式识别的数据底座、老师 / 学生模型、实机闭环。当前状态、关 2 数字和下一步见 [docs/dufu-current.md](../../docs/dufu-current.md)；方案设计见 [docs/dufu-moveid-plan.md](../../docs/dufu-moveid-plan.md)。2026-10-31 之前的完整工具说明（含每一步的结果、A/B、踩坑）逐字归档在 [docs/archive/dufu-moveid-tools-2026-10.md](../../docs/archive/dufu-moveid-tools-2026-10.md)。

## 阶段与目录

所有脚本读 `common.py` 的 `MOVEID_PHASE`：不设 = 阶段二；阶段一必须每个命令都加 `MOVEID_PHASE=1`。忘加会把产物写进阶段二目录。

| 阶段 | `MOVEID_PHASE` | 轮次 | 数据 / 产物 | 默认模型 |
|---|---|---|---|---|
| 阶段二（默认） | 不设或 `2` | `data/p2/rNNN` | `data/moveid/` | `model/dufu2b` |
| 阶段一 | `1` | `data/p1/rNNN` | `data/moveid/p1/` | `model/dufu1b` |

`data/` 在仓库根（`D:\Projects\MaaLow\data`），不在 `workspaces/WhereWindsMeet/` 下。下面命令默认阶段二；阶段一在每条前加 `MOVEID_PHASE=1`，并把命令里的 `data/moveid/` 换成 `data/moveid/p1/`（模型换成 `dufu1` / `dufu1b`）。

## 一条龙

### 1. 拉取 / 对时 / 抽查

```bash
# 拉取 + 校验（已通过的跳过；--first N 只做前 N 轮）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/pull.py [--first 20] [--workers 3] [--procs 6]
# 从 Pad 删除已校验的录像（不带 --yes 只列清单）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/delete.py --yes
# 对时 + 索引
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/build.py
# 抽查：随机 hit 接触前 10 帧 ~ 后 8 帧原图
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/check.py --n 3 --seed 1 [--after 8]
# 独立复算血量 / 真气台阶（不依赖 build 的 offset）
uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/audit.py
```

阶段一在每条命令前加 `MOVEID_PHASE=1`。`pull.py` 校验大小、头中尾 64 KiB、逐帧解码帧数；`build.py` 写 `index.json` / `decisions.json` / `align.txt`；`check.py` 抽图到 `check/`。

### 2. 关 0：裁剪

```bash
PY="uv run --with torch --with torchvision --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
    --with ultralytics --with transformers --with pillow --with opencv-python-headless --with numpy python"
D=workspaces/WhereWindsMeet/tools/dufu_moveid
$PY $D/gate0_frames.py data/p2 data/moveid/gate0/frames
$PY $D/gate0_sheets.py sheets data/moveid/gate0/frames --set train
$PY $D/gate0_detector.py train
$PY $D/gate0_detector.py detect
$PY $D/gate0_detector.py check
$PY $D/gate0_coverage.py
$PY $D/gate0_coverage.py --gt
```

当前结论：阶段二固定双框（中心 555, 320）手标覆盖 80.0%，整屏 384×240 90.2%，两路并 97.1%；阶段一固定双框只有 48.4%（有框帧），整屏 96.1%、两路并 96.3%（这两项为全部决策帧）。两阶段都用「整屏 384×240 + 固定双框 530/260」的视图，阶段一以整屏为主。

### 3. 顺序 2：光色、连段、聚类

```bash
PY="uv run --with opencv-python-headless --with numpy python"
TORCH="uv run --with torch --with torchvision --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match --with numpy python"
D=workspaces/WhereWindsMeet/tools/dufu_moveid
$PY $D/s2_feat.py --procs 8        # 候选亮线 + 接触前后裁剪
$PY $D/s2_crops.py                 # 只在 feat 先于裁剪生成时补
$PY $D/s2_label.py sheet [--mode strat|red|uncertain|pred:R|pred:G]
$PY $D/s2_label.py set s001 "GNCN ..."
$TORCH $D/s2_model.py              # 5 折 + 全量，写 color/crop_probs.json
$PY $D/s2_color.py                 # 每个接触的颜色 -> color/color.json
$PY $D/s2_events.py                # 连段 + 掉血 -> events_ext.json、color/stats.md
$PY $D/s2_check.py sheets --seed 2
$PY $D/s2_check.py grade data/moveid/color/check/grades.json
# 聚类（一条命令约 3.5 分钟）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s2c_all.py [--no-stability] [--seed N]
```

阶段二：gold 554（6.9%）、red 523（6.6%）、none 6827（85.5%）、unknown 78；42 类出招 + 1 类抓取，覆盖率 95.3%。阶段一：没有红光，重映射后 gold 707（7.5%）、none 8527（89.9%）、unknown 255、red 0；28 类出招，覆盖率 96.3%。`CHAIN_GAP` 阶段二 73 帧、阶段一 72 帧。

### 4. 顺序 3b：前缀老师 / 关 1

```bash
D=workspaces/WhereWindsMeet/tools/dufu_moveid
uv run --no-project --with numpy --with scikit-learn python $D/s3b_prefix.py
uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
    python $D/s3b_train.py
uv run --no-project --with numpy python $D/s3b_gate1.py --extra-md data/moveid/teacher_prefix/check/review.md
uv run --no-project --with av --with opencv-python-headless --with numpy python $D/s3b_check.py
```

阶段一产物在 `data/moveid/p1/teacher_prefix/`：97 组，关 1 (b) 5542/5837 = 95.0%，金→红 0/707。阶段二：87 组，关 1 (b) 5277/5418 = 97.4%，金→红 0/554。前缀组、应对标签、关 1 口径都在训练前写定。

### 5. 顺序 4：学生 / 导出 / 对拍

```bash
D=workspaces/WhereWindsMeet/tools/dufu_moveid
TORCH="uv run --no-project --with torch --with timm --with numpy --with av --with opencv-python-headless \
    --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match"
uv run --no-project --with av --with opencv-python-headless --with numpy python $D/s4_cache.py --procs 8 --check 3
$TORCH python $D/s4_soft.py
$TORCH python $D/s4_train.py --folds 0,1,2,3,4 --final --epochs 8 [--init data/moveid/p1/student/live_a.pt]
$TORCH --with onnx --with onnxruntime python $D/s4_export.py --tag final [--out workspaces/WhereWindsMeet/model/dufu1b]
uv run --no-project --with numpy --with onnxruntime python $D/s4_eval.py --folds 0,1,2,3,4 [--prec int8]
uv run python $D/s4_pad.py run [--src workspaces/WhereWindsMeet/model/dufu1b]
uv run --no-project --with numpy --with onnxruntime --with opencv-python-headless python $D/s4_pad.py compare <pad/时间目录>
```

阶段一当前学生 OOF：fp32 94.3%、int8 93.2%；金→红 0/707。阶段二学生 fp32 97.5%、int8 97.2%。Pad 对拍要求：CPU int8 视图 / 特征 / logits 位级一致；qnn 四个头 argmax 全一致。

### 6. 顺序 5：实机

```bash
D=workspaces/WhereWindsMeet/tools/dufu_moveid
TORCH="uv run --no-project --with torch --with timm --with numpy --with av --with opencv-python-headless \
    --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match"
# 招式表 -> model/dufu<PHASE>/movetable.json + skills/lib/dufu<PHASE>-table.js
uv run --no-project --with numpy python $D/s5_movetable.py [--live]
# 进攻 v2 的 next.share 表 -> skills/lib/dufu-offense-table.js（重训/改前缀表后跑一次）
uv run python $D/s5_offense_table.py
# 录像 -> data/moveid[/p1]/live/video、bars、对拍截图；--delete 只删这些轮次
uv run --with opencv-python-headless python $D/s5_pull.py [--delete]
# 每帧光色（顺序 2 的分类器，全帧）
uv run --no-project --with torch --with torchvision --with opencv-python-headless --with numpy \
    --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match python $D/s5_color.py
# 接触检测、决策时刻、空闲误报、关 2 -> live/analysis.json
uv run --no-project --with numpy python $D/s5_analyze.py [rNNN ...]
# 按参数分组的关 2（口径不变）+ 火球雨口径
uv run --no-project --with numpy python $D/s5_ab.py rNNN ... --by run,goldSeq [--out live/abN.json]
# 实机重训（阶段一示例；阶段二去掉 MOVEID_PHASE=1）：cache -> train -> eval
MOVEID_PHASE=1 $TORCH python $D/s5_retrain.py cache r030 ... r065 --procs 6
MOVEID_PHASE=1 $TORCH python $D/s5_retrain.py train --base final --tag live_a \
    --live r030 ... r057 --val r058 ... r065 --epochs 2 --lr 3e-4 --live-rep 2
MOVEID_PHASE=1 $TORCH python $D/s5_retrain.py eval --val r058 ... r065 --models final,live_a
# 推 App：只推 skill / 表（--model 另推 model/dufu2、dufu2b，阶段一另推 dufu1b）
uv run python $D/s5_push.py [--model]
```

`--live`：实机关 2 里卸势成功率 <20%（≥10 次）的「卸」组改成不可卸（阶段二火球雨 c7）。招式表改完必须重新生成 `skills/lib/dufu*-table.js` 并推送。

### 7. 闭环 loop.py

阶段一 / 阶段二同一套，`MOVEID_PHASE` 选目录。

```bash
D=workspaces/WhereWindsMeet/tools/dufu_moveid
MOVEID_PHASE=1 uv run python $D/loop.py run --n 16 --tag gate3 --batch 8 \
  --args '{"mode":"defend","provider":"qnn","model":"dufu1b"}'
MOVEID_PHASE=1 uv run python $D/loop.py ab --n 12 --tag ab_attack \
  --alt '[{"attack":false,"model":"dufu1b"},{"attack":true,"model":"dufu1b"}]'
# 进攻 v2：默认 off，A/B 只切 offense；gate 自动按 offense 分组
MOVEID_PHASE=1 uv run python $D/loop.py ab --n 16 --tag off_stage1 --ms 600000 \
  --alt '[{"offense":"off","model":"dufu1b"},{"offense":"v2","model":"dufu1b"}]'
MOVEID_PHASE=1 uv run python $D/loop.py ingest --tag gate3
MOVEID_PHASE=1 uv run python $D/loop.py gate --tag gate3
MOVEID_PHASE=1 uv run python $D/loop.py train --tag live_b --live r... --val r...
MOVEID_PHASE=1 uv run python $D/loop.py report --tag gate3
```

- `run` / `ab`：每局前如果是接着打（上一局 `time`），先跑一局不录像、不建 round 目录的 `shadow` 让 boss 把角色打死；下一局 `dufu_enter` 就是满血 fresh。开始前临时关掉 `AutoPickup`、`DismissIdleSlideshow`、`CloseItemTip`，结束时恢复原来的 `off` 列表。
- `ingest`：`s5_pull --delete`（校验大小 / 字节样本 / 逐帧解码后才删 Pad）→ `s5_color` → `s5_analyze`；`--batch N` 每 N 局自动 ingest。
- `gate`：`s5_ab` 按 manifest 的开关自动分组（`offense` / legacy `attack` / `run`，`--by` 可覆盖）+ 按局表；`report` 出 markdown。manifest 是 `live/loop_<tag>.json`，gate 是 `loop_<tag>_gate.json`。
- `train`：`s5_retrain cache → train → eval`，`s4_export --out model/dufu<PHASE>_<tag>`，只推这个模型目录，不覆盖正在用的 champion。擂台用 `ab --alt [{"model":"a"},{"model":"b"}]`。

## 当前模型与产物

| 路径 | 内容 |
|---|---|
| `workspaces/WhereWindsMeet/model/dufu1b/` | 阶段一默认模型（`dufu1.json` + int8 / fp32 / qnn ONNX） |
| `workspaces/WhereWindsMeet/model/dufu1/` | 顺序 4 基座 + 阶段一 `movetable.json`（97 组） |
| `workspaces/WhereWindsMeet/model/dufu2b/` | 阶段二默认模型（`dufu2.json` + int8 / fp32 / qnn ONNX） |
| `workspaces/WhereWindsMeet/model/dufu2/` | 顺序 4 基座 + 阶段二 `movetable.json`（87 组） |
| `skills/lib/dufu1-table.js`、`dufu2-table.js` | 编译进 skill 的招式表；改表后重新生成并推送 |
| `data/moveid/p1/teacher_prefix/` | 97 组 `prefix.json`、老师 `oof.npz`、`gate1.json` |
| `data/moveid/p1/student/` | 学生 `oof.npz`、`gate1/`、`final.pt`、`live_a.pt`、`live_eval.json` |
| `data/moveid/p1/live/` | 实机局 r001–r184、`loop_<tag>.json` manifest、`loop_<tag>_gate.json`、`ab_*.json` |
| `data/moveid/p1/moves/` | `taxonomy.json`（28 类 + unknown）、`special.json`、`sheets/` |
| `data/p1/gate2_check/` | `fresh16_review.json`（79 失败台账）、`fresh16_confirm.json`、`final16_new.json`、帧条 |
| `data/p1/gate2_check.py`、`data/p1/fresh16_review.py` | 独立复算脚本（不 import 分析链） |
| `data/moveid/live/ab_confirm16.json` | 阶段二确认轮 3235/3492 的复算结果 |

## 关键口径与坑

- **录像对时**：`frame(t) = k + t / 33.33 + offset`，`offset` 每轮一个常数；阶段二中位 −3.7 帧。`build.py` 用 hit / ok 台阶落窗最小化求 offset，`audit.py` 另用血量 / 真气台阶复算，两者独立。|残差| ≤1 帧的 hit 要 ≥75%。
- **接触检测延迟 5 帧**：设备看到掉血的时刻 = 接触 +4/+5/+5 帧（p10/p50/p90），所以训练里「看到」定义成接触 +5 帧，接触历史到 +6 帧才进；`dufu2.js` 和 `s5_retrain` 都用这个定义。
- **闪避只有失败样本**：闪开的招不产生接触，录像里只有没躲开的闪避，所以表里的闪避提前量 14 是占位；实机 A/B 14 / 8 / 5 后取 5（`dodgeLead`），不要拿接触数据直接拟合成功闪避。
- **关 2 口径**：致命招每一下在决策时刻（−10）应对判对 ≥90%，金招按成卸 ≤3%，连续 16 局；闪避后 25 帧内没有接触算闪开，录像核实过的才计入「不含未核实」，没核实的另报「含未核实」。区间用按局 bootstrap（10000 次，按局有放回）。
- **阶段一金阈值 `GOLD_DODGE_P1 = 0.015`**：学生 OOF 上金→卸 15/707 = 2.1%、致命 92.5%；0.02 是 2.97% 贴 3% 线，0.025 / 0.03 破线。阶段二仍是 `GOLD_DODGE_P = 0.15`，不要混用。
- **`chain` / c7 火球雨 / `goldSeq` 只在阶段二**：`chain` 是 k2:c30 第二下 +34 帧补卸势；c7 是火球雨斜后跑；`goldSeq` 是 c11 金光火球窗（+27·k 帧补闪）。阶段一没有红光，也没有这三条；阶段一用 `curtainGap` / `curtain2` 处理幕布和 k1:c18。
- **喝药槽位（阶段一）**：涂毒后等 2.5 s 再换回药；`potionTick` 喝药前检查快捷槽，必要时开物品栏换药（每局最多 2 次）。r167 的死亡螺旋就是涂毒后槽位变回毒、低血喝毒进冷却。
- **`loop` 的 fresh / 守卫**：上一局 `time` 后先跑 shadow 打死角色，保证下一局满血 fresh；跑局前临时关 `AutoPickup` / `DismissIdleSlideshow` / `CloseItemTip`，结束恢复。shadow 不录像、不建 round 目录、不占 Pad。
- **录像删除**：`s5_pull --delete` / `delete.py --yes` 只在大小、字节抽样、逐帧解码都通过后删 Pad；Pad 上保留的 5 个 10-23 旧录像不属于任何轮次。
- **阶段一没有红光**：颜色头仍输出 3 类，但 red 没有标签；`s5_color.py` 在 `PHASE==1` 时把 red 重映射成 gold / none，决策只用「金→闪、其余卸」。
- **改表 / 换模型**：`s5_movetable.py` 写 `model/dufu<PHASE>/movetable.json`，同时要更新 `skills/lib/dufu<PHASE>-table.js`；`s5_push.py --model` 才会推模型，普通推送不覆盖 champion。

## 当前结论 / 下一步

- 阶段一 `dufu1b`：fresh 16 局 919/998 = 92.1%，两轮合并 1627/1769 = 92.0%（区间 [90.3, 93.5]），金 1/563 = 0.18%，1.45 挨打/分。关 2 过。
- 阶段二 `dufu2b`：确认轮 3235/3492 = 92.6%（区间 [91.3, 94.0]），金 5/498 = 1.0%，1.74 挨打/分。关 2 过。
- 顺序 6 进攻默认关：关 3 进攻开 16 局 1.69–1.81，修喝药后 8 局 2.41–2.52，未过 ≤1.5；16 局建议 `attack:false`，进攻只做显式 opt-in。
- 下一步：进攻按 TTK / boss 掉血速度评估，防守 gate 不变；gate X 与 A/B 规模待离线分析后定。

## 历史

- 当前状态与关 2 数字：[docs/dufu-current.md](../../docs/dufu-current.md)
- 方案设计：[docs/dufu-moveid-plan.md](../../docs/dufu-moveid-plan.md)
- 2026-10-24～10-28 的顺序 1–6 进展：[docs/archive/dufu-moveid-2026-10.md](../../docs/archive/dufu-moveid-2026-10.md)
- 本 README 的旧版全文（含 `s5_pair` / `s5_episodes` / `s4_gate` / NPU 测速等可选命令）：[docs/archive/dufu-moveid-tools-2026-10.md](../../docs/archive/dufu-moveid-tools-2026-10.md)
- 旧 `dufu.js` 基线、老师规则、试过没用的方向：[docs/dufu.md](../../docs/dufu.md)
