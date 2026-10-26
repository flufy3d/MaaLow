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
- 每个模型 × {cpu 1/2/4 线程, nnapi, qnn}（qnn 要装 QNN 插件，没装就退回 CPU，行里标 `qnn1->cpu`，见根 README“NPU：QNN 插件”）：首次 + 预热 20 + 计时 200。游戏在前台跑着（和实战一样抢 CPU），同一模型两次跑 p50 能差 1.5 倍；多线程基本不比单线程快。
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

## 顺序 2：逐帧特征（2026-10-24，`s2_views.py` / `s2_features.py` / `s2_emb_check.py`）

给自动切片、聚类用：每个录像每一帧（不隔帧）的三路视图嵌入 + 运动量。

```
# 1. 抽特征（可重复跑、可续跑：status.json 里 ok 且 npz 在、模型名相同的录像跳过）
uv run --no-project --with torch --with timm --with av --with opencv-python-headless --with numpy \
    --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
    python workspaces/WhereWindsMeet/tools/dufu_moveid/s2_features.py [--procs 2] [--mem 0.25] [--only ID,ID] [--first N]
# 2. 自查（视图切图、帧间余弦、接触前后运动量、全量完整性）
uv run --no-project --with av --with opencv-python-headless --with numpy --with matplotlib \
    python workspaces/WhereWindsMeet/tools/dufu_moveid/s2_emb_check.py [--seed 1] [--rec 20261023-062323]
```

### 视图（`s2_views.py`，训练和 Pad 上的预处理都按它）

- `glob`：整屏 → 384×240；`big`：中心 (555, 320)、边长 530 的方框 → 192×192；`small`：同中心、边长 260 → 192×192。1080×720 下 big = [290, 55, 530, 530]，small = [425, 190, 260, 260]（[x, y, w, h]），都在画面内；别的分辨率按高 / 720 缩放，框出界就平移回画面内（不缩小）。
- 插值一律 `cv2.INTER_AREA`（App `infer()` 默认的 `resize: "area"`），像素保持 uint8、BGR；颜色转换和归一化归模型。Pad 上就是 `infer(roi = 上面的框, size = …, resize = "area")`。
- `area_weights()`：同一个面积滤波写成矩阵（`Wy @ 图 @ Wx.T`，float32、关 TF32、四舍五入），批量在 GPU 上算；每个录像随机 2 帧和 `views()`（cv2）逐像素比对，197 个录像最大差 1 级（个别像素 .5 舍入），记在 status 的 `view_maxdiff`。

### 模型和产出

- DINOv3 ViT-S+/16（`facebook/dinov3-vits16plus-pretrain-lvd1689m`，经 timm `vit_small_plus_patch16_dinov3.lvd1689m` 加载；和 transformers 加载官方权重的 CLS 余弦 1.0000）。选它：自监督特征（DINOv3 的局部特征比 v2 好，这里看的就是起手动作和光效），patch 16 正好整除 384×240 和 192（不用补边、不用插值位置编码，RoPE），S+ 比 S 好一档、29M 参数在这块卡上不是瓶颈。输入 RGB、/255、ImageNet 均值方差，fp16；取最后 norm 之后的 CLS（384 维）。
- `data/moveid/emb/<录像id>.npz`：`glob` / `big` / `small` = [帧数, 384] float16；`mot_glob` / `mot_big` / `mot_small` = [帧数] float32，该路视图灰度（cv2 BGR2GRAY 同公式）和上一帧的平均绝对差（0–255，第 0 帧记 0）；`model`（模型名）、`frames`、`boxes`（视图的源框 JSON）。
- `emb/status.json`：每个录像 `ok, frames, expected（index.json 帧数）, sec, fps, gpu_sec, view_maxdiff, bytes, model, gpu_mem_gb`，外加 `n_ok, n_frames, bytes, last_run`。
- `emb/check/`：`<录像>_f<帧>_{full,glob,big,small}.png`（full 上画了大框黄、小框紫）、`stats_<录像>.json`、`motion_<录像>.png`、`integrity.json`。

### 结果

- 197 个录像全部完成，737,198 帧，和 index.json 的帧数逐个相等，没有 NaN / inf；npz 共 1.71 GB。
- 耗时：主跑 191 个录像 3541 s（723,854 帧，平均 204 帧/秒，2 个进程；期间另一个任务也在用 GPU，单独跑时约 340 帧/秒），加试跑的 6 个约 1 分钟。每进程显存约 3.0 GB（`--mem 0.25` 封顶），两进程约 6.2 GB。
- 速度上踩过的坑：
  - 解码：PyAV 的 NVDEC（`h264_cuvid`）逐帧同步只有约 110 帧/秒，不如 CPU 多线程解码（约 1000 帧/秒/进程）。
  - **同一进程里 import 了 torch 之后 PyAV 解码掉到约 100 帧/秒**（本机 Windows，原因没查），所以解码放在不 import torch 的子进程，通过共享内存环形缓冲（页锁定后拷到 GPU）传整帧。
  - cv2 的 INTER_AREA 在 2.8 倍非整数缩放时单核约 10 ms/帧，改为 GPU 上的面积矩阵。
  - 模型：WDDM 下小批次的启动开销占大头（批 32 eager 约 300 张/秒），固定输入尺寸（RoPE 表缓存）+ CUDA graph，批 64 约 770 张/秒（384×240）/ 2700 张/秒（192²）。
- 自查（`--seed 1 --rec 20261023-062323`，93 个接触）：
  - 切图：2 个录像各 3 帧，大框 / 小框位置和 `views()` 一致（`emb/check/`，待人看）。
  - 帧间余弦（中位数 / 5% 分位）：glob 0.952 / 0.848，big 0.928 / 0.776，small 0.905 / 0.709；小框变化最大，符合「近处细节」的预期。1 − 余弦和运动量的相关 0.73–0.76。
  - **约 12.4% 的帧和上一帧几乎一样**（`mot_glob` < 0.3，余弦 ≈ 0.9997）：录像在抓屏没跟上时重复帧，运动量曲线是锯齿。切片 / 测速度时要把这些帧当「没有新画面」处理（或用相邻非重复帧插值），不能当静止。
  - 运动量在接触前后：全部 197 个录像按类型平均 `mot_small`，接触后 0..+5 帧明显升高（ok 29.9、hit_unk 27.8、flare 28.5，接触前 −15..−1 帧 15–20，峰值在 +2/+3 帧）；接触前只有缓慢上升，金光（flare）在 −30..−10 帧略高。抓取（grab）全程都高（过场镜头）。也就是运动量能标出「接触」本身，起手要靠嵌入，不能只靠运动量。

## 顺序 2：光色与连段（2026-10-24，`s2_*.py`）

给每个接触（index.json 的 7982 个）标光色、连段和掉血，产出 `data/moveid/events_ext.json`，统计页 `data/moveid/color/stats.md`。

```
PY="uv run --with opencv-python-headless --with numpy python"
TORCH="uv run --with torch --with torchvision --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match --with numpy python"
D=workspaces/WhereWindsMeet/tools/dufu_moveid
$PY $D/s2_feat.py --procs 8        # 逐帧候选亮线 → color/feat/<rec>.npz；同一次解码存接触前 36 ~ 后 2 帧的候选裁剪 → color/crops/（约 1 小时，2.3 GB）
$PY $D/s2_crops.py                 # 只在 feat 先于裁剪生成时补裁剪
$PY $D/s2_label.py sheet [--mode strat|red|uncertain|pred:R|pred:G]   # 手标网格 → color/label_sheets/
$PY $D/s2_label.py set s001 "GNCN ..."                               # 写入 s2_labels.json（R 红光 / G 金光 / C 碰撞冲击 / N 其他 / ? 跳过）
$TORCH $D/s2_model.py              # 5 折（按录像分组）交叉验证 + 全量训练，预测全部裁剪 → color/crop_probs.json（显存约 0.7 GB）
$PY $D/s2_color.py                 # 每个接触的颜色 → color/color.json
$PY $D/s2_events.py                # 连段 + 掉血 + 合并 → events_ext.json、color/stats.md
$PY $D/s2_check.py sheets --seed 2 # 自查网格 → color/check/{gold,red,flare,none}_NN.jpg + samples.json
$PY $D/s2_check.py grade data/moveid/color/check/grades.json
```

### 光色

- 提示光的样子：boss 身上一颗星芒 + 一条贯穿画面的水平亮线（镜头光晕），金或红，持续约 5–10 帧，接触前约 7–19 帧出现。场景里的红天、红龙、红色刀光、爆炸、接触瞬间的碰撞火花（白 / 橙色细线 + 放射线）都不是提示光，主要干扰是后两者。
- `s2_feat.py`：每帧（行 60–600，半分辨率）找细的水平亮脊（V ≥ 200，比上下 8 / 20 px 亮 ≥ 40），每帧留最强的 3 行，记长度、位置、亮线晕的色相计数。长度 ≥ 150 px 的候选在接触前 36 ~ 后 2 帧切 480×240（缩到 240×120）。
- `s2_model.py`：ResNet-18（ImageNet 权重）在裁剪上分 R / G / C / N 四类，只做翻转和亮度 / 对比度扰动（不扰动色相）。手标 478 张（`s2_labels.json`：分层随机、红色候选、不确定样本、模型判 R / G 的样本，22 张网格），按录像分组 5 折：R 75/78、G 98/99，R↔G 互错 0，其余错误都在 C / N 之间。
- `s2_color.py`：每帧 pR / pG = 该帧候选的最大值；max ≥ 0.5 的帧（间隔 ≤ 2 帧）连成一段光。接触的窗口 = [接触 − 30, 接触 − 2]，并截在上一个接触之后（光归它之后的第一个接触；连段后续段的颜色看 `chain_color`）。窗口里有光：取最晚的一段，颜色 = 段内 ΣpR 和 ΣpG 大的那个；峰值 < 0.8 或少数色占比 > 25% 记 unknown。没有光记 none。窗口不到 4 帧且没光（紧跟上一个接触）记 unknown。`color_conf`：金 / 红 = 峰值 ×（1 − 少数色占比），none = 1 − 窗口内最大 p（短窗口再 ×0.5）。`color_onset` = 光的第一帧 − 接触帧。

### 自查（`color/check/`，随机种子 2，`grades.json`）

| 组 | 判定 | 实际 | 错判 |
|---|---|---|---|
| 随机 60 个 gold | 59 金 + 1 看不清（#24，我方绿色技能光盖住） | 59/59 | gold→red 0/60 |
| 随机 60 个 red | 60 红 | 60/60 | red→gold 0/60 |
| 40 个和 aux flare 不一致的 | 22 个判 gold（aux 没报）全是金光；17 个 aux 报了、判 none 的，逐帧看窗口里都没有提示光（是红色刀光、爆炸、碰撞火花，或光在上一个接触之前）；1 个 aux 报金、判 red 的确实是红光 | 40/40 | – |
| 随机 40 个 none（另加，查漏） | 逐帧看整个窗口，没有漏掉的金 / 红光 | 40/40 | – |

- 存疑：gold 组里 4 个（#1 #12 #13 #35）光起点在 −23 ~ −29 帧，是一道金光的尾巴，颜色没错，但这道光是不是这个接触的招（还是上一招被闪掉的）说不准；ok 接触里的 5 个 gold 有 4 个就是这种（起点 −24 ~ −29）。
- 自查是同一个人（本代理）看的，网格图留着供复核。

### 结果

- 颜色：gold 554（6.9%），red 523（6.6%），none 6827（85.5%），unknown 78（1.0%）。
- 和 aux flare（index `flare`）一致率 91.3%（7291/7982）：都说金 256；aux 报金、像素判非金 393（320 个是连段后续段，金光在上一个接触之前或根本没有；19 个其实是红光）；像素判金、aux 没报 298（aux 是 400 ms 一次的规则，漏掉的多）。
- 卸势结果：ok 里被标成 gold 的 5/3519 = 0.14%（见上面的存疑，4 个是很早的金光尾巴）；按颜色看 ok /（ok + hit_pf）：gold 5/228 = 2%，red 302/338 = 89%，none 3179/4458 = 71%，和「金光卸不了、红光能卸」一致。
- 光起点到接触（帧，5/25/50/75/95%）：gold 7 / 9 / 10 / 12 / 15，red 9 / 11 / 14 / 16 / 19。

### 连段

- 相邻接触间隔（同一录像）的直方图在 6–45 帧一个大峰（同一招的连续几段），96–105 帧另有一个小峰（下一招），中间 60–90 帧是低谷；9 帧平滑后在 45–95 帧之间取最低点，得 `CHAIN_GAP` = 73 帧。间隔 ≤ 73 帧、且这一下自己没有新的金 / 红光（新光 = 新的一招）就接到上一串。
- 「boss 回到待机」没有直接读数，用间隔低谷代替；所以长串（≥ 8 段，约 80 串）里可能混着两招紧接着出的情况。
- 抓取过场：labels.py 的 `grab`（抓取后续几下）连同它前面那一下单独成串（`chain_kind: grab`），不和前后合并；157 串，147 串是 4 段。
- 串长度：1 段 1554、2 段 774、3 段 276、4 段 450（其中抓取 147）、5 段 143、≥ 6 段 206。按开场颜色（不含抓取）：gold 399 串平均 2.09 段，red 523 串平均 1.22 段（红光多是单发），none 2321 串平均 2.54 段。串内段间隔中位 26 帧（5–95%：6–56）。

### 伤害

- `reads.py` 的 `health()`，每个接触 before = [c − 2, c + 3] 的中位（不早于上一个接触 + 7），after = [c + 7, c + 12] 的中位（不晚于下一个接触 + 4），dmg = before − after（满血 = 1；读不到 null）。
- hit 中位约 5%（hit_pf 0.055，hit_unk 0.051），95% 约 9–10%；抓取每下约 3%；ok 全是 0（最大 0.03，验证读法）。≥ 12% 的只有 14 下（最大 0.40），是候选的「致命招」。flare 类型里约 1/4 是 ok 接触，所以掉血四分位从 0 起。
- 按颜色：gold / red 的 hit 中位 6.4% / 6.7%，≥ 10% 的占 13% / 17%；none 中位 4.3%，≥ 10% 只有 0.6%。

### events_ext.json

`{fields, chain_gap, events}`；每项 `id`（= index events 的 id）、`rec, round, frame, type`（抄 index）、`color, color_conf, color_onset, color_onset_frame, color_guess`（unknown 之前的猜测）、`chain_id, chain_pos`（0 = 开场）、`chain_len, chain_kind`（move / grab）、`chain_color`（开场那一下的颜色）、`gap_prev`（帧，与同录像上一个接触，首个为 null）、`dmg`。

### 注意

- 手标只有 478 张，覆盖了这次全部 197 轮的场景；换 boss / 阶段要重新标。
- `color/crops/` 2.3 GB，重跑 `s2_model.py` 才需要；`feat/` 39 MB。

## 顺序 2：切片与聚类（2026-10-24，`s2c_*.py`）

一串（events_ext 的 chain = 一次出招）一个样本，全自动聚成招式类（只编号），出招式表、成员、样例拼图和报告。

```
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s2c_all.py [--no-stability] [--seed N]   # 一条命令，约 3.5 分钟，无 torch
# 分步（s2c_all.py 就是依次调这四个）：
uv run --no-project --with numpy python $D/s2c_slice.py                                     # 切片 → moves/slices.npz / slices.json（850 MB）
uv run --no-project --with numpy --with scikit-learn --with umap-learn python $D/s2c_cluster.py [--post] [--out DIR]
uv run --no-project --with numpy --with opencv-python-headless python $D/s2c_sheets.py [--only 3,7]
uv run --no-project --with numpy python $D/s2c_report.py                                    # report.md（夹带人写的 review.md）
```

### 产出（`data/moveid/moves/`）

| 文件 | 内容 |
|---|---|
| `slices.npz` / `slices.json` | 每串 [首接触 −60, 末接触 +10] 帧的三路 CLS（fp16）、重复帧标记、每录像平均嵌入；每串的偏移、各段颜色 / 类型 / 结果 / 掉血 |
| `taxonomy.json` | `classes[]`：id（−1 = 未知）、kind（move / grab）、n、颜色及纯度、串长分布 / 众数占比、节奏模板（众数串长的各接触偏移中位 / IQR）、起手（类级 + 逐串中位 / IQR）、卸住率 / 被打率、掉血（平均 / 总 / 占比）、fatal、members（chain_id）；另有 params、stability、outcome_leak |
| `assign.json` | chain_id → class、conf（HDBSCAN 成员强度，未知 = 0） |
| `log.txt` | 每步检查做了什么（颜色拆 / 小类 / 节奏拆 / 合并 / 差一点合并的对），工作 id → 最终 id 的对照 |
| `sheets/c<id>.jpg`、`unknown.jpg` | 每类随机 6 串（未知 12 串）：整屏@首接触 + 大框 −30 / −20 / −10 / 0 / +5 |
| `review.md` → `report.md` | 人看拼图的结论（注明对应哪次 `generated`）；report 的数字全由代码生成 |

### 方法与参数（`s2c_cluster.py` 顶部常量）

- 表示：每路 CLS 减本录像平均，窗口 [−60,−41] [−40,−21] [−20,−11] 取均值并 L2 归一（3 窗 × 3 路 × 384）；节奏 = 第 2–4 个接触有无 + 偏移 / 30，×1.5（`RHY_W`）；开场颜色 one-hot ×2（`COLOR_W`）→ PCA 64 → UMAP（30 邻居，10 维，min_dist 0，seed）→ HDBSCAN（最小簇 20；抓取串单独聚，15）。
- 检查顺序：颜色拆（少数 > 3%）→ 小类（< 15）归未知 → 节奏拆（串长，否则第 2 接触偏移；1 维 GMM k = 1..4 选 BIC，dBIC > 10，相邻组距 ≥ 1.5 段 / 8 帧且 ≥ 2 倍合并标准差，每组 ≥ 15 串且 ≥ 15%，否则相邻组并回；1 段串按最近中心归；最多 3 轮）→ 合并（同色、同众数串长、各接触偏移中位差 ≤ 4 帧、PCA 中心距 < (0.6 + 0.4 × (串长 − 1)) × 平均半径；串越长共同节奏越多，视觉门槛越松）→ 小类归未知。
- 起手：`onsets()`，大框轨迹的类内一致度 |m(t)| 的上升点；升幅 < 0.1 记「−60 帧时已一致」。
- 稳定性：奇偶轮各跑全流程（最小簇、小类、节奏最小组按样本比例缩放），最近类中心（PCA）投到另一半，与另一半自己的聚类比 ARI；另报 kNN10。种子 1–3 与种子 0 比。

### 试验记录（为什么画面只到 −11 帧）

| 表示（都加节奏 ×1.5） | 类 | 覆盖 | 串长众数占比 | 首接触卸住 NMI | 极端类占比 | 种子 ARI |
|---|---|---|---|---|---|---|
| 接触前 4 窗 + [0,5] [6,15] + 末接触后 10 帧 | 47 | 0.87 | 0.90 | 0.066 | 14% | 0.77 |
| 同上，接触后窗口 ×0.5 / ×0.3 | 41 / 40 | 0.91 / 0.92 | 0.91 | 0.057 | 12% | 0.92 / 0.86 |
| 接触后去掉结果方向（INLP） | 44 | 0.91 | 0.90 | 0.058 | 12% | 0.87 |
| 接触前 4 窗（含 [−10,−1]） | 39 | 0.91 | 0.91 | 0.047 | 8% | 0.87 |
| **[−60,−11] 3 窗 + 颜色 ×2（采用）** | 42 | 0.95 | 0.90 | 0.040 | 7% | 0.86–0.93 |

- 带接触后画面时，同一个红光招按玩家结果分成「全卸住」「全挨打」两类（例：红光单发两类卸住率 1.0 / 0.0，接触前画面一样，+5 帧一边是卸势火花一边是受击），权重降到 0.3 或 INLP 都分不回来；只用接触前画面后合成一类。
- 颜色 one-hot：×0 / ×1 / ×2 覆盖 0.905 / 0.918 / 0.938，类数不变；颜色拆分本来也会按颜色切，加进表示只是让少数色串直接落到对的类，不再拆出 < 15 的碎片丢进未知。
- 节奏特征 ×0 / ×0.5 / ×1 / ×1.5 / ×2（当时的表示还含接触后窗口）：串长众数占比 0.67 / 0.70 / 0.81 / 0.89 / 0.90，种子 ARI 0.86 / 0.91 / 0.80 / 0.87 / 0.75。
- 半数据用全量的最小簇 20 时只聚出 25 类（全量 45），奇偶 ARI 0.55 / 0.65；按样本比例缩放阈值后同粒度比较。

### 结果（2026-10-24 13:17 这一版，详见 report.md）

- 出招 42 类 + 抓取 1 类；覆盖 95.3%（3094/3246）；43 类开场颜色少数方全部 ≤ 3%（最差 0.7%）；串长众数占比按串加权 0.904（< 0.7 的 7 类）。
- 稳定性：奇偶 ARI 0.671 / 0.645（kNN 0.642 / 0.688），种子 ARI 0.86 / 0.86 / 0.93（两边都归类 0.91 / 0.90 / 0.97）。
- 致命招：22 类覆盖 81.1% 掉血；单类最大是金光四段 c11（13%）、火球雨长连段 c7（10%）、抓取 c42（8%）。
- 拼图：红龙招按镜头远近被过拆（c8/c24、c18/c19/c37、c22/c28），none 色近身单发 / 二段被欠拆成大杂烩（c0、c1、c2、c4）；c41 像是没标成 grab 的抓取（节奏 42/60/86 和 c42 一样，+5 帧是抓举镜头）。

### 注意

- 串 ≠ 招：被闪掉的接触不出现、紧接着的无光招会粘进同一串（≤ 73 帧），所以串长在同一招里也会变；节奏拆分按规格照拆，拆出的「少一段」类（如 c40 对 c11）在拼图里是同一招。
- 起手估计依赖 −60 帧之前的画面「不一致」；红光、近身类多数在 −60 帧就已一致（前一招固定或起手更早），只给逐串中位，类级记「—」。
- UMAP 设了 random_state，同参数重跑结果逐位相同（已验证）；类号按类大小排序，换参数后类号会变，review.md 要重写。

## 顺序 3：老师模型与关 1（2026-10-24，`s3_*.py`）

关 1 判定：致命招在决策时刻能分开、金招被当成红招 ≤3%。老师 = 冻结的 DINOv3 patch 特征 + 可训练注意力池化 + 因果时序 transformer，按轮次 5 折，所有数字是 out-of-fold。口径（`s3_gate1.py` 文档字符串、`s3_common.py` 的等价组）在训练前写定，没改过；看过 fold 0 后加的只有 `s3_diag.py` 的事后诊断，单独标注。

```
TORCH="uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match"
D=workspaces/WhereWindsMeet/tools/dufu_moveid
uv run --no-project --with numpy python $D/s3_common.py      # 等价组、折、要缓存的帧数（自查）
HF_HUB_OFFLINE=1 $TORCH --with timm --with av --with opencv-python-headless python $D/s3_cache.py --procs 3 --mem 0.3   # patch 缓存，35 分钟，可续跑
$TORCH python $D/s3_baseline.py                               # CLS 基线（线性 / 最近类中心），8 分钟
$TORCH python $D/s3_train.py --epochs 16                      # 5 折训练 + OOF 预测，77 分钟，显存约 10 GB
uv run --no-project --with numpy python $D/s3_diag.py         # 事后诊断 → teacher/diag.md
uv run --no-project --with numpy python $D/s3_gate1.py --extra-md data/moveid/teacher/diag.md --extra-md data/moveid/teacher/check/review.md
uv run --no-project --with av --with opencv-python-headless --with numpy python $D/s3_check.py   # 抽查图
```

### 标签、样本、折（`s3_common.py`）

- 每一帧 t 的目标取「t 之后（含 t）的下一个接触 c」：类 = c 所在串的类（assign.json，43 类 + 未知；另加第 45 个输出 idle），颜色 = 该串开场颜色（gold / red / none；unknown 不算损失），接触时间 = c − t（0..45 帧，>45 记「无」）。
- 类和颜色只在 [c − 30, c] 上算损失；idle = 下一个接触 >60 帧且上一个接触 ≥30 帧之前；中间的帧只训接触时间。起手帧头没做（类级起手估计多数是「—」，不可靠）。
- 折：197 轮按串数贪心分 5 折（39–40 轮 / 折），同一轮只在一个折里。每折再拿训练轮的 10% 做内部验证，选验证损失最低的 epoch，测试折只用来出 OOF。

### 缓存（`s3_cache.py`）

- 帧：每个接触的 [c − 61, c]（30 帧样本 + 31 帧历史）+ 每段空闲中间 16 帧及其历史，共 446,961 帧（全部 737,198 帧的 61%）。
- 三路视图按 `s2_views`（GPU 面积矩阵，同 `s2_features`）原分辨率进 DINOv3 ViT-S+/16（和顺序 2 的 CLS 同一份权重），`forward_features`（最后 norm 之后），去掉 4 个 register：每帧 651 个 token = 3 个 CLS + 整屏 15×24 + 大框 12×12 + 小框 12×12，各 384 维。
- 存 int8（每 token 一个 fp16 尺度，absmax/127）：`teacher/cache/<rec>.tok`（[n, 651, 384] int8）、`<rec>.npz`（frames、scale）、`status.json`。共 111.7 GB。CLS 和 `emb/` 的余弦 ≥0.9999。
- forward_features 套 CUDA graph 在这台机器上输出 NaN（s2 的 CLS 版本没事，原因没查），改成 eager，批 64 一样快（整屏约 680 张/秒、裁剪约 2600 张/秒）；3 进程合计约 214 帧/秒（每个录像要整段解码）。

### 模型（`s3_train.py`，17.7M 可训练参数）

- 逐帧：651 token → LayerNorm → Linear 384→256 + 每个 token 位置一个可学嵌入（含视图身份）→ 24 个可学 latent 交叉注意全部 token（8 头）+ MLP → latent 自注意 + MLP → 展平 → Linear 512；加上三路运动量和重复帧标记（Linear 4→512）。
- 时序：4 层 pre-norm transformer（512 维 8 头），因果滑窗 T = 32 帧（t−31..t），每层每头一组可学相对位置偏置；dropout 0.1。
- 输出头：类 45、颜色 3、接触时间 47。损失 CE 类 + CE 颜色 + 0.5 × CE 接触时间。
- 训练：每段连续缓存帧切成 ≤128 帧的块（步长 97），只在块内位置 ≥31（历史满 32 帧）的帧上算损失；AdamW lr 3e-4 wd 0.05，1 epoch 预热 + 余弦，16 epoch，批 16 块，bf16；10% 的帧换成上一帧（模拟录像重复帧，运动量置 0）。最佳 epoch 11–13；每 epoch 约 60 秒（约 6.6k 帧/秒，GPU 受限）。
- 推理：同样切块；每段第一块的前 31 帧历史不满也输出（只发生在录像开头）。

### 基线（`s3_baseline.py`）

已存 CLS，特征 = 三路各三个窗 [t−49, t−30] [t−29, t−10] [t−9, t] 的均值减去本录像 0..t 帧的均值（因果版的聚类表示），L2 归一，3456 维。线性：一层三头 softmax（固定超参，不在测试折上调）；最近类中心：余弦最近的类中心 / 颜色中心，没有接触时间头。同样的折和训练位置（每 2 帧取一帧）。

### 产出（`data/moveid/teacher/`）

| 路径 | 内容 |
|---|---|
| `oof.npz` | 老师 OOF：每个接触（7982）在其 −30..0 帧的 `p_cls` [.., 31, 45]、`p_col` [.., 31, 3]、`p_tte` [.., 31, 47]、`valid`、`fold`；每串的 −16..−4 就是开场接触那一行 |
| `teacher/fold<k>.pt`、`log.json`、`oof_fold<k>.npz` | 各折权重（最佳 epoch）、逐 epoch 训练 / 验证记录 |
| `baseline/oof_linear.npz`、`oof_ncc.npz`、`log.json` | 基线 OOF（同格式；ncc 没有接触时间） |
| `gate1.json` / `gate1.md` | 所有数字的分子 / 分母；报告（含颜色 3×3、致命类混淆前 20 对、逐类、等价组、诊断、抽查结论） |
| `diag.md` | 事后诊断（`s3_diag.py`） |
| `check/` | 抽查图 + `index.json` + `review.md`（人工结论） |
| `cache/` | patch token 缓存（111.7 GB，重训才需要） |

### 结果

应对等价组（训练前定）：原口径 {c2, c3, c16, c17, c18, c19, c27, c31, c32, c33, c36, c37}、{c5, c9, c12, c15, c26}、{c6, c13, c38}、{c8, c24}；修正口径把 c3 / c27（没光但卸住率 0，应对是闪）从第一组拆出。两种口径下老师的 (b) 数字相同。

| −10 帧 | 老师 | 线性基线 | 最近类中心 |
|---|---|---|---|
| (a) 金→红 | **1/554 = 0.2%** | 4/554 = 0.7% | 95/554 = 17.2% |
| 金→没光 / 红→没光 / 没光→金 | 3.6% / 1.7% / 1.2% | 20.6% / 11.3% / 2.5% | – |
| (b) 致命类 top-1（原口径） | **1410/2150 = 65.6%** | 1403/2150 = 65.3% | 946/2150 = 44.0% |
| 接触时间 \|误差\| 中位 / p90（帧） | 3 / 15 | 5 / 14 | – |
| 致命串应对（闪 / 卸）判对 | 2089/2149 = 97.2% | 2057/2149 = 95.7% | – |
| 其中该闪判成卸 | 44/698 = 6.3% | 33/698 = 4.7% | – |

- **关 1：不过**。(a) 在 −16..−4 每一帧都 ≤0.4%；(b) 在 −10 / −8 / −6 是 65.6% / 66.0% / 65.5%，离 90% 很远，修正口径也一样。曲线见 gate1.md。
- 老师比 CLS 多出来的主要在颜色：金 / 红光被判成「没光」从 20.6% / 11.3% 降到 3.6% / 1.7%，金→红从 4 例到 1 例。类别准确率和线性基线几乎一样。
- 事后诊断（不是关 1 口径）：只在 43 类里取 argmax（不让 idle 输出）68.6%；同一批 ≥3 段的致命串在第 1 / 2 / 3 个接触前 10 帧分别是 49% / 65% / 71%，看到前面几下后才认得出，说明不少类是靠后面的节奏分开的；按「同开场颜色 + 同应对（闪 / 卸）」算 98.6%。
- 错例（`check/review.md`）：唯一的金→红是光刚出现那一帧、偏橙；致命类的错主要是 (1) 开场相同、区别在第二下之后的类（c0 ↔ c2，c10 / c14 / c20 → c0 / c2）；(2) 远处突进或被挡住的招（c27、c4），−10 帧前看不到起手，模型判 idle，接触时间也判「无」；(3) 顺序 2 就标记过的标签问题（c40 ≈ c11 少一段，c41 ≈ 漏标的抓取）。

### 注意

- (b) 的类别是用 [−60, −11] 的 CLS 画面加节奏（第 2–4 个接触偏移）聚出来的，节奏是决策时刻之后才发生的事，所以「−10 认类」有一部分本来就做不到；这一点在训练前没有写进口径，按原口径报不过。
- 缓存（111.7 GB）远大于内存（32 GB），每个 epoch 都从 NVMe 重读；读线程单独测约 9k 帧/秒（约 2.2 GB/s），比 GPU 的约 6.6k 帧/秒快，所以训练是 GPU 受限。

## 顺序 3b：前缀招式与新关 1（2026-10-24，`s3b_*.py`）

用户同意改口径（plan「决定 2026-10-24」）：招式按前缀认、每一下重新认；关 1 = 致命招的每一下在决策时刻（−10）应对判对 ≥90% + 金招被当成红招 ≤3%，接触时间误差另报。前缀组、应对标签、关 1 口径都在训练前写定（`s3b_prefix.py` / `s3b_gate1.py` 文档字符串），训练后没改。

```
D=workspaces/WhereWindsMeet/tools/dufu_moveid
uv run --no-project --with numpy --with scikit-learn python $D/s3b_prefix.py      # 前缀组 + 每个接触的标签 → teacher_prefix/prefix.json，约 1 分钟
uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
    python $D/s3b_train.py                                                        # 5 折，95 分钟，显存约 13 GB；复用 teacher/cache
uv run --no-project --with numpy python $D/s3b_gate1.py --extra-md data/moveid/teacher_prefix/check/review.md   # 关 1（含上一轮老师同口径对比）
uv run --no-project --with av --with opencv-python-headless --with numpy python $D/s3b_check.py                  # 抽查图
```

### 前缀组（`s3b_prefix.py`）

- 每个位置 k（串里第 k 下，0 = 开场）单独分组。样本 = 位置 k 上的接触；某类在 k 上 <10 个 → `k<k>:rare`，HDBSCAN 未知 → `k<k>:unk`，抓取过场里的接触（index outcome `grab`）→ `k<k>:grab`（单独处理，不训应对、不进 (b)）。
- 「分不开」的判据：用到这一下为止已知的东西训一个多类逻辑回归（标准化、类别平衡），按同样的 5 折出 OOF 混淆。特征 = 上一轮老师在**接触帧（0）**上的 OOF 输出（类 45 + 开场颜色 3，取 log；不用 −10 帧，避免用决策难度定义类别）+ 前 k 下之间的间隔（/30）。然后凝聚合并：每次合并混淆最大的一对（max(A→B, B→A)），合并后重算组间混淆，直到所有对都 <0.2。
- 结果：87 组（k0 21、k1 11、k2 11、k3 11、k4 7、k5 5、k6–8 各 4、k9–12 各 2、k13 1，含 rare / unk / grab）。逻辑回归在各位置的类准确率 0.52–0.98，合并后组准确率 0.86–0.98。k0 的无光近身招（c0 / c1 / c2 / c4 / c10 / c14 / c20 …共 20 类）合成一大组；c3、c27（无光、卸不住）各自单独成组；c11 + c40（金光四段 / 少一段）在 k0–k2 合并。
- 每组记：成员类、接触数、这一下的颜色、应对（组内多数）、卸住率、结果、掉血、下一下是否还有及间隔分位（`prefix.json` 的 `groups[]`）。

### 应对标签（`s3b_gate1.response_labels`）

这一下自己的光是金 → 闪；否则组的卸住率 ok / (ok + pf) <20% 且 ok + pf ≥10 → 闪（不可卸）；否则卸；抓取过场 → 无。ok / pf 用 index 的 `outcome`（`type` 把 649 个接触标成 flare，掩盖了结果），只数组内非金、非抓取的接触；按 `type` 算的列表完全一样。共 卸 6355、闪 1167、无 460。

不可卸（组, 样本, ok / pf）：k0:c3 150（0/109）、k0:c27 45（0/13）、k1:c11+c40 118（3/83）、k1:c13+c41 31（2/20）、k2:c11+c40 118（1/96）、k2:c41 15（1/13）、k3:c11 101（0/76）、k3:c41 15（1/11）、k4:c11+c41 20（1/10）。金光串的后续段（自己没光）按数据都是「闪」，c13 的第 2 下也是（和 c41 并组）。k1:c3（11 个，ok + pf <10）按规则是「卸」，见存疑。

### 老师（`s3b_train.py`）

- 和 `s3_train.py` 同一套：冻结 DINOv3 patch 缓存 → 24 latent 注意力池化 → 4 层因果 transformer（t−31..t），训练流程、折、增强、选 epoch 都不变；17.7M 参数，最佳 epoch 12–14。
- 输出头：前缀组（87 + idle）、**这一下自己的**颜色（上一轮是开场颜色）、应对（闪 / 卸 / 无接触）、接触时间（47 档）。应对单独一个头：它就是关 1 要的量，直接按标签训；组 + 颜色推出的版本另报（推出版更差，见下）。
- 新输入：接触历史 4 维（只用 6 帧之前已经发生的接触，模拟血条台阶 +5/+6 帧才看得到）：距上一个接触的帧数、前两段间隔、连着的接触数。32 帧窗口经常看不到第 k−2 下，前缀的节奏靠它补。

### 关 1 结果（−10，全部 out-of-fold；`teacher_prefix/gate1.md`）

| | 前缀老师 | 上一轮老师（同口径，应对由颜色 + 类推出） | 阈值 |
|---|---|---|---|
| (a) 金招→红（串） | **0/554 = 0.0%** | 1/554 = 0.2% | ≤3% ✓ |
| (a) 每一下 金→红 | 0/554 | 1/554 | – |
| (b) 致命招每一下应对判对 | **5277/5418 = 97.4%** | 5041/5418 = 93.0% | ≥90% ✓ |
| 其中 该闪判成卸 | 21/1115 = 1.9% | 20/1115 = 1.8% | – |
| 该卸判成闪 | 24/4303 = 0.6% | 67/4303 = 1.6% | – |
| 判成「没有接触」 | 96/5418 = 1.8% | 290/5418 = 5.3% | – |
| (b) 由组 + 颜色推出 | 5201/5418 = 96.0%（该闪判成卸 6.0%） | – | – |
| (c) 接触时间 \|误差\| 中位 / 75 / 90 分位（全部 7982 个接触） | 3 / 5 / 9 帧 | 3 / 6 / 13 帧 | – |
| (c) ±3 帧内 | 4993/7982 = 62.5% | 4304/7982 = 53.9% | – |

- **关 1（新口径）：过**。曲线 −16..−4：(a) 每帧 0/554；(b) 96.4% → 97.5%，−11 起稳定在 97.3–97.5%。
- (b) 抓取过场 435 个不计。按位置 k0–k4：97.0 / 97.4 / 97.3 / 98.9 / 99.0%。前一下还没到（gap_prev ≤10，582 个）97.9%，其余 97.3%。
- 弱的组：k0:c27 62%（33% 判成没有接触：远处突进、出画）；k1:c3 1/11（标签是卸，但模型判闪，见存疑）；k2:c41 73%、k3:c41 87%、k1:c13+c41 87%（抓取过场混在里面）。
- 推出版的「该闪判成卸」6.0% 主要来自 k1:c13+c41、k2:c41、k3:c41：组头把它们判成别的组；应对头不经过组，所以更好。
- 上一轮老师按新口径已经是 93.0%：上一轮 (b) 不过是口径问题，不是看不出来。新老师多出的主要是「判成没有接触」从 5.3% 降到 1.8%、「该卸判成闪」从 1.6% 降到 0.6%；「该闪判成卸」持平（上一轮的开场颜色头把金光串整串都判成闪，正好覆盖后续段）。
- (c) 90 分位误差的来源：尾部（≥9 帧，813 个）几乎全是预测偏晚或判「无」（偏晚 528、判无 195、偏早 16，只算 truth = 10 的接触），也就是招还没露出来、模型以为还远。按组：k0 无光大组（尾部率 18%，占尾部 34%）、c27（60%）、k0:unk（21%）。boss 远近（检测框高 <100 / 100–200 / 200–350 / ≥350：11 / 10 / 12 / 8%）和是否找到 boss（没框 10%）几乎不影响。最差的 10 个都是一击被拆成几个接触（gap 1–9）、全屏变灰特效或护盾泡泡盖住，模型判「无」。
- 致命招的接触时间：中位 2、75 分位 5、90 分位 8 帧，±3 帧内 65.0%。卸势窗口 3–9 帧，这仍是关 2 的主要风险。

### 产出（`data/moveid/teacher_prefix/`）

| 路径 | 内容 |
|---|---|
| `prefix.json` | 参数、87 组表、各位置的合并记录和 OOF 混淆、不可卸列表（outcome / type 两种）、金光串后续段、每个接触的 `gid / k / response / colour` |
| `teacher/fold<k>.pt`、`log.json`、`oof_fold<k>.npz` | 各折权重、训练记录 |
| `oof.npz` | OOF：每个接触 −30..0 帧的 `p_grp` [.., 31, 88]、`p_col`、`p_resp`、`p_tte`、`valid`、`fold` |
| `gate1.json` / `gate1.md` | 关 1 全部分子 / 分母（前缀老师 + 上一轮老师同口径），曲线、按位置 / 组 / 类分项、(c) 分项和尾部来源 |
| `check/` | `b_dodge_as_parry_*.jpg`（全部 21 个该闪判成卸）、`c_tte_worst_*.jpg`（误差最大 10 个）、`index.json`、`review.md`（错因） |

### 存疑

- 21 个「该闪判成卸」里 6 个是抓取过场（c41 / c40 串没标成 grab tick，顺序 2 已怀疑 c41 是漏标的抓取），10 个是金光串后续段被当成普通无光连段；还有 5 个这一下实际卸住了（标签按组的卸住率定）。
- k1:c3：c3 的第 2 下 11 个，ok + pf 只有 7（全是 pf，卸住 0），按规则（样本 <10）记「卸」，模型判「闪」，算 10 个「该卸判成闪」。规则没改。
- 接触历史是新加的输入（不是画面）：用 trace 对齐后的接触时刻、延迟 6 帧。实机要由血条 / 真气台阶自己检测，检测漏了或晚了会影响前缀；被闪掉的招不产生接触，这和训练数据一致。
- 前缀组的判据依赖上一轮老师接触帧的输出 + 逻辑回归 + 阈值 0.2，换阈值组数会变；应对标签只受「组的卸住率」影响，金光规则不依赖分组。

## 顺序 4：学生模型与对拍（2026-10-25，`s4_*.py`）

把前缀老师（顺序 3b）蒸馏成 Pad 上每帧约 10 ms 能跑完的小模型，量化成 int8，再出一份 QNN 版，PC 和 Pad 逐帧对拍。关 1 的口径、折、阈值、代码都沿用 `s3b_gate1.py`，没改。

```
D=workspaces/WhereWindsMeet/tools/dufu_moveid
TORCH="uv run --no-project --with torch --with timm --with numpy --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match"
uv run --no-project --with av --with opencv-python-headless --with numpy python $D/s4_cache.py --procs 8 --check 3   # 视图缓存，约 1 小时，222 GB
$TORCH python $D/s4_soft.py                                         # 每折老师在全部缓存帧上的软标签，13 分钟
$TORCH python $D/s4_train.py --folds 0,1,2,3,4 --final --epochs 8   # 5 折 + 最终模型，4.8 小时
$TORCH --with onnx --with onnxruntime python $D/s4_export.py --tag fold<k> --no-qnn   # 每折导出（int8 只用该折训练轮校准）
$TORCH --with onnx --with onnxruntime python $D/s4_export.py --tag final               # -> model/dufu2/
uv run --no-project --with numpy --with onnxruntime python $D/s4_eval.py --folds 0,1,2,3,4 [--prec int8]   # ONNX 的 OOF
uv run --no-project --with numpy python $D/s3b_gate1.py --out data/moveid/student/gate1 --old "" \
    --pred prefix_teacher=data/moveid/teacher_prefix/oof.npz --pred student_fp32=data/moveid/student/oof.npz \
    --pred student_onnx_fp32=data/moveid/student/oof_onnx_fp32.npz --pred student_int8=data/moveid/student/oof_onnx_int8.npz
uv run --no-project --with numpy python $D/s4_gate.py [--folds 2] --pred a=... --pred b=...   # 同口径，可按折比较
uv run --no-project --with onnx --with onnxruntime --with numpy python $D/s4_aihub.py        # AI Hub 暂存（只有模型 ONNX）
uv run --with qai-hub python $D/npu_aihub.py --dir <绝对路径>/data/moveid/student/aihub --device "Samsung Galaxy S25 (Family)"
uv run python $D/s4_pad.py run                                      # Pad 对拍 + 测速（先查空闲；临时 skill / 模型，跑完删掉并同步）
uv run --no-project --with numpy --with onnxruntime --with opencv-python-headless python $D/s4_pad.py compare data/moveid/student/pad/<时间>
```

### 结构（`s4_common.py`）

按现有 `infer()` 能跑的方式拆成三个模型、每帧四次调用（没改 Kotlin / C++）：

| 调用 | 模型 | 输入（infer 参数） | 输出 | 参数量 |
|---|---|---|---|---|
| 全局流 | `glob.onnx` | 整屏 → 384×240（`size [384,240]`、`color "bgr"`、`resize "area"`） | 128 维，`history` 追加到环 `glob`，aux = 接触历史 4 维 | 0.60 M |
| 大框 | `crop.onnx` | [290,55,530,530] → 192 | 96 维，环 `big`（aux 一个 0） | 0.44 M（两路共用） |
| 小框 | `crop.onnx` | [425,190,260,260] → 192 | 96 维，环 `small`（aux 一个 0） | |
| 时序头 | `head.onnx` | 无图；三个环 `extra ring:true`：[1,30,132] / [1,30,97] / [1,30,97] | 一个 141 维向量：前缀组 88（87 + idle）、这一下颜色 3、应对 3（闪 / 卸 / 无）、接触时间 47 | 0.68 M |

- 骨干：timm `mobilenetv4_conv_small_050.e3000_r224_in1k`（ImageNet 初始化），stem 卷积按 BGR 重排；stem + blocks 的最后一层特征图 → 全局平均 + 1×1 卷积到 16 通道保留位置 → Linear。输入 `v / 255`（infer 默认 mean 0 / std 1），×255 和 ImageNet 归一化在图里。
- 时序头：TCN，1×1 到 192 通道 + 4 个残差块（核 3，空洞 1 / 2 / 4 / 7，不补边），感受野 29 帧 ≤ 环长 30，只取最后一步。训练时同一个头在 128 帧的块上滑，块内位置 ≥ 28 的输出和设备上「环里最近 30 帧」完全等价；环不满时设备用最老的一项从前面补，PC 的预测和对拍用同样的补法。
- 接触历史 = `s3b_train.history`（老师同款；还没有接触时 [2, 2, 2, 0]）。老师另有的运动量和重复帧标记没给学生（重复帧靠训练时 10% 换成上一帧来适应）。
- 没有 GRU / GELU；算子只有 Conv / Gemm / Add / Mul / ReduceMean / Concat / Flatten（int8 版另有 QDQ），AI Hub 上全部在 NPU。

### 数据与蒸馏

- 视图缓存（`s4_cache.py`）：和老师缓存同一批帧（446,961 帧：每个接触 [c−61, c] + 空闲段中间），PyAV 解码 → `s2_views.views()`（cv2 INTER_AREA，参考函数本身），uint8 HWC BGR，每帧 497,664 字节，`student/views/<rec>.u8`，共 222 GB。抽查 3 个录像 × 4 帧用 cv2.VideoCapture 重新解码，三路视图逐像素相同。
- 软标签（`s4_soft.py`）：第 k 折老师（没见过第 k 折的轮次）跑全部缓存帧；第 k 折学生只用老师 k 的软标签（训练轮上是老师 k 的样本内输出），所以学生的 OOF 仍是真 OOF。老师 k 在测试折上的输出和 `teacher_prefix/oof.npz` 一致（最大差 0.003，fp16 / 分块不同）。最终模型用 5 个老师的平均。
- 训练（`s4_train.py`）：每个头 CE（真标签，标签和掩码同 s3b_train）+ KL（老师软标签，同一掩码），权重 1 / 1 / 1 / 0.5；AdamW lr 1e−3（头 2e−3）、wd 0.02、半个 epoch 预热 + 余弦、8 epoch、bf16、批 4 块 × 128 帧，10% 帧换成上一帧；折和内部验证（训练轮的 10%）同老师，按验证集真标签损失选 epoch（各折最佳 6–7）。块的形状固定（不够的补齐，补的部分没有标签）：这台机器上 cuDNN 每遇到新形状要 30–60 s 建计划。约 2000 帧/秒，每折 43 分钟，最终模型 73 分钟，共 4.8 小时（RTX 5080 Laptop，显存约 10 GB）。

### 关 1（−10，全部 out-of-fold；`data/moveid/student/gate1/gate1.md`）

| | 前缀老师 | 学生 fp32 | 学生 int8（ONNX，CPU） | 阈值 |
|---|---|---|---|---|
| (a) 金招→红（串） | 0/554 | 0/554 | 0/554 | ≤3% ✓ |
| (b) 致命招每一下应对判对 | 5277/5418 = 97.4% | 5284/5418 = 97.5% | 5265/5418 = 97.2% | ≥90% ✓ |
| 该闪判成卸 / 该卸判成闪 / 判成没有接触 | 1.9% / 0.6% / 1.8% | 1.4% / 0.6% / 1.7% | 1.5% / 0.7% / 2.0% | – |
| (c) 接触时间误差 中位 / 75 / 90 分位（7982 个接触） | 3 / 5 / 9 | 2 / 4 / 8 | 2 / 4 / 9 | – |
| (c) ±3 帧内 | 62.5% | 74.0% | 71.8% | – |
| (c) 致命招：中位 / 75 / 90 分位，±3 帧内 | 2 / 5 / 8，65.0% | 2 / 3 / 6，77.6% | 2 / 3 / 7，75.6% | – |

- 学生 fp32 = PyTorch fp32 推理；导出的 ONNX fp32 跑出来逐项一致（(b) 同为 5284/5418）。曲线 −16..−4：(b) 在 96.6%–97.7% 之间（老师 96.4%–97.5%）。
- 学生的接触时间比老师好（±3 帧内 62.5% → 74.0%）：学生直接看像素、端到端训练，老师的 DINOv3 特征是冻结的。
- int8 = `s4_eval.py`：每折的 int8 ONNX（只用该折训练轮校准）在 onnxruntime CPU 上按设备的方式跑（批 1、每帧三个骨干、头吃 30 帧环）。校准是「挑过的」（见量化一节）；不挑时 5 折 (b) 96.8%、判成没有接触 2.3%、±3 帧内 69.6%（`int8_naive/`）。int8 和 ONNX fp32 在全部 OOF 行（247,442 行 = 接触 × 31 帧）上 argmax 一致：前缀组 96.1%、颜色 99.75%、应对 98.7%、接触时间 58.6%；概率平均绝对差 0.001 / 0.003 / 0.012 / 0.003，个别帧最大差 0.9（应对头翻转的那些帧）。曲线 −16..−4：(b) 在 96.3%–97.4% 之间。

### 量化（`s4_export.py`）

- onnxruntime `quantize_static` QDQ：S8 逐通道权重、U8 激活、MinMax，256 张真实帧（骨干）/ 256 个真实 30 帧环（头：fp32 骨干在连续真实帧上的特征 + 接触历史）校准。
- 挑校准：同一模型换 4 组随机校准帧（种子 0–3）各量化一次，在另外 40 段 × 60 帧的真实连续帧（训练轮，不用标签）上跑完整 int8 流水线，和 fp32 比应对头 argmax 一致率，取最高的。候选之间差得不小（第 2 折 0.907–0.958，最终模型 0.961–0.975）。第 2 折：不挑时 (b) 95.8%、(c) 90 分位 18 帧，挑后 96.5% / 12 帧（fp32 98.2% / 7）。
- 最终模型选中种子 1：挑选集上 int8 和 fp32 的 前缀组 / 颜色 / 应对 / 接触时间 argmax 一致 94.0% / 99.8% / 97.5% / 59.5%（接触时间分布平，argmax 不稳，点估计用中位数）。
- **MobileNetV3-S 量化不了**：最先用的是 timm `mobilenetv3_small_050`（顺序 1 测速表里的候选），fp32 第 0 折 (b) 96.9%，int8 PTQ 后 (b) 63.8%、该闪判成卸 46.7%（`student/mnv3_run/`）。逐层看是 stem / HardSwish 之后的激活长尾，按张量的 U8 激活一量化就塌；MinMax / Percentile / Entropy 都不行，torch FX 假量化的 PTQ 也一样（特征相关 0.2–0.4）。换 ReLU 系的 MobileNetV4-conv-S 0.5 后 PTQ 正常，Pad 上还更快、训练也更快。
- **不要用 Percentile 校准**：MobileNetV4 第 0 折试过 99.99 分位，(c) 好一点，但金招判成红 5/108 = 4.6%（不过关）：金光本身就是激活里的最大值，被截掉了。MinMax 金→红为 0。
- QNN 版（`*.qnn.onnx`）= fp32 图（HTP 按 fp16 跑），输入输出和 CPU 版一样。int8 QDQ 版 AI Hub 也能编（下表），Pad 上没试。

### AI Hub（Samsung Galaxy S25 Family = 骁龙 8 Elite SM8750，和 Pad 的 SM8750P 同为 HTP V79；qnn_dlc；只上传了 6 个模型 ONNX）

| 模型 | fp32 p50 | int8 p50 | 层 |
|---|---|---|---|
| glob 384×240 | 0.292 ms | 0.175 ms | 全部 NPU |
| crop 192 | 0.155 ms | 0.144 ms | 全部 NPU |
| head | 0.067 ms | 0.060 ms | 全部 NPU |

一帧（glob + 2 × crop + head）fp32 约 0.67 ms、int8 约 0.52 ms；首次加载 0.2–0.3 s。结果在 `data/moveid/student/aihub/aihub_*.json`。

### Pad 对拍与测速（`s4_pad.py` / `s4_pad_skill.js`，原始数据 `data/moveid/student/pad/20261025-041928/`）

临时 skill `skills/dufu2_pair.js` 只调 `screenshot()` / `saveImage()` / `infer()`，不碰触摸、按键；模型临时放 `model/dufu2_pair/`，只推这两处，跑完删除并同步（App 上 `left_on_app: []`），截图下载后在 App 上逐个 DELETE。每次 skill 运行 20 帧（环从空开始，PC 用同样的前补），12 次 = 240 帧，cpu、qnn 各一遍。当时 Pad 前台是 MaaLow 自己的首页（游戏没开；119 张不同画面），不是战斗画面。

| | cpu（int8 `*.onnx`） | qnn（`*.qnn.onnx`，fp32 → HTP fp16） |
|---|---|---|
| 预处理（设备 vs PC `s2_views`，240 帧 × 三路） | 逐像素相同（最大差 0） | 逐像素相同 |
| 骨干特征最大绝对差 | 0（位级一致） | 0.0002 / 0.0014 / 0.0006（glob / big / small；特征幅度约 0.2–0.3） |
| 头 logits 最大绝对差 | 0 | 0.061（头单独喂设备特征：0.015） |
| argmax 一致（组 / 颜色 / 应对 / 接触时间） | 各 240/240 | 各 240/240；概率最大差 0.0014 |
| 环长度、环求和（设备 vs PC） | 240/240，求和差 0 | 同左 |

每帧耗时（ms；pipeline = 四次 infer 的 `ms.total` 之和，含裁剪缩放；墙钟含 `screenshot()`，`Date.now()` 只有整毫秒；预热 30 帧后 300 帧）：

| 配置 | pipeline p50 / p95 | 其中预处理 / onnxruntime run（p50） | 墙钟（含截图）p50 / p95 |
|---|---|---|---|
| cpu 1 线程 | **7.54 / 7.93** | 3.16 / 4.17 | 9 / 10 |
| cpu 2 线程 | 9.19 / 9.43 | 3.28 / 5.67 | 10 / 11 |
| qnn | 9.95 / 10.51 | 7.08 / 2.50 | 11 / 12 |

- cpu 单线程分项 p50：glob 3.79（run 2.18）、big 1.81（0.93）、small 1.52（0.90）、head 0.40（0.15）。App 里的裁剪缩放占 40%。
- 同一流水线换 MobileNetV3-S 0.5 是 9.06 ms、MobileNetV2 0.5 是 10.65 ms（随机权重，同一天、同样没开游戏）。
- 游戏没在前台；实战时游戏抢 CPU 会更慢（顺序 1 测过同一模型两次能差 1.5 倍），p95 要在实战里再量。
- qnn 的 run 只有 2.5 ms，但预处理计时 7.1 ms（同样的裁剪缩放，cpu 路径 3.2 ms；带 `input: true` 的对拍模式里反而只有 4.3 ms），是 App 侧 qnn 路径的问题，见下。

### 要 App 侧改的（这次没改 Kotlin / C++）

1. **预处理慢**：`nn_jni.cpp` 的 `prep()` 每个输出像素逐个累加 tap（整屏 → 384×240 约 1.6 ms，两个裁剪约 1.5 ms），每帧 3.2 ms。改成可分离（先横后竖、行缓存）或 NEON，同时保持和 cv2 INTER_AREA 逐像素一致（现在一致，对拍 0 差）。
2. **qnn 路径的预处理计时翻倍**（同样的 roi / size，qnn 7.1 ms 对 cpu 3.2 ms）：查一下 qnn 会话的输入拷贝 / 转换是不是算进了 prep，或有额外同步。
3. **一次调用多个 roi**（可选）：三路视图现在要三次 `infer()`。加 `rois`（几个区域按通道或 batch 叠）或「一张图跑几个模型」的调用，能省 JNI 往返和整图的重复访问。
4. **环的 aux 不能为空**（可选）：`history` 要求 aux 非空，裁剪环只好塞一个 0（头里丢掉）。
5. dufu2.js 自己要做的：每个 30 fps 帧追加一次环（训练帧距 33.3 ms；不重复追加、不跳帧）、接触历史 4 维（血条 / 真气台阶，延迟 6 帧，定义同 `s3b_train.history`）、开局 `reset: true`。

### 产出

| 路径 | 内容 |
|---|---|
| `workspaces/WhereWindsMeet/model/dufu2/` | `{glob,crop,head}.onnx`（int8，CPU 版）、`*.qnn.onnx`（QNN 版）、`*_fp32.onnx`、`dufu2.json`（输入输出、infer 参数、预处理、标签、版本、校准、导出检查） |
| `data/moveid/student/views/` | 视图缓存 222 GB（重训才需要）+ `status.json` |
| `data/moveid/student/soft/` | 每折老师软标签 |
| `data/moveid/student/fold<k>.pt`、`final.pt`、`log.json`、`train_log.txt` | 权重、逐 epoch 记录 |
| `data/moveid/student/oof.npz`、`oof_onnx_{fp32,int8}.npz`（及每折） | OOF（s3b_gate1 格式） |
| `data/moveid/student/gate1/` | `gate1.json` / `gate1.md`（s3b_gate1 原样输出）、`summary.json` |
| `data/moveid/student/onnx/fold<k>/` | 每折导出（OOF int8 用） |
| `data/moveid/student/int8_naive/` | 不挑校准时的 int8 OOF（对照） |
| `data/moveid/student/pad/<时间>/` | 对拍原始数据：`pair_{cpu,qnn}.json`（设备预处理 base64、特征、logits、耗时）、`png/`、`time_*.json`、`compare.json`、`timing.json`、`meta.json` |
| `data/moveid/student/aihub/` | 上传的 6 个 ONNX + manifest + `aihub_*.json` |
| `data/moveid/student/mnv3_run/`、`mnv4_try/` | MobileNetV3 版和 MobileNetV4 两轮试训（量化结论的证据） |

### 存疑

- 对拍画面是 MaaLow 首页，不是游戏；预处理和 int8 推理在这些画面上和 PC 位级一致，游戏画面没在设备上验证（OOF 是 PC 在录像帧上算的）。
- 测速时游戏不在前台；实战 CPU 争用下的 p50 / p95 要在关 2 的影子模式里量。
- 接触历史在训练和评估里用 trace 对齐后的真实接触（延迟 6 帧）；实机靠血条 / 真气台阶检测，只会更差。
- 视图缓存只有老师缓存的那 61% 的帧（接触前后和空闲段中间），长时间空闲、走路、过场等没覆盖，设备上这些画面的误报率不知道。
- int8 的接触时间比 fp32 差（见上表），应对基本不受影响；要更准的接触时间可以走 QNN（fp16，和 fp32 差 0.001 级）。

## 顺序 5：影子模式与关 2（2026-10-25，`s5_*.py`，`skills/dufu2.js`）

```
D=workspaces/WhereWindsMeet/tools/dufu_moveid
uv run --no-project --with numpy python $D/s5_movetable.py [--live]    # 招式表 -> model/dufu2/movetable.json + skills/lib/dufu2-table.js
uv run python workspaces/WhereWindsMeet/tools/dufu_rounds.py data/moveid/live --n 8 --skill dufu2 --ms 600000 \
    --skill-args '{"mode":"defend","provider":"qnn","dodgeLead":5}'   # 影子：{"mode":"shadow", "pair":150}
uv run --with opencv-python-headless python $D/s5_pull.py [--delete]  # 录像 -> data/moveid/live/video、bars、对拍截图；--delete 只删这些轮次的录像
uv run --no-project --with torch --with torchvision --with opencv-python-headless --with numpy \
    --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match python $D/s5_color.py   # 每帧光色（顺序 2 的分类器，全帧）
uv run --no-project --with numpy --with onnxruntime --with opencv-python-headless python $D/s5_pair.py data/moveid/live/rNNN  # 游戏画面对拍
uv run --no-project --with numpy python $D/s5_analyze.py [rNNN ...]    # 接触检测、决策时刻、空闲误报、关 2 -> live/analysis.json
```

**dufu2.js**（不依赖 dufu.js，只用 `lib/dufu-reads.js` 的血条 / 真气读法）：每个 30 fps 节拍一次截图 → glob / 大框 / 小框三次 infer 各追加一次环 → head 读环；截到的还是上一帧也照样追加，循环超时就用同一张截图补齐漏掉的节拍（最多 3 个，再多跳过并计数），开局 `reset`。接触历史按 `s3b_train.history`：挨打 = 血一次掉 ≥2.5%（hpBase 读法），接触 = 看到的时刻 − 5 帧；卸势成功 = 真气台阶 8–80 px 且 24 帧内按过卸势；接触满 6 帧才进历史。`mode` shadow（只在开局前推摇杆走近，boss 不动就永远不来；之后不发任何触摸，每帧把防守会按什么写进 trace）/ defend（走近、补锁定、卸势 / 闪避、喝药，不进攻）。按键：应对头判闪或招式表标「不可卸」→ 闪，P(金) ≥0.15 → 闪，否则卸；预测接触（截图时刻 + 接触时间头中位数）离现在 ≤ 提前量就按；卸势 330 ms 锁 / 220 ms 冷却，闪避 500 ms，同一接触只按一次。trace 每帧一行（`TRACE_COLS`，150 行一个事件），`pair: N` 每 N 帧存截图 + `input: true` 的视图 + 环 + logits。boss 条改为数红色像素（lib 的 `bossPx` 在阶段二场地读到背景红 283 px，开局就停止走近、10 秒后误判死亡）。

**招式表**（`s5_movetable.py`）：卸势提前量 = 每个接触前最后一次生效的卸势（330 ms 锁内的不算）的 ok 率–提前量曲线，4934 个接触，7–11 帧 .77–.79、13 帧起掉到 .66 以下，全局 10 帧；样本 ≥40 且组内更好的 10 组用组内值。闪避提前量：闪开的招不留接触，数据里只有失败的闪避，表里先放 14 帧，实机按 14 / 8 / 5 试过，5 最好（见下），用 `dodgeLead` 参数。`--live`：实机关 2 里卸势成功率 <20%（≥10 次）的「卸」组改成不可卸（k0–k4:c7，火球雨）。

**影子（r002–r006，5 局）**：
- 每帧耗时（战斗中，p50 / p95，ms）：cpu 推理 15.2–18.4 / 23.7–26.2（预处理 4.4–5.1，run 10–12），qnn 13.2 / 16.6–18.7（预处理 8.2–8.3，run 3.9–4.1）；整轮循环 22–24 / 41–42（含截图 2、血条 / 真气读数 4–7、结束判定）。新 App 的 cpu 预处理在战斗里 4.5 ms 左右（旧包同样游戏前台、登录页上 8.2），没有到 1.3；qnn 的预处理仍是 cpu 的约 2 倍（8.2 vs 4.5），膨胀没消失。
- 对拍（`s5_pair.py`）：cpu 23 帧游戏画面（14 帧场地空闲 + 9 帧战斗）三路视图、特征、logits 全部位级一致；qnn 6 帧视图一致，特征差 ≤0.0015，logits ≤0.012，四个头 argmax 全一致。对拍帧（base64 编码 ~0.7 s）不计入耗时。
- 接触检测（录像台阶对照，hit 69）：匹配 55，漏 14（都是 2.4–5.5% 的小台阶：紧跟在一下之后 7–14 帧的第二个台阶或几帧慢慢掉的，设备规则「一次掉 ≥2.5%」和训练定义一致所以训练里也没有这些），误检 3；看到时刻 = 接触 + 4 / 5 / 5 帧（p10 / p50 / p90），所以历史在接触 +6 帧进，和训练一致。
- 决策时刻（接触前 10 帧，64 个）：应对判对 62（96.9%），致命 60/60，金 3/3 判金，金判卸 0；接触时间误差中位 2、90 分位 13 帧。
- 空闲误报：走近段 1000 帧里「判有接触」4 帧（0.4%）；战斗中离接触 ≥30 / 45 帧的帧里 5.7%（抽看 r003 600–800 帧：boss 在身前出招没打中，不是空画面）。

**防守（r007–r031，25 局，qnn）**：

| 配置 | 局 | 致命招成功率（不含 / 含未核实闪避） | 金招按成卸势 | 挨打/分 | 中位存活 | 按键/分 |
|---|---|---|---|---|---|---|
| A 闪避提前 14（表默认） | 5 | 245/379 = 64.6% / 66.0% | 0/45 | 8.75 | 207 s | 34 |
| B 闪避提前 8 | 8 | 485/683 = 71.0% / 71.6% | 1/65 | 6.82 | 249 s | 34 |
| C 闪避提前 5 | 4 | 246/338 = 72.8% / 72.9% | 0/34 | 6.16 | 267 s | 34 |
| **D 闪避 5 + 实机修正的招式表（c7 改闪）** | 8 | **655/861 = 76.1% / 76.8%** | **1/96 = 1.0%** | **5.49** | **338 s** | 31 |

- 关 2：金招按成卸势 ≤3% 通过；致命招成功率 ≥90% **不过**（最终配置 D 76.1%，按局 63.8–84.7%）。旧 dufu.js 阶段二基线：约 10 挨打/分、存活约 150 s；同口径（只算接触，闪避看不到）致命接触卸住率 45.9%（197 轮 index）。
- D 的失败归因（致命，206 下）：不可行动 85（前一下 20 帧内刚挨过 / 喝药中，多为连段后续）、没认出 39（接触前 25 帧没按）、时机偏 38、认对按对仍挨打 36、认错应对 8。
- 按组：k0:c7 / k1–k3:c7（火球雨，boss 在台阶上远程齐射）改成闪避后仍只有 0–15%，占 D 失败的 78 下；k2 无光近身组 57%；k0 无光大组 85.5%、k1 90%；k0:c8、k0:c5 等红光招 100%。
- 产出：`data/moveid/live/rNNN/`（result、trace、args、events、contacts.json、对拍 png / pair.json）、`live/video|bars|meta|color/`、`analysis.json`（全部轮次，最新表）、`gate2_<配置>.txt`、`movetable_v1.json`（修正前的表）、`deleted.json`（Pad 上已删的本轮录像）。r001 是没走近的空场地 55 秒（手动停，没有 result，只用于对拍）；r012 之后一局因 PC 侧批处理被超时杀掉，手动停下，录像 20261025-102914 已删、未计入。

### 存疑
- 关 2 的分母把「闪避后 25 帧内没有接触」算作闪开：金光核实的计入，没核实的（无光招）两种口径都给了，差 0.7 个百分点。
- 「不可行动」是 20 帧内连续挨打的统称，包括 boss 连段后续和受击硬直，没有逐帧核实角色能不能动。
- 关 2 的「认错应对」用的是当前（修正后）的招式表，A–C 配置里 c7 被算成「该闪」。
- 火球雨（c7）单次闪避躲不开，需要位移规则（跑开 / 侧移），不在应对头和招式表能表达的范围里；这是到 90% 的最大缺口之一。

## 顺序 5 续：关 2 专攻（2026-10-25，`s5_ab.py` / `s5_episodes.py` / `s5_retrain.py` / `s5_push.py`）

老师新规则（2026-10-25）：火球雨先跑再闪；金光火球一个一个放、持续时间长的只能闪；红光卸势、金光闪避、金光绝不卸不变。

```
D=workspaces/WhereWindsMeet/tools/dufu_moveid
uv run python $D/s5_push.py [--model]                                   # 只推 dufu2.js / 招式表（--model：model/dufu2、dufu2b），先查 Pad 空闲
uv run python workspaces/WhereWindsMeet/tools/dufu_rounds.py data/moveid/live --n 5 --skill dufu2 --ms 1050000 \
    --skill-args '{"mode":"defend","provider":"qnn"}' [--alt '[{...},{...}]']      # 现在的默认就是最终配置
uv run --no-project --with numpy python $D/s5_ab.py rNNN ... --by run,goldSeq [--out live/abN.json]   # 按参数分组的关 2（口径不变）+ 火球雨口径
uv run --no-project --with numpy --with opencv-python-headless python $D/s5_episodes.py rNNN ... [-v]  # 火球雨段 / 金光火球窗逐段挨打
TORCH="uv run --no-project --with torch --with timm --with numpy --with av --with opencv-python-headless --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match"
$TORCH python $D/s5_retrain.py cache r003 ... ; $TORCH python $D/s5_retrain.py train --base final --tag live_a --live ... --val ...
$TORCH python $D/s5_retrain.py eval --val r026 ... --models final,live_a ; s4_export.py --tag live_a --out workspaces/WhereWindsMeet/model/dufu2b
```

### dufu2.js 的改动（参数都能关，默认 = 最终配置）

- **跑（`run`，默认开，`runDir` 默认 `diag`）**：头连续 2 帧给火球雨组（k0–k4:c7，招式表里不可卸的那几组）的概率和 ≥0.5、预测接触 ≤45 帧，就把摇杆推满（contact 0）朝一个方向跑：`side` 左右横移、`diag` 斜后方、`back` 正后方，左右每次交替。至少跑 4.3 s，头 600 ms 不再报火球雨才停（最长 5.5 s）。跑的时候闪避朝跑的方向、摇杆不松；跑的时候不喝药。时间依据：r020–r031 火球雨组起手后第一波落在 +33..+76 帧、第二波 +90..+125 帧；最早 1.5 s 的版本（r032–r035）跑完就挨。
- **金光火球窗（`goldSeq`，默认开）**：c11（金光火焰旋风 → 火球一个一个放）。原来的问题：开场金光闪开后没有接触进历史，学生把前缀从头认，后面的火球认成无光近身大组（k0 / k1 / k2）去卸势，r007–r031 每次闪开开场后都吃 2–3 个火球。现在头认出 k0:c11+c40 时按下的闪避（锚 = 按键时刻）或挨的一下（锚 = 接触），开一个 150 帧的窗：窗里一律闪；另外按节拍 +27·k 帧（k = 1..5）各补一个闪避（已经为它闪过就不补）。节拍依据：r007–r035 闪开开场后挨的火球全落在按键后 +27 / +54 / +81 / +108 / +135（±3）帧上，哪几个打中因局而异。第一版（r038–r043：只在 +22 帧补一下，其余靠头的预测改闪）没用，头对这些火球预测得晚或不报。
- **模型（`model`，默认 `dufu2b`）**：在实机局上微调的学生（下面「重训」）；`dufu2` 是顺序 4 的学生。
- **闪避提前量** 默认 5 帧（D 配置的 `dodgeLead`）。
- **k2:c30 节拍补卸势（`chain`，默认关）**：c30 第三下固定在第二下后 34 ± 1 帧，接触时间头不报。两个设备接触相隔 40–58 帧且头报 k2:c30 时，在第二下 + 34 帧按卸势（已经按过就不补）。A/B 见下表，默认关的原因见「最终配置」。

试过、丢掉的（代码已删，A/B 见下表）：

- **节拍兜底（`beats`）**：头认出组以后、接触时间头不报的组（k0:c27 远处跳砸：起手 → 接触 24.6 帧，IQR 2.5），按起手 + 24.6 帧补按应对。`s5_movetable.py --beats` 能算。
- **实机重拟卸势提前量（`liveLeads`）**：用 dufu2 自己的卸势和结果，各组实际提前量（接触 − 最后一次卸势）对 ok 率的曲线（7–12 帧 96–98%，≤4 帧 ≤88%）定每组的整体平移：k1 大组 10→12、k2 大组 5→10、k5:c7 5→10。`s5_movetable.py --live-shift` 能算（写进 `parry_lead_live`，现在没人用）。

### 关 2 口径和火球雨的核实

- **关 2**：`s5_analyze.gate2` 不变（致命招每一下没掉血 / 总数；闪避后 25 帧内没有接触算闪开，没核实的另算）。`s5_ab.py` 只是按参数分组调用它。
- **跑开的火球不留接触**，接触口径看不见跑躲掉了几个火球（分母也跟着变小）。另给一个**火球雨口径**（`s5_ab.c7volley`）：每个火球雨段（`s5_episodes`：头连续 2 帧报 k0–k4:c7，段间 ≥150 帧，跑不跑同一规则）记 K = 5 下（D 配置里没人跑时一段火球雨的接触数中位数），失败 = 段起点后 130 帧内录像血条台阶数（最多 K），段内的接触从普通口径里拿掉。两种口径每组都报。
- **录像核实**：挨没挨打用录像血条台阶（不是设备读数）；火球有没有放出来、落在哪，抽了干净段逐帧看（`data/tmp/c7/r065_clean.jpg`：1106–1130 帧火球飞出、角色斜后跑开、火球落在身后，接着 boss 跳下的那下被卸住；`r034_run.jpg`、`r037_run.jpg` 同样，跑完后挨的是 boss 跳下来那一下）。像素自动判火球（红橙亮斑面积 / 连通块）试过，场地本身是红的、其他招也有火花，分不开，没用。

### A/B（关 2 口径，不含 / 含未核实闪避；每组局数）

| 改动 | 局 | 新 | 旧 | 结论 |
|---|---|---|---|---|
| 跑（试跑 r032–r035，短跑，不交替） | 4 / 8 | 340/412 = 82.5% | D 655/861 = 76.1% | 继续 |
| 跑（r036–r051 两个 2×2 合并，跑 vs 不跑） | 8 / 8 | 910/1054 = **86.3%** | 750/953 = 78.7% | **保留**；不可行动 15 vs 81 |
| 金光火球窗 v1（r036–r043） | 4 / 4 | 402/488 = 82.4% | 388/481 = 80.7% | 改成节拍版 |
| 金光火球窗 v2（r044–r051） | 4 / 4 | 518/599 = **86.5%** | 352/439 = 80.2% | **保留**；逐窗：开 76 窗 12 下（68 窗干净），关 27 窗 81 下（0 窗干净） |
| 模型 dufu2b（r054–r071，2×2×2） | 8 / 7 | 1079/1202 = **89.8%** | 659/765 = 86.1% | **保留** |
| 节拍兜底 beats（同上） | 8 / 7 | 980/1118 = 87.7% | 758/849 = 89.3% | 丢掉（时机偏 37 vs 17） |
| 实机卸势提前量 liveLeads（同上） | 7 / 8 | 858/972 = 88.3% | 880/995 = 88.4% | 丢掉（没差别） |
| k2:c30 节拍补卸势 chain（r088–r099，最终配置上） | 6 / 6 | 1029/1152 = 89.3% | 1014/1132 = 89.6% | 留在代码里、默认关（见下） |

- 每局的跑法（`s5_episodes`，r036–r076 跑过的段）：`diag` 97 段挨 93 下（0.96 / 段），`side` 29 段 44 下（1.5 / 段）；不跑（D + 不跑的局）73 段 221 下（3.0 / 段）。r064 起只用 `diag`。
- r052–r053、r062–r063 是 dufu2b 的影子对拍局；r067 是上一局到时没死、下一局接着打时开局 1 秒误判死亡的空局（0 接触），没计入。r056 进场前游戏自己重启（更新资源包），用教过的 `LaunchAndLogin` 回到演练场，接着跑。

### 重训（`s5_retrain.py`，从 `final.pt` 微调，不冻结）

- **数据**：实机 r003–r025（影子 4 局 + 防守 19 局）训练，r026–r031 留出验证；原来 197 局照旧参加（老师软标签）。实机帧 = `frame_plan`（接触前 61 帧 + 空闲段中间），127k 帧缓存在 `student/views/`。
- **标签**：接触时间 = 录像真值接触；颜色 = `s5_color`；前缀组 = 设备在决策时刻认出的组（自训练，软标签 = 模型自己）；应对 = 金光 / 招式表不可卸 / 火球雨组 / 金光火球窗 → 闪，其余卸。闪开或跑开（没有接触）的前后 [−45, +25] 帧和整段跑全部不计标签，免得把「闪开了」学成「没有招」。
- **训练**：lr 3e-4、2 epoch、实机局每 epoch 过 2 遍，约 21 分钟。
- **留出实机局（r026–r031，fp32）**：决策时刻应对判对 82.5% → **92.1%**；挨打的那些接触前 3–12 帧里满足按键条件（中位接触时间 ≤15 且 P(无) ≤0.6）的比例 75.6% → **86.7%**（全部接触 93.2% → 96.0%）；空闲帧误报 2.0% → 2.0%；接触时间误差中位 2 → 1 帧、90 分位 7 → 7。
- **原数据一折不退化**（从 `fold2.pt` 同样微调，第 2 折测试轮 OOF，`s4_gate.py --folds 2`）：(a) 金招判红 0/107 → 0/107；(b) 致命招应对判对 98.2% → 97.2%（≥90%）；该闪判成卸 1.7% → 3.0%；接触时间 ±3 帧内 74.9% → 77.4%。
- **量化 / 导出**（`s4_export.py --tag live_a --out model/dufu2b`）：校准挑种子 1，int8 和 fp32 应对 argmax 一致 97.2%（原 final 97.5%）。
- **Pad 对拍**（游戏画面，影子局 r062 qnn / r063 cpu，`s5_pair.py` 按局的 `model` 读模型）：cpu 7 帧视图、特征、logits 位级一致；qnn 4 帧视图一致、特征差 ≤0.0018、logits ≤0.012，四个头 argmax 全一致。

### 不可行动、喝药

- **挨打硬直里按键没用**：D 配置 8 局 93 下「不可行动」，71 下离上一下 ≤10 帧；36 下在上一下之后、这一下之前按过键（闪 25、卸 11），照样挨。逐帧看 r024 2124–2160（火球雨，2130 / 2141 按了闪避，连吃 5 下）、r028 2257（倒地时闪避图标亮了，2259 照样挨）：硬直 / 倒地里游戏不接受卸势和闪避，也没有受身。
- **从源头减**：不可行动主要是火球雨的连发（D：85 下里 71 下在 c7 组）。跑之后 8 对 8：15 vs 81 下。
- **喝药**：逻辑没改（30 帧内接触概率 <0.3 才喝）。喝药中挨打：D 50 次按药 12 次，新局（r036–r076）45 次 6 次。

### 最终配置（r072–r087，16 局，默认参数 = 模型 dufu2b + 闪避提前 5 + 斜后跑 + 金光火球窗，qnn，`ms` 1050000）

| 项 | D（r024–r031，8 局） | 最终（16 局） |
|---|---|---|
| 致命招成功率（不含未核实闪避） | 655/861 = 76.1% | 2821/3133 = **90.0%**（按局 84.0–92.9%） |
| 含未核实闪避 | 76.8% | 3134/3446 = 91.0% |
| 火球雨口径（`s5_ab.c7volley`） | 78.8% | 3356/3677 = 91.3%（155 段挨 105 下） |
| 金招按成卸势 | 1/96 = 1.0% | 3/462 = **0.6%** |
| 挨打/分 | 5.49 | 2.18 |
| 存活（中位） | 338 s | 769 s（510–1010 s；r037 起常有活满 10 分钟的局，所以最终配置放到 17.5 分钟） |
| 决策时刻应对判对（全部 / 致命） | 86.1% / 681/786 | 94.5% / 2635/2726 |
| 接触时间误差 中位 / 90 分位 | 1.7 / 7.5 帧 | 1.2 / 6.7 帧 |
| 按键/分 | 31 | 31.9 |

- **关 2 判定**：致命招成功率 90.04%（≥90%，刚过线；16 局按局 84.0–92.9%，按局等权平均 89.8%）、金招按成卸势 0.6%（≤3%）。两条都过，但第一条没有余量。
- **失败归因（致命，D 206 下 / 861 → 最终 312 下 / 3133，括号里是占致命攻击的比例）**：不可行动 85（9.9%）→ 44（1.4%）；没认出 39（4.5%）→ 96（3.1%）；时机偏 38（4.4%）→ 97（3.1%）；认对按对仍挨打 36（4.2%）→ 48（1.5%）；认错应对 8（0.9%）→ 27（0.9%）。
- **按组的剩余缺口**（最终 16 局，致命挨打）：k0 无光大组 71（时机偏 26、没认出 21、认错 12）、**k2:c30 69（没认出 52）**、k2 无光组 42（时机偏 28，卸势按晚：实际提前量 ≤3 帧）、k1 无光组 34（认对按对仍挨打 23）、k0:c27 22（没认出 15）、火球雨各段合计 48、金光火球窗 10。
- **k2:c30**：第三下总在第二下后 34 ± 1 帧（第二下在第一下后约 49 帧），头认得出组但接触时间头不报（52 下里没按键）。按这个节奏补卸势的 `chain`（`args.chain`，默认关）：两个设备接触相隔 40–58 帧、头报 k2:c30，就在第二下 + 34 帧前 10 帧按卸势。
- **chain 的 A/B（6 对 6）**：k2:c30 本身 25/25 vs 2/26，补按后 3–40 帧内没有任何挨打（37 次补按），没看到副作用；但整体关 2 是 89.3% vs 89.6%，别的组（k0 无光大组 35 vs 25 下、c27 15 vs 9）在开的那组恰好多挨，轮间方差把 k2:c30 的约 2 个百分点盖住了。按「关 2 口径看不出就不保留」的规则默认关，要不要开留给人定。
- **最终配置合计 22 局**（r072–r087 + chain A/B 里关的 6 局，同一配置）：3835/4265 = **89.9%**（含未核实 90.9%），金招按成卸势 5/650 = 0.8%，2.16 挨打/分（`ab_final22.json`）。16 局的 90.04% 是在线上，加上后 6 局是 89.9%：**关 2 第一条在 90% 上下，不能算稳过**。
- 产出：`data/moveid/live/gate2_final16.txt`（s5_analyze 原样输出）、`ab_final16.json`、`ab_final22.json`、`gate2_ab5_chain.txt`、`ab5.json`；A/B 各批 `ab1.json`、`ab2.json`、`ab3.json`、`ab4.json`、`ab34.json`；批处理日志 `batch5.log`–`batch13_final.log`。

### 存疑

- **关 2 第一条没有余量**：16 局 90.04%，22 局 89.9%，按局 84–93%。要稳过还得再砍掉约 1–2 个百分点的失败：k2:c30（chain 能去掉，整体 A/B 没显出来）、k0 无光大组、k2 无光组卸势按晚、c27 跳砸。
- **火球雨口径的 K = 5** 是 D 配置不跑时一段的接触数中位数；段的识别靠头（连续 2 帧报火球雨组），段内有些其实是 boss 跳下来那一下（跑完之后挨的大多是它）。录像里火球的落点靠人看（抽了 4 段），没有自动判法。
- **金光火球窗 v2 只有 4 对 4 局**（少于 6 对 6），按窗统计差别很大（76 窗挨 12 下 vs 27 窗挨 81 下），之后所有局都开着它。
- **跑的方向**是在 A/B 局里顺带比的（每局 side / diag 交替），不是单独的 A/B；r064 起只用 diag。
- **重训的前缀组标签是自训练**（设备在决策时刻认出的组），留出局的应对提升里有一部分来自新加的应对标签规则（火球雨 / 金光火球窗一律闪），这部分和 dufu2.js 的规则重复。
- **局变长以后**：活满 10 分钟的局下一局会在没打完的战斗里接着开（`dufu_enter` 认出还在演练场就返回），r067 就是这样开局 1 秒误判死亡；最终配置把 `ms` 放到 17.5 分钟（录像上限 20 分钟），16 局都是死亡结束。
- 喝药逻辑没改（喝药中挨打 24% → 13%，是别的改动带来的）。
