# 独夫统一模型交付笔记（v1、v4–v9）

交付笔记，当前默认参数见 README 与 `dufu.js`。

## 独夫统一模型（2026-10-14，分支 dufu-unified，先只防守）

每个 Boss 一个统一模型 + 一个按键调度器，替代 ttc2 + flare3 + sweep + 巫刀一堆分头模型和散在 combat.js 里的规则。离线工作在 `data/tmp/dufu_ml/unified/`（DESIGN.md 冻结接口、report.md 验收#1、model_back/head/head2_report.md、replay_report.md）。

* **输入**：96×96 彩色宽裁剪（x120–960、y30–560，840×530 → INTER_AREA），MobileNetV3-Small 每帧出 192 维特征（p50 4 ms）；保留 30 帧（约 1 秒）特征环，加 15 维 aux（真实 dt、按键/成功年龄、hp/真气/boss 血/发光/暗场/金光/bar），因果 GRU（128）出 77 维多头：连招类别 16（14 模板+irregular+bg）、阶段 6、未来第 1/2/3 击时间分布 3×11、防守类型 3×5、预兆 7。头 p50 8 ms（含 6k 浮点 JSON）。App 的 `infer()` 加了 `extra`（额外 float32 输入张量，`nn_jni` 的 `nnRunExtra`），旧模型不受影响。
* **数据/标签**（全自动）：150–216 轮 665,674 帧（370 分钟）；接触点 = 掉血帧 − 5（伤害数字提前 5 帧）或真气台阶（`anchors.qi_drops`）；掉闪也算不上接触（闪避成功确定不了打中时刻），带闪避的间隔内外分开标、fut/def 头降权 0.3；死亡/幕布帧屏蔽；连招按 (段数, 间隔 bin) 聚成 14 个模板（T13 不稳只当"长连"），留轮交叉 2 段 100%、3 段 74% 在 ±5 帧内，自举漂移 ≤2 帧；阶段/距离/前一下结果都不实质改模板节奏（验收#1 过）。
* **训练**：按整轮分 train 47 / val 8 / test 12；先训骨干单帧多头（加片段一致的缩放/平移/亮度增强），再冻骨干训 GRU 头；v2 解冻骨干后两段端到端微调。test 同预算（每 2 帧看一眼、12 帧 refractory、配平 40/55 次每分）：cov3–14 **70.0% / 83.8%**、cov8–14 **45.6% / 57.0%**；tape ttc2 同轮 59.5%/71.4% 与 44.2%/48.9%。@55 的 cov8–14 领先 +8.1pt（配对 t=2.85）。
* **`dufu.js` 调度器**（参数都带默认，可 A/B）：每帧骨干+头两次 infer；时间头 S1（fut1 的 4–19 帧档）≥ `trigTh` 0.4 才动，防守头只在 parry/dodge/curtain 里选型（unknown/curtain 误读按 parry）；按预测命中 −(9 目标提前+5 实测延迟) 帧下发 ms 时间戳按键；识别起手即预排 k1–k3（不等第一击成败）；未下发（>90 ms）的计划逐帧修正；双峰分布留分支（后峰在首峰 +3 帧后仍 ≥0.25 才执行）；受击清计划+硬直；一条闪避 dedup 2500ms；落空/被挡/晚都有计数。`observe` 模式只推断+模拟按键不出手；开局无 boss 条时自动小步进场；死亡检测按「再次训练」按钮（≥800 白像素 2 次）或连续 3 秒灰屏。
* **实机 6 轮（217–223，绝境·浴血·阶段一，3 瓶药）**：战斗内挨打 7.6–15.6 下/分（中位约 10.8；单轮波动大，旧 ttc2 基线 7–8）。离线复现实机逐帧 = 模型实机输出（def1 一致 88–94%、tell 98%），**不是管线问题**：hit 类接触只有 52–79% 在接触前 19–3 帧有 S1≥0.4（ok 类 100%），加上连段硬直链（19–24 s 内 3 连击等）与早期死亡检测缺陷（死在画面里技能还在空转，已修）。
* **下一步**：把实机轮次纳入训练（尤其 hit 类、阶段二和死亡/终局画面掩码）；按固定阈值口径重报覆盖；调度器补连段处理（受击后闪出/等硬直结束）；aux 入日志并改 mean 列口径。

## 独夫统一模型 v4（2026-10-14 晚，交付 `model_head4_report.md`）

v3（exp6，`unified_{back,head}3.onnx`）的遗留两条都在 v4 处理，并在实机上做了第一轮 A/B（226–232）：

* **死亡检测加固（dufu.js）**：离线扫档发现按钮分支被白特效误触（67 个老轮里 66 轮存在至少一个检查相位会在战斗期
  触发）——给按钮分支加回 `bossNow <= 50` 守卫 +「≥1600px 强计数」兜底；灰屏路径不变。74 轮 × 187 相位零误触；
  实机实测：灰屏 2.9–3.3s 判死、按钮 1.0s（`deadGrey:false` 测试场），死亡后不再乱按。另有测试 args
  `deadGrey`、S1 窗参数 `s1Hi`（默认 5=4–19 帧；6=4–24 帧，未采用）。
* **索敌（lock-on）**：演练场开局自动锁定，阶段转换（约 80s 起）游戏掉锁、镜头不再跟 boss（233 后半段被从
  摄像机侧面打）。dufu.js 照 combat.js 的规则补锁：图标（LOCK_ROI 金色）暗即每 ≥2s 补一次 `tap`，新增 args
  `lockOn`（默认 true）。修复轮 234 三次掉锁都在 0.2–0.3s 内补回，实录挨打 13.0→9.3 下/分。
* **v4 部署对**：`unified_back4.onnx` + `unified_head4.onnx` + `unified_head4.json`（runs/exp8），io 不变
  `[1,3,96,96]→192`、`[1,30,207]→77`。args 成对切换：
  `{"model":"dufu/unified_head4.onnx","backModel":"dufu/unified_back4.onnx","trigTh":0.4,"potions":3}`。
  val cov8@40/55 = 48.8/58.8（exp6 48.2/56.1）；test 46.6/56.7（一次性）；**死亡屏输出从「吵」变「静」**：
  arm1 死亡段 S1≥0.4 91.8%→0%、def=dodge 96.5%→0%、tell flare_other 75.2%→0%。
* **v4 数据改动**：①实机轮（219–232）的 `curtain` 事件是 tell 头自报（环状污染），只保留旧图像规则的 `start`
  真值，129 个被 flag 接触清零、combos 重建；②终局帧从「只掩码」改为显式安静负样本（fut/combo/stage/def 安静
  目标、小采样权重 0.2）参与训练。
* **A/B（样本外验收 v3 vs v2，226–232）**：hit 固定阈值 19–3 全接触覆盖 v3 63.1% vs v2 45.6%、ok 100%、在环模拟
  预计挨打/分 11.9 vs 12.1（实录 13.0）；v3 通过。v4 的样本外验收要等 233 起的新轮。

## 独夫统一模型 v5（2026-10-15 凌晨，交付 `model_head5_report.md`）

v5 把实机轮滚动进训练，并给调度器补上三项 v4 遗留：受击连段、金光早闪避、连段模板预排（后两项做了离线量化与
上机 A/B）。test 只在定稿后跑一次。

* **部署对**：`unified_back5.onnx`（md5 `e27d495f3b2d31edd12918bd98987093`）+ `unified_head5.onnx`
  （`bad0cbbb8e9221fe8e281eb2e43121be`）+ `unified_head5.json`（runs/exp9，从 exp8 增量到 150–242 全部
  10 个已验收实机轮）。io 不变。args 成对：`{"model":"dufu/unified_head5.onnx","backModel":"dufu/unified_back5.onnx","trigTh":0.4,"potions":3}`。
* **金光门槛重标**：`tellDodgeP` 0.75→0.5（sustained 保留、episode 2s 不变）。离线扫描（v4 头，219–234 设计集）：
  110 个金光挨打里「有提前量 ≥4 帧的闪避」28→51、覆盖 36→76，多付 ~2.7 次闪避/分；新轮 235–242 样本外同向
  （31→55、37→69）。8 轮实机 A/B（235/238/241 vs 236/239/240）：tell 头闪避出现 11 次 vs 0 次，命中率无显著差
  （8.97 vs 8.14/分，轮间波动 ±2），暗场 tell 试过覆盖不足（+1 有效/34）未采用。
* **受击连段**：`staggerHold`（受击硬直里不丢在途计划、硬直结束还有 ≥4 帧提前量才按）离线≈0 收益（每帧重建计划已
  覆盖），上机 237/242 各按住 18/20 条、实际补按 2 次；`presched`（按冻结模板预排下一段）因 **v4/v5 combo 头根
  本认不出模板**（模板帧 argmatch 2.6–4.6%、p≥0.4 命中≈0）触发 0 次——离线/上机均确认，留 arg 待 combo 头重训。
  另量化了「受击后保险按」（sim 仅：+0.16/分收益、多 15 次按/分）未采用。
* **数据滚动**：233–242（锁修复轮 + 8 个 A/B 轮）验收通过后折入 train（train 592,752 帧、w_img 0.942）；
  val/test 不变。v4 样本外验收在这批新轮上：hit 固定阈值 19–3 全接触 84.2%（139/165）、ok 99.6%；v5 入库后
  val cov8@40/55 = 48.0/59.6、固定阈值 19–3 90.0%；test 一次性 cov8 46.8/55.9、19–3 93.2%（v4 46.6/56.7、90.6）。
* **索敌/死亡**在 8 轮里继续稳定：每轮 3 次掉锁全部 0.1–0.3s 补回；3 次死亡全走灰屏路径（184.4/169.8/163.9s，
  最后一次挨打后 5–11s）。

## 独夫统一模型 v6（2026-10-15 下午，交付 `model_head6_report.md`）

v6 把 v5 的两条遗留（combo 头认不出模板、受击后第二段计划被硬直丢掉）做完，并跑/收 247–250 四轮实机。

* **combo 槽重做**：v5 的整段模板 id 含不可见未来（模板帧 argmatch 2.6%、presched 触发 0）；v6 改成
  **「当前段到下一段的间隔 bin」**（`combo_v6.py`：0 bg / 1 单段 / 2–7 间隔 bin [8-13..34-40] / 8 链尾，只从每段
  接触后监督），combo 槽用 MLP 解码。定稿头（`unified_head6.onnx`）val：链帧 argmatch **41.2%**（原 2.6%）、
  drop 窗口 46.9%/p≥.4 命中 38.3%；离线 presched 触发 **148/181=81.8%**（原 0）；`dufu.js comboRunning` 触发率
  35.5%（有下一段的帧）。**端到端重训 combo 会拖 S1（exp10/10b/10c 都掉 @55 1–1.5pt），所以 v6 是混合式**：
  `back6` 与 `back5` 字节相同（md5 `e27d495f3b2d31edd12918bd98987093`）、防具头不动，只换 combo 槽
  （`unified_head6.onnx` md5 `a20e4d7fc9715dff7709e3bb3e8bf0d0`）。**val = v5（48.0/59.6、FT 90.0）**；
  test 一次性 46.8/55.9、19–3 93.2%。args：`{"model":"dufu/unified_head6.onnx","backModel":"dufu/unified_back6.onnx","trigTh":0.4,"potions":3,"comboV6":true}`。
* **第二段计划生命周期**（dufu.js 新 args，默认关）：`keepPlanOnHit`（受击不丢指向未来接触的未按项）+
  `staggerHold`（硬直里保留重试）+ `posthit`/`posthitNarrow`（硬直末窄化保险按）。sim（219–242）：实机没按的
  30 个 gap24-39 窗口覆盖 20/30→24/30→**29/30**；73 案例 E_bucket 15.0→11.3→7.5；全局 E 9.59→9.48/分。实机
  247/249（v5 默认）vs 248/250（修复臂）hit/min 9.7/11.0 vs 7.0/7.2（两配对同向，n 小待攒）。presched（v6 版本）
  能触发（166 条/8 轮）但 sim E≈0（fut1 已覆盖），保持默认关。`lock-c` sim 无增量未上机。
* **实机轮 247–250**：FT 19–3 合计 92.6%（53/58）、ok 100%；249 灰屏判死（+165s），其余打满；锁每轮 4–5 次补按。
  已 pull/建 ds/折入 combo 槽训练（`ds.ALL` 上界 243→251；val/test 不碰）。第一次 247 因 `ready.py` 把大世界的
  「打败独夫」任务文字误当竞技场而作废（未入库）——补了 **`skills/dufu_enter.js`**：从大世界/菜单/试炼页自动进
  独夫演练场（追踪图标→江湖行→试炼→开封皇宫→独夫→演练场→开始演练，死亡面板自动再次训练）。

## 独夫统一模型 v7（2026-10-16 凌晨，交付 `model_head7_report.md`）

v7 按老师对 252「独夫指导局」的 36 条逐帧标注修防守时机，并新增拼刀/气竭模块；模型对不变（back6/head6），
改的是调度器 + 数据 + 训练集滚动。dufu.js 新 args 全默认关：`tellAnchor`、`curtainImg`、`curtainDark`、
`repress`、`closeIn`、`qiAttack`。

* **A1 金光改 onset 锚定**：tell 头首报帧≈图像 onset（p50 0 帧）；`tellAnchor` 按 kind 锚 onset+{grab 4, slam 10,
  other 4} 帧，233–252 上「lead≥4 的金光按压覆盖」117→198（50%→85%），代价 4.6→5.8 闪避/分。
* **A2 幕布**：查实 dufu 时代（219 起）**0 条 curtain 监督标签**（去环只占 219–232 一节），tell 头在幕布黑幕
  onset 全报 `dark`（p 0.86–0.95）。用全分辨率图像规则（panels+橙边，46 轮录像）回标 97 个幕布事件、225 个
  contact flag（219–262，val/test 不碰）；运行时加 `curtainImg`（400ms 图像试探）与 `curtainDark`（tell dark
  连续 2 帧）兜底：233–252 的 54 个事件，旧 tell-curtain 只盖 29，兜底后 49（图像 52）。实机 253–262 十轮共
  image 33 次 / dark 11 次进入、扫击闪避 8 次（旧版两轮合计 1 次）。
* **A3 晚补发 `repress`**：已按项 believed 接触过去且无 ok/hit 反馈、fut 仍报接触 → 重排/固定 +12f 二次拍（252
  f4204 早 37 f 一类）。sim 先修了历史乐观偏差：dufu.js 一直「按后占槽到过期」，sim3 却按下即释放槽位（`linger`
  开关），修正后 219–252 的 E 9.26→11.15/min（实机 10.5）；在 linger 之上 repress 11.05→10.44（−0.61/min）。
* **B `closeIn` 拼刀**（默认关）：空闲前步贴脸 + 自动带 v6 修复 bundle + 间隔 bin 跨段预排 + repress；段间隔
  ≥8 f > 卸势 CD 6.6 f 可连续卸。**C `qiAttack` 气竭进攻**（默认关）：轻击 420ms + 处决模板（qiExecWait 4s）；
  实机抓到关键 bug——真气条清空时运行时读数返回 −1 不是 0（253–260 每轮都有气竭但模块 0 触发），修成
  「连续读空+boss 条在+上次读数小」后 261/262 各 1 次窗口：12–13 轻击 + 1 处决（+4s）。
* **实机 251–262**（251/252 验收折入 + 253–262 十轮）：A 臂（防守时机）三轮 hit/min **6.5/6.7/6.7（6.63±0.1）
  vs v6 修复臂 8.75、历史均值 8.8**；C 臂 ok/min 11–20（默认 10.7）但挨打回到默认量级（262 近身阵亡一次）；
  B 8.9（n=1）、默认 8.2（n=1）。FT 233–262：hit 19-3 82.8%、ok 99.6%（含新 flag 口径）。新轮对齐用
  `align_check.py`（hit 事件对 hp 掉帧交叉验证；253 的 glow 假最优 −9 → 真值族 +3..+6）。`ds.ALL` 150→263。
* **`ready.py` 守卫**：竞技场任务行模板匹配（`quest_arena.png`，场外 ≤0.12 / 场内 0.78–1.0），闭环 247 误判。

## 独夫 v8：诊断 + 金光/幕布开关 + 进攻第一步（2026-10-16，实机 263–324）

离线诊断与四批实机报告都在 `data/tmp/dufu_breakthrough/`（attribution.md 归因、ceiling.md 上限仿真、levers.md
历史与杠杆、offense_plan.md 进攻设计、live/report{,2,3,4}.md）。dufu.js 新 args 全默认关。

* **诊断**：模型漏报只占 0.08/min；A 臂 6.6/min 里金光 ~3.0、幕布 ~1.3、普通 ~2.3。oracle 感知下仍有 1.3–3/min
  （普通卸势最佳时机 ~96%），只防守做不到无伤；只防守一场约 22 分钟，指标应改为「每场挨几下」。演练场面板写明
  「演练禁用辅助卸势」；设置里「卸势/闪避输入缓存」为开启。
* **金光闪避时机（实机确认）**：other 类白闪落在金光图像 onset 后 15–20 帧挨 0.31，6–11 帧 0.67，21–23 帧全挨。
  `flareMode` late/parry、`flare2` 都没赢（parry 被卸势 CD 丢 26/48，flare2 显著更差）；单开 `flareAnchor` other 14
  被 fut 头先按的闪避占掉 CD（只按出 35%）。**`flareHoldFut`**（other 首报起挡 fut 闪避到锚定按出）+ other 14：按出
  92%、白闪中位 +18.7、other P(挨) 0.52→0.33（vs 三批 A p=0.003），但金光链变长，总 hit/min 不变（7.5 vs 7.45）。
* **幕布 `curtainTimed`+`curtainKeepParry`**：扫击周期 65 帧、每幕 3 下（首下与黑幕同到，只管后两下）；20 vs 20 轮
  每次幕布挨打 1.94→1.26（显著），总量中性。
* **推荐默认**：A 臂 + `{"curtainTimed":true,"curtainKeepParry":true,"flareHoldFut":true,"flareAnchor":{"flare_other":14}}`。
  `failEscape` 离线显示约一半闪在本可卸开的那下前，未上机。
* **进攻第一步**：`offShadow`（只记门控）实机 gateFrac 0.108、开门 8.6/min、中位 452 ms、开门后 1 s 无接触 99.2%，
  fps 不受影响；门太碎，真出手前要加迟滞/最短开门。`qiPlan`（处决计时从按钮出现算、触点 3 轻击）323 一个窗口正常：
  +2.66 s 处决、无卡触点，但每窗 −63 px 与旧 qiAttack 相同——轻击几乎不掉血，伤害来自处决。气竭约 220 s 才出现，
  Q 臂 319–324 连续 6 轮阵亡（原因未明，待在默认臂复查）。`untilCleared` 未实测。
* **实验口径**：每轮 ~26 下，泊松噪声 ±1.3/min，每臂 8 轮只看得出 ≥2/min 的总量差；按类别的二项指标（每次金光/每次
  幕布挨打）才分得出。
* **木桩 E0**（`data/tmp/dufu_breakthrough/e0/e0.md`）：陌刀轻击、横刀突进、蓄力（须先抬手，否则重新起蓄）、唤千军前
  600 ms 都能被卸势随时打断（闪光后 ~0.1 s 出架势）；**横刀爆发 ~2.4 s、唤千军召唤段 ~2 s 吞卸势**。触点 3 与摇杆共存正常。
* **伤害才是打不完的瓶颈**（325–347，report5/6）：只防守 boss 0 掉血，3 瓶药约撑 4–5 分钟。m30 安静门开时 boss 多半
  离得远（O 臂 26.5 px/min）；「距上次卸势成功」才是近距离信号（离线 5 s 内出手打中 95%、之外 32%，实机 63%/35%）。
  `offOkGate`+`offCommit`+`offFar`（卸势后 3 s 承诺窗口、蓄力优先、横刀一套打完）68.6 px/min、hit 9.6/min、每场约 54 下，
  345/347 打到 360/385；旧窗口复刻 `oldWindow` 伤害相同但挨打 13/min、1.5 分钟阵亡，停。门开只 9–14%（m30>0.3 否决占
  75%），下一步放宽否决、减少蓄力被提前松开。
* **补丁 2.3 与喝药**（348–364，report7/8）：补丁不改伤害和 boss 节奏，但存活 4.6→2.4 min，原因是按药落在挨打/卸势后
  0.05–0.25 s（实测卸势后 0.4 s 内按药被吞、喝药中卸势或挨打会打断），且一按就记一瓶。`potionSafe`+`potionConfirm`
  修复后存活回到 4.6 min、真回血 22%→75%。`dufu_enter.js` 已适配 2.3 试炼页（374b2f4）。
* **新优化目标**（老师定）：最多 1 瓶药；主指标交换比 = 打掉 boss px ÷ 挨打，次指标 boss px/min、打完用时。动作交换比：
  冷/热蓄最高，横刀爆发/伤害最低，但关掉横刀一套（无热蓄）整体更差（report10）。气竭窗口每窗 63–78 px、0 挨打，boss 真气
  满→0 约 114 s；**瓶颈是撑不过开局约 2 分钟到第一次气竭**。
* **模型 v8**（`unified_{back8,head8}.onnx`，18d8fab，`data/tmp/dufu_ml/unified/model_head8_report.md`）：滚动入库到 364、
  新增 ours/cont/fut1f 头与 land 探针，输出 133 维（前 77 维同 v6，dufu.js 直接换 args）。实机 380–395 A/B：卸势 ok/min
  10.8→13.8（p 0.038），px/挨打 5.67→6.72（p 0.083），存活 2.82→3.26 min，开局 2 分钟挨打没降。v8 替换 v6。
* **真气机制**（`data/tmp/dufu_breakthrough/qi_mech.md`）：boss 真气不自然回复，只在气竭后回满；满→空约 385–399 px。每次
  削：卸势成功 12.3、热/冷蓄打中 15/14、横刀一套 ~12、爆发 7.5、轻击 0.6。首次气竭中位 ~115 s，75% 靠卸势。
* **老师补充的技能**（README 第 256–279、765–768 行早有木桩数据，不用重测）：`offQishu`（奇术，按冷却数字确认放出，
  qishuWhere open/ok，放出后 1 s 挨打 0）、`parryFollow`（横刀卸势成功后重击按钮变蓝色爆发盘约 3 s，点出追击；followTh 0.3
  时 1 s 挨打 0，0.3–0.5 段 19% 挨打）、`ranshiStrikeMs`（燃此魂第二下挥刀，6 次 1 中，收益差）。`qiExecFix`（默认开）修处决
  晚到。受击链开关 staggerByDrop/hitEscape/parryRelockMs/curtainParryPlan 单独开无收益（幕布/出招中挨打增多抵消）。
* **实机 428–472**：X2（链开关+奇术+追击）交换比 9.08 vs 同批 B 7.36（p 0.195）、vs 24 轮基线 6.45（p 0.030）；X3（奇术+追击
  0.5）6.14 vs 同批 B 5.18（p 0.24），金光挨打 −0.94/min、存活 +0.46 min 显著。批次间漂移（同臂 B 5.2–7.4）大于臂间差。
* **首次打完阶段一**（第十八批，report18）：SC（offQishu+parryFollow followTh 0.3+受击链开关，v8，1 瓶药）508/516 两轮打完
  （271–277 s、挨打 21–27）。成功页之前被死亡检测误判（「演练下一阶段」白底按钮落在「再次训练」判定区），已加
  `result_success.png`/`result_drill_again.png` 模板，dufu.js 记 reason "cleared"；脚本在成功页点「再次演练」(868,679)。
  SC9（v9 模型 trigTh 0.45）普通挨打 −0.58/min；去掉 curtainParryPlan 幕布挨打 1.09→0.75。
* **默认 D**（第十九、二十批，report19/20）：SC9 去掉 curtainParryPlan。D 两批 20 轮打完 3 次（543/547/554，264–291 s、
  挨打约 21），交换比 9.29。`offBuff`（唤千军）放出判定修好（倒计时/变暗连续 10 帧，608d1b3）后真放出率只有 22%、放后看不出
  加成，两批 DB vs D 方向相反，保持默认关。已知 bug：成功页约 1.3 s 内 dufu.js 的补锁点击 (1021,667) 会点到「演练下一阶段」。
* **成功页停手**（033234d → 6be5ad5）：halt 只由成功页模板（连续 2 帧）触发；按 boss 条读数停手在 566 误触发（条读数乱跳
  到 0–15 px，boss 实际剩一半）已删除，「最后 10%」「回满」都只记日志。(868–1080, 640–700) 内的按下在模板命中时不按。
* **冢上霜 `offTang`**（第二十一批，木桩 `data/tmp/dufu_breakthrough/e1/`）：卸势随时可打断冢上霜，但松手后 1 s 才保住全额
  ~19K；冢上霜后约 1.5 s 重击变蓝盘才能接拨雪寻春（整套 45–51K）。实战 59 次中位 0 px、只接上 7 次拨雪寻春；出招中挨打
  0.55→0.26/min（p 0.021），但伤害与打完率没涨，保持默认关。D 累计 4/20 打完（264–292 s）。

## 独夫 v9 推理管道：head9s + App 侧特征环（2026-10-18）

模型不变（与 back9/head9 输出逐位一致），只换 head 的输入与传输：`unified_head9s.onnx` 去掉 head 从不使用的
`img` 输入（`v9/export9s.py` 重导出，133 维切片不变）；App 的 `infer` 支持无图像模型（`nn_jni.cpp` 的 `nnRunExtra`
frames 为空 + `Nn.kt` 跳过全部截图预处理）与**每 run 的特征环**（`history` 把 backbone 输出 + aux 追加进环，
`extra.ring` 拼 30 步，返回 `ring:{len,sum}` 供对账；`data_b64` 是后备）；调度器新 args **`seqRing`（默认关）**，
开时 head 调用不带 image/BACK、`model` 用 `dufu/unified_head9s.onnx`。

* **设备实测**：head p50 16→**1 ms**（预处理 5.8 消失、桥 9.7→0.4、run 1.0→0.4）、主循环 38.1→**30.4 ms**（−7.7，−20%）、
  fps 19.5→20.7（截图流 ~20–21 fps 是硬上限，收益落在决策延迟与 CPU 余量）；新旧输出 max|d| = **0**。
* **实机 A/B**（第二十二批 583–602，D vs DP ABBA 各 10 轮，`live/report22_dp.md`）：10/10 DP 轮 `seqRing` 生效、
  **ringBad 全 0**、43959 次 head 调用 100% ready；交换比 −0.67 [−4.20,+2.51] p=1.0、打完 0/10 vs 1/10（Fisher p=1.0）
  ——**不退化**，DP 作为后续批的新基线（批 23 起 `sched23.py` 的 `B23_BASE=DP`）。
* 坑：重跑同一轮号时 `round_stats.py` 会把旧录像的逐帧特征移到 `data/tmp/dufu/r<k>.json.stale-<rec>` 再重抽
  （此前只打印提示；583–588 曾因此留下一版作废特征）。
* 复现：`v9/export9s.py --ckpt runs/v9c/ep2_land.pt --suffix 9s`；`cd android && ./gradlew assembleDebug && bash android/scripts/install.sh`；
  `uv run maalow sync WhereWindsMeet --push …`；验收 `uv run maalow do skill nn_bench --args '{"ring":true,…}'`；
  mock `node data/tmp/dufu_breakthrough/ring22/ring_smoke.mjs`。

