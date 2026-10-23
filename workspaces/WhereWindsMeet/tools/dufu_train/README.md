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
