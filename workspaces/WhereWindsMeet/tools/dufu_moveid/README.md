# dufu_moveid：独夫招式识别的数据底座

方案见 `docs/dufu-moveid-plan.md`。这里把阶段二各轮的录像拉到 PC、核对、从 Pad 删除，把 trace 时钟对到录像帧号，并建事件索引。trace 读法和接触标签直接用 `../dufu_train` 的 `data.py` / `labels.py`（不改）。

轮次：`data/p2/rNNN` 为主；`data/p2b/rNNN` 只补录像 id 不在 p2 里的（目前 p2b 的 57 轮全在 p2 里，等于没有补）。

## 命令

```
# 1. 拉取 + 校验（可重复跑，已通过的跳过；--first N 只做前 N 轮）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/pull.py [--first 20] [--workers 3] [--procs 6]
# 2. 从 Pad 删除已校验的录像（不带 --yes 只列清单）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/delete.py --yes
# 3. 对时 + 索引
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/build.py
# 4. 抽查：随机几个 hit 接触前 10 帧 ~ 后 8 帧的原图（hit 的接触 = 血条台阶 − 5 帧，台阶在 +5/+6）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/check.py --n 3 --seed 1 [--after 8]
```

## 产出（`data/moveid/`，git 忽略）

| 路径 | 内容 |
|---|---|
| `video/<录像id>.mp4` | 录像，1080×720 30fps |
| `meta/<录像id>.json` | Pad 上的 meta（`started` 是录像起点 epoch ms）；删除前另存 `<id>.labels.json`（有的话） |
| `bars/<录像id>.npz` | 每帧 `hp`（血量 0–1，NaN = 读不到）、`qi`（boss 真气 px，−1 = 读不到）、`hp_crop` / `qi_crop`（每帧 HP_ROI / QI_ROI 原像素，换读法不用重新解码）、`v` = 2 |
| `pull_status.json` | 录像 id → `round, pad_size, size, meta_frames, frames（解码数）, container_frames, frame_diff, source（present / local-copy / download）, bytes_ok, ok` |
| `deleted.txt` / `deleted.json` | 删除前写的 id 清单 / 每个 DELETE 的响应和事后确认 |
| `index.json` | `{fields, rounds, events}`，字段说明在 `fields` 里（下面摘要） |
| `decisions.json` | 每个接触一项 `{rec, round, event, type, frame = 接触帧 − 10, contact_frame}`，关 0 用 |
| `align.txt` | 对时汇总 + 每轮偏移和残差 |
| `check/<轮>_<录像>_ev<id>/` | 抽查原图 `f<帧号>_<相对接触帧>.png` + `info.json` |

### 校验（pull.py）

大小 = Pad meta 的 size；文件头 / 中 / 尾 3 段 64 KiB 和 Pad 上的逐字节相同（Range 请求）；OpenCV 逐帧解码计数，|解码帧数 − meta frames| ≤ 2。本地工作区 `recordings/<id>/video.mp4` 大小一致时直接复制（以前 sync 过的），否则从 Pad 下载（Range 续传，`.part` 断了能接着下）。

### 对时（build.py）

trace 的时刻 t（自技能开始的 ms，`cap` 和 `wall` 同一时钟）→ 录像帧号：

```
frame(t) = k + t / (1000/30) + offset,   k = (start − meta.started) / (1000/30)
```

`offset` 每轮一个常数。录像里的台阶：`hp`（读法同 dufu.js `health()`，`reads.py`）比前 4 帧中位数低 ≥ 2% 且之后保持；`qi` 低 ≥ 6 px。每个接触（`labels.contacts()`）先在 trace 里有一个区间：上一行截图时刻到「第一次看到变化的那一行」的截图时刻 `[lo, hi]`；录像里第一帧显示变化的帧应落在 `[lo, hi + 1]`。`offset` 取让各 hit 落出这个窗口的距离之和最小的那段的中点；残差 = 落在窗口外的距离（窗口内为 0，正 = 录像晚）。另报中点口径（`offset_mid` = median(台阶帧 − 中点帧)，`mid_within1`），和 dufu_train/README 的「同轮 ±1 帧 75%」可比。

### index.json

- `rounds[]`：`round, rec, video, trace, frames, meta_frames, size, start, rec_started, k, offset, offset_mid, args（args.json，无则 null）, reason（结束原因）, rows, events（[起, 止) 在 events 里的下标）, coarse, hits, oks, hit_res / ok_res / all_res（n, within1, within2, mid_within1, mad_mid）`。
- `events[]`（每个接触一项，按轮、按时间）：
  - `kind`：hit / ok；`outcome`：ok / pf（接触前 4–15 帧按过卸势仍掉血）/ unk（掉血、没及时按）/ grab（抓取过场的后续几下）；`flare`：金光接触。
  - `type`：flare / grab / ok / hit_pf / hit_unk（金光优先，其次抓取）。
  - `row, t_ms`（接触时刻，截图时钟；hit = 看到时刻 − 5 帧）、`frame`（接触的录像帧号）、`frame_f`（未取整）、`step_res`（这一下的台阶残差，null = ±6 帧内没找到台阶）。
  - `parry_lead_f` / `dodge_lead_f`：最后一次卸势 / 闪避按键到接触的帧数（loop 时钟，同 labels.py）；`presses[]`：接触前 45 帧内我方每次按键 `{key, lead_f, frame, since_prev_contact}`。

## 结果（2026-10-24）

- 197 轮（p2 全部；p2b 57 轮的录像都在 p2 里）→ 197 个录像，29.35 GB，全部校验通过（解码帧数和 meta 完全一致，字节抽样一致），已从 Pad 删除（Pad 上剩 5 个没被引用的）。
- 对时：offset 中位数 −3.67 帧（四分位 −4.25 / −3.36；r054 −17.4、r049 −7.9 是真的，用 trace aux 的 hp / qi 序列和录像逐帧互相关也得到同样的值）。有 hit 的 195 轮全部 |残差| ≤1 帧占比 ≥75%（hit 总体 97.1%，ok 99.0%）；中点口径 164/195 轮 ≥75%。r117（67 行、无接触）用各轮中位数，r162 只有 ok。
- 匹配到台阶：hit 3918/4206，ok 3750/3776。没匹配上的 hit 多是血量分几帧慢慢掉（每帧 <2%，合计 ≥2.5% 才触发 trace 的 hit）。
- 用 dufu.js 同款读法（`reads.py`）后 ok 的台阶和 trace 时刻一致，dufu_train/README「约 30% 的 ok 录像台阶早 6–12 帧」应是 check_align.py 那个简化读法 / 搜索窗口造成的。
- 事件 7982：ok 3519、hit_unk 1799、hit_pf 1555、flare 649、grab 460。

## 注意

- Pad 上删掉的录像记在 `deleted.txt`，再跑 pull.py 会跳过它们（本地副本照旧）。

- Pad 删掉录像后，下一次 `maalow sync WhereWindsMeet` 会把本地工作区 `recordings/<id>/` 的 meta / labels（加 `--videos` 时还有 video.mp4）当作「App 删了」一并删掉。`data/moveid/` 里的副本不受影响。
- 多个解码进程并行时整体只有约 300–600 帧/秒（单进程约 500），全部 75 万帧要半小时以上。

## NPU 测速（2026-10-24）

给学生模型选大小用：候选模型在 Pad 上 `infer()` 的 CPU / nnapi 耗时，和 AI Hub 真机 NPU（QNN）耗时。权重随机，只测速。

```
# 1. 导出候选（opset 17，fp32 / fp16 / int8，--u8 另出 uint8 权重版给 NNAPI）→ data/moveid/npu/models/ + manifest.json
uv run --with torch --with torchvision --with timm --index https://download.pytorch.org/whl/cu130 \
    --with onnx --with onnxruntime --with onnxconverter-common \
    python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_export.py [--u8] [--only crop_mnv3s,...]
# 2. Pad 测速（先查空闲；临时放 model/npu_bench/ + skills/npu_bench.js，只推这两处，跑完删掉再推）
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py run [--models a_fp32,b_int8] [--n 200 --warm 20]
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py table data/moveid/npu/bench_*.json
uv run --with numpy --with onnxruntime python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py check data/moveid/npu/bench_*.json
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py cleanup      # 中断后手动清理
# 3. AI Hub（token 在 ~/.qai_hub/client.ini；只上传 manifest 里的 ONNX）
uv run --with qai-hub python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_aihub.py --dry-run
uv run --with qai-hub python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_aihub.py --chipset qualcomm-snapdragon-8gen3
```

- 测速 skill（`npu_bench_skill.js`）只调 `infer()`：所有输入都用 `extra` 张量（常数 0.5），不截屏、不碰触摸按键。`run` = onnxruntime Run（含 JNI 拷输入），`total` 还含 base64 解码（实战走截图路径，这部分换成裁剪缩放）。`first` = 第一次调用（开 session）。
- 每个模型 × {cpu 1/2/4 线程, nnapi}：首次 + 预热 20 + 计时 200。游戏在前台跑着（和实战一样抢 CPU），同一模型两次跑 p50 能差 1.5 倍；多线程基本不比单线程快。
- `check`：设备第一次调用的前 8 个输出和 PC 上 onnxruntime 对比；fp16 / int8 在 CPU 上结果一致（fp16 真的按 fp16 算，不是错的）。

### 结果

Pad：Android 16（录像 mp4 的 com.android.version），小米 HyperOS 国际版（com.miui.* / com.mi.globalbrowser），截图 3:2（像素 3200×2136 级的小米 Pad 7 / 7 Pro / 8 系列，骁龙 7+ Gen 3 / 8s Gen 3 / 8s Gen 4 之一，未确认）。SoC 型号 App API 读不到：/status 等路由和 skill API 都没有 Build.SOC_MODEL / getprop；要确认得 adb `getprop ro.soc.model`，或在 /status 加 `Build.SOC_MODEL`（Kotlin）。

CPU 单线程 run p50（ms，括号 p95；两次跑都列）：

| 模型 | 输入 | fp32 | fp16 | int8（S8 逐通道） |
|---|---|---|---|---|
| back9（现有） | 96² | 4.2 / 2.7 | 1.4 | 1.6（u8 1.1） |
| crop MobileNetV3-S | 192² | 5.9 / 6.0 | 3.2 / 3.7 | 3.4 / 2.2 |
| crop MobileNetV3-L | 192² | 24.7 | 15.2（4 线程 10.3） | 4.7 |
| crop EfficientNet-Lite0 | 192² | 24.0 | 9.5 | 4.9 |
| crop ×2 batch 2（S） | 2×192² | 17.5 | 6.1 | 4.2 |
| crop ×2 6 通道（S） | 6×192² | 9.8 | 6.4 | 2.5 |
| global MobileNetV3-S | 384×240 | 12.5 | 7.4 | 5.2 |
| global MobileNetV3-S 0.5× | 384×240 | 6.7 | 8.0 | 3.4 |
| head_p2（现有 GRU） | 30×207 | 0.66 | 1.4 | 0.67 |
| GRU 128×2 | 30×399 | 1.0 | 1.3 | 1.0（GRU 不量化） |
| GRU 256×2 | 30×399 | 2.3 | 6.2 | 2.1 |
| TCN 192（4 层空洞卷积） | 30×399 | 1.5 | 0.6 | 0.27 |
| 空模型（调用开销） | 192² / 384×240 | 0.14 / 0.33 | | |

nnapi（onnxruntime 1.19.2 的 NNAPI EP，flags 0）：

- fp32：全部比 CPU 慢 4–10 倍（back9 15–32 ms，crop S 30–63 ms，global S 122 ms）；空模型也要 4–8 ms。
- u8（uint8 权重逐张量）：更慢，50–190 ms，back9_u8 输出和 PC 差 85%（其余 ≤ 6%）。
- int8（S8 权重）：建 session 就失败：`onnxruntime: The input/initializer of graph doesn't have valid type, name: fc.weight_quantized type: 3`。
- fp16：耗时和 CPU 一样（NNAPI EP 不接 fp16，整图回落 CPU）。
- GRU（fp32 / u8，含 head_p2）：运行失败：`Non-zero status code returned while running Nnapi_..._5 node ... model.cc:195 Predict ResultCode: ANEURALNETWORKS_OP_FAILED`。
- 结论：这台 Pad 的 NNAPI 后面没有可用的加速器（量化模型比 fp32 还慢，像是 nnapi-reference 的 CPU 实现），**nnapi 没用**。分区日志在 logcat 里（WARNING 级看不到），App API 拿不到；要确认得 adb logcat 或改 nn_jni.cpp 的日志级别。

AI Hub（qnn_dlc，Samsung Galaxy S24 Family / 骁龙 8 Gen 3，NPU p50，所有层都在 NPU 上）：

| 模型 | fp32 | int8 |
|---|---|---|
| back9 | 0.18 | 编译失败（`Converter does not support 'Erf' op type`，量化预处理把 GELU 拆成了 Erf） |
| crop S / L / Lite0 | 0.24 / 0.33 / 0.36 | 0.18 / 0.22 / 0.20 |
| crop ×2 batch 2 / 6 通道 | 0.36 / 0.39 | 0.29 / 0.33 |
| global S / S 0.5× | 0.45 / 0.39 | 0.23 / 0.21 |
| head_p2 / GRU 128×2 / GRU 256×2 | 3.0 / 2.9 / 8.6 | 3.3 / 3.1 / 9.6 |
| TCN 192 | 0.09 | 0.09 |

首次加载 0.35–1.1 s。对照：Galaxy S23（8 Gen 2）crop S fp32 0.35 / int8 0.24，crop L int8 0.30，global S int8 0.30，TCN int8 0.10，GRU 128×2 3.9，同一量级；Snapdragon 7 Gen 4 QRD 编译过了但 profile 全部失败（`QnnModel_composeGraphsFromDlc: MODEL_GRAPH_ERROR`，设备侧问题）。Pad 的 SoC 没确认，NPU 数字是同代旗舰的参考，不是 Pad 实测。GRU 在 NPU 上被按 30 步展开（1600+ 层），比 CPU 还慢；时序头上 NPU 要换成卷积（TCN）。

### 按 10 ms/帧

- 只用 CPU（单线程，游戏在跑）：全局 S int8（5.2）+ 裁剪 S int8（2.2–3.4）+ GRU / TCN（0.3–1）≈ 8–10 ms，刚好卡线、p95 会超；双裁剪（6 通道 int8 2.5 / batch 2 int8 4.2）再加全局 0.5× int8（3.4）+ TCN int8 ≈ 6–8 ms 更稳。MobileNetV3-L / Lite0 只能 int8 单独放（4.7–4.9），fp32 都放不下。学生模型要按 int8 训练（QAT 或校准）。
- NPU（QNN）：整套组合 < 1 ms（不含拷贝），大模型都放得下；做 QNN 插件值得。

## 关 0：裁剪（2026-10-24，`gate0_*.py`）

判定：决策时刻（接触帧 − 10，取自 `decisions.json`）boss 框 ≥90% 面积在某个裁剪框里、且在该框缩到 192 后高度 ≥40 px 的比例 ≥90%。阈值没改。

```
PY="uv run --with torch --with torchvision --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
    --with ultralytics --with transformers --with pillow --with opencv-python-headless --with numpy python"
D=workspaces/WhereWindsMeet/tools/dufu_moveid
$PY $D/gate0_frames.py data/p2 data/moveid/gate0/frames      # 决策帧 d 和 d−6/−3/+3/+6 切图，manifest.json
$PY $D/gate0_sheets.py sheets data/moveid/gate0/frames --set train   # 手标用网格图（Grounding DINO 给候选框）
$PY $D/gate0_detector.py train                                # YOLO11l 微调（gate0_labels.json）
$PY $D/gate0_detector.py detect                               # raw_boxes → 时间融合 → data/moveid/boss_boxes/rNNN.json
$PY $D/gate0_detector.py check                                # 60 张随机帧画框 → gate0/check/
$PY $D/gate0_coverage.py            # 用检测框，全部决策帧；失败样例 → gate0/fail/
$PY $D/gate0_coverage.py --gt       # 用手标框（随机抽的 520 帧），不受检测器误差影响
```

### boss 框

- 开放词汇（OWLv2、Grounding DINO「golden armor warrior」）分不开 boss 和我方角色，也常把召唤出的红龙当 boss，不能直接用。
- 改成手标 + 微调：手标 726 帧（`gate0_labels.json`：随机 460 帧 + 检测器低置信的 156 帧 + 红龙多的 110 帧；框 = boss 身体，不含长兵器和特效；`null` = 看不到 boss），第二类「我方」用 COCO yolo11x 在画面中下部的人框自动标。最终模型是 yolo11l、imgsz 640、616 帧训练（`yolo/run`，TTA 推理）。
- 时间融合：d 帧置信 ≥0.25 的框直接用；否则取 d 帧 ≥0.05 且与相邻帧（d±3、±6）某个 ≥0.25 的框 IoU ≥0.3 的框；都没有就记「无框」。`boss_boxes/rNNN.json`：`"<d>"` 和 `"<d>_p"`（d−3 帧，只用它自己的框）→ `{box, conf, src}`。
- 试过但没更好（开发集 `gate0_check_labels.json` 60 帧）：imgsz 960、加红龙手标帧再训、加自动标的「红龙」类、多模型融合、红龙 IoU 剔除规则（Grounding DINO 也把 boss 当龙）、红 / 金像素比例规则。

准确率（都 < 90%）：

| 样本 | 对 | 框到红龙 | 框到特效 | 框到我方 | 框偏 | 漏检 |
|---|---|---|---|---|---|---|
| 随机 60 帧，目测（`check/grades.json`，没参与训练和调参） | 42 | 9 | 2 | 1 | 3 | 3 |
| 开发集 60 帧（对手标框，IoU ≥0.4；调参用过） | 51 | 误检 5（boss 看不见却给了框，多为红龙 / 特效） | | | 4 | 0 |

主要错误是红龙（和 boss 同色、常在 boss 位置附近）。所以关 0 的结论以手标框为准，检测框的全量数字作参考。

### 结果

手标 520 帧（177 轮）：boss 可见 441（84.8%），看不到 79（被我方挡住、红光 / 爆炸特效盖住、抓取过场里 boss 出画；检测器全量是 7440 / 7982 有框）。比例 = 「在框里且够用」/ 有 boss 框的帧；括号里是 / 全部决策帧。

| 方案 | 手标（441 / 520） | 检测框（7440 / 7982，196 轮） |
|---|---|---|
| 固定双框，中心 = boss 中心中位数（手标 555,320；检测 546,314） | 353 = 80.0%（67.9%） | 6260 = 84.1%（78.4%） |
| 固定双框，画面正中 540,360 | 333 = 75.5%（64.0%） | 5980 = 80.4%（74.9%） |
| 固定双框，最优网格中心（样本内上限） | 356 = 80.7% | 6275 = 84.3% |
| 跟踪：双框中心 = d−3 帧的 boss 框 | —* | 6413 = 86.2%（80.3%） |
| 理想定位：双框中心 = d 帧 boss 框（上限） | 401 = 90.9%（77.1%） | 6823 = 91.7%（85.5%） |
| 跟踪 + 尺度：单框，中心和边长（1.5×）取 d−3 帧 | —* | 6174 = 83.0%（77.3%） |
| 整屏 384×240，boss 高 ≥40 px | 398 = 90.2%（76.5%） | 6757 = 90.8%（84.7%） |
| 固定双框 ∪ 整屏（两路都有时） | 428 = 97.1%（82.3%） | 7292 = 98.0%（91.4%） |

- *手标的 460 帧是按旧时钟（录像 meta）切的，大多没有 d−3 的检测框，跟踪两行会退化成固定中心，手标列不报。
- 固定双框失败（手标 88 帧）：boss 比 530 还大 47（抓取 / 贴脸近景，抓取类只有 1/31 过）、被框边切掉（70–90% 在框内）19、在两个框外 12、太小 10。不算抓取时 352/410 = 85.9%（检测 88.8%）。按类型（固定、中位数中心，手标）：金光 28/31、ok 157/181、hit_pf 71/92、hit_unk 96/106、grab 1/31。按 boss 高：<100 px 14/24、100–200 79/87、200–350 168/174、≥350 92/156。
- 「≥70% 在框内」：手标 固定 88.2%，理想定位 94.6%；检测 89.1% / 93.5%。
- 整屏 384×240 的 boss 高度（手标，5/25/50/75/95%）：32 / 65 / 100 / 128 / 212 px；远处（原图高 <100 px）0/24 够用。
- 判定：按「全部决策帧」为分母，所有方案都不到 90%（约 15% 的决策帧 boss 根本看不见）。按「boss 可见的帧」为分母：固定双框 80%，不过；学出来的定位只有理想上限（91%）过线，用上一帧框的跟踪 80% 不过；整屏 384×240 刚过（90.2% / 90.8%）；固定双框和整屏两路并用 97%。
- 产出：`data/moveid/boss_boxes/`（每轮帧号 → 框 + 置信度），`data/moveid/gate0/`：`coverage*.txt|json`、`check/`（目测网格图 + `grades.json`）、`fail/`（`fixed_*` 检测框的失败样例，其中混有检测器自己的错框；`gt_fixed_*` 手标框的失败样例；`adaptive_*` 跟踪 + 尺度方案的失败样例）、`label_sheets/`、`label_set.json`、`yolo/`。
