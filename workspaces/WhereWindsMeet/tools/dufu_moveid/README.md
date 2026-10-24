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
