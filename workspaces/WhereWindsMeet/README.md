# 燕云十六声（WhereWindsMeet）工作区

游戏包名 `com.netease.yysls`，截图 1080×720。MaaLow 本身的用法见仓库根目录的 README.md，这里只写这个游戏自己的东西。

## 里面有什么

| | 内容 |
|---|---|
| 流水线 `pipeline/` | 启动登录 `LaunchAndLogin`、每日签到 `DailySignIn`、各种弹窗（商城、奖励、物品提示、空闲幻灯片）、自动拾取 `AutoPickup`、找怪开打 `SeekAndFight`、据点 `StrongholdFight` / `CixinTeleport` / `CixinRoute` |
| 技能 `skills/` | `move.js` 移动（摇杆、疾跑、追怪、按路点连续定位跑）、`combat.js` 战斗、`route.js` 据点路线、`stronghold.js` 据点检查和 `where()` 开地图读位置、`auto_pickup.js` 拾取、`pinch.js` 双指缩放；`lib/minimap.js` 读小地图（镜头朝向、红点、据点橙色区域），`lib/hud.js` 右上角图标 |
| 守护规则 | `AutoPickup`（500 ms）、`DismissIdleSlideshow`、`CloseItemTip`（1000 ms） |
| 离线工具 `tools/` | `wwm_locate.py` 做小地图定位的参考图；`route_bench.py` 据点路线跑分 |

## 据点：慈心山院

整个流程：`CixinTeleport`（菜单 → 江湖行 → 挑战 → 慈心山院卡片 → 大地图点传送石碑 → 传送，落地关掉商城弹窗）→ `CixinRoute`（从石碑沿 16 个路点走：进大门，销毁 4 朵毒花，打精英怪，开据点宝箱）。卡住或跑乱了就再跑一次 `CixinTeleport` 回石碑。

* **路点坐标**：大地图放到最大时，相对据点图标的像素，x 向东、y 向南。录点用 `stronghold.js` 的 `where()`：点小地图打开大地图，人物箭头固定在 (537,362)，认出据点图标就能算出位置。人站在图标旁边时箭头会把它挡住，这时改认图标左上方的名字标签「慈心山院」，它离图标总是 (53, −50.5)。画面上找不到小地图扇形（菜单、读条）就不开地图，返回 null
* **路线怎么走（默认：连续定位）**：节点参数 `locate: ["locate/cixin_mosaic", "locate/cixin_bigmap"]`。每一帧先按镜头朝向、摇杆方向和当前速度推算位置，再用 `locate()` 在推算位置附近找小地图；拼图认不出就换大地图参考图，可信（分数 ≥ 0.4、比第二峰高 ≥ 0.1）就用它校正。全程不开大地图，只在有动作的点和终点停下，途经点 6 px 内算经过
  * 离终点 12 px 时松开疾跑，剩下的普通跑，免得冲过头
  * 2 秒没靠近目标算卡住，依次试：跳、左绕、右绕、后退绕大圈；越跑越远 15 px 算跑偏；3 秒认不出算跟丢。这三种情况都停下报错
  * 右上角图标消失、且小地图 25 px 内有红点才算遇敌（逆光时图标也会认不出，只看图标会误判）：停下交给 `combat`，打完从正要去的那个点接着走
  * 节点参数去掉 `locate` 就回到旧的快照模式（每个路点一张 44 px 小地图快照，`templates/route/cixin/`）。快照是据点没打时拍的，带橙色区域，据点打完后在院子里就对不上了
* **路点上的动作**：`flower` 在右侧交互列表点「销毁」并等读条走完；`fight` 找附近的怪开打；`chest` 点「据点宝箱」→「确认领取」（默认领取三份、扫荡 9，老师定的）→ 点完「继续」结算页
* **刷新**：据点被攻占后约 20 小时刷新。刷新前院子里没有橙色区域，毒花、精英怪、宝箱都没有，动作都会空转（「not offered」）

## 小地图的几个坑（2026-09-30 采集时发现）

* 小地图上北下南，扇形就是镜头朝向（`lib/minimap.js` 的 `cameraHeading`）
* **院子里会放大一倍左右**：院外 1 小地图像素 ≈ 2.3 大地图像素，院内 ≈ 1.15。关掉大地图后会先缩回去 1–2 秒，所以参考图做成两档（`out` / `in`），每次都试
* **圆盘是半透明的**：背后的天空、树枝、黄叶会透出来。用带通滤波（两次模糊相减，`dog` 1/4）只留下墙线和建筑块
* **据点的橙色区也是半透明的**：底下的建筑还看得见，所以不能整块丢掉。橙色区内外分开滤波（`regions.mode: flat`），去掉色差，只丢掉边线那一圈。橙色本身 H 10–24、S 25–85、V 100–235；地图本身的 S 大约只有 5
* 疾跑约 8 大地图像素/秒，松手后还会冲约 3 px（院外最多约 7）；普通跑约 4.6 px/秒
* 右上角图标逆光时认不出来；大地图打开后，图标大约 2.5 秒才显示出来

## 定位参考图

| 参考图 | 来源 | 预处理 | 说明 |
|---|---|---|---|
| `templates/locate/cixin_mosaic` | 4 趟采集（s1–s4）拼成的小地图全图，覆盖石碑到第 15 点 | dog 1/4 | 主力 |
| `templates/locate/cixin_bigmap` | 6 张大地图截图对齐拼接，再按两档比例缩小 | canny | 拼图没覆盖到的地方用它兜底；院外 dog 也行，院内要用 canny |

实测结果：

* **离线（限定范围搜索，±6 px 内的比例）**
  * 拼图：院外 96–100%，院内 99–100%，第二峰差距约 0.6；第 4 趟（东半边 244 帧）留出评测 100%，中位 0.5 px
  * 大地图：院外 90–95%，院内 canny 95–97%，第二峰差距只有 0.2 左右
  * 带橙色的截图只有 3 张，拼图 3 张都对
* **设备**：每次约 10 ms（两档都试）
* **全程第 1–15 点，每点停下用 where() 核对，3 轮 + 重构后 1 轮**
  * 45 次到达误差中位 2.5 px、最大 4.7 px；locate 和 where() 中位差 0.5 px
  * 石碑到宝箱约 100 秒跑动，不开地图

## 给新据点（或新区域）做路线

数据放在仓库根目录的 `data/wwm/`（不入库），命令都在仓库根目录跑，要先 `uv sync --extra cv`。

1. **传送节点**：照 `CixinTeleport` 做一个，裁这个据点卡片和石碑的模板
2. **录路点**：老师边走边说「记点」，用 `stronghold.js {where: true}` 读坐标；已有参考图的地方也可以用 `{locate: [...]}` 同时对比
3. **采集**：
   * 一边抓帧：`uv run python scripts/grab_frames.py data/wwm/survey<N> --seconds 1500`
   * 一边让路线用开地图的方式走一遍，每次开地图前停稳记锚点：`route {points, from, to, anchors: "teaching/survey/s<M>"}`
   * 锚点截图用 `maalow sync WhereWindsMeet --pull --screenshots` 拉回来；锚点列表（结果或日志里的 `anchor {...}`）存成 `data/wwm/survey<N>/anchors.json`，每条加上 `run`
   * 最好多走一趟，留作评测
4. **离线处理**（`uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py …`）：
   * `cache data/wwm --survey survey<N>`：截出每帧的小地图、判断是不是大世界画面、读镜头朝向
   * `track data/wwm --survey survey<N> --relocate mosaic_s1_s2_s3_s4`：用锚点加逐帧配准给每帧定位；链条漂移超过 4 px 的段改用已有参考图定位
   * `stitch data/wwm --runs s1,…`，再 `eval data/wwm --native data/build/locate.dll`：拼图，用没进拼图的那一趟评测。`mosaic*/overlay_*.png` 是把拼图叠到大地图上的检查图
   * `export data/wwm --runs s1,…`：写 `templates/locate/<name>_{mosaic,bigmap}.json` 和 PNG，然后 `maalow sync WhereWindsMeet --push`
5. **跑分**：`uv run python workspaces/WhereWindsMeet/tools/route_bench.py data/wwm/bench --refs locate/cixin_mosaic+locate/cixin_bigmap --rounds 3 --to 15`。每轮传送回石碑跑一遍、每点核对；失败重来，同一点连败 3 次就跳过

## 还没验证的

* 据点刷新后带橙色区域实跑：离线只有 3 张带橙色的截图
* 销毁毒花、打精英怪、开宝箱这三个动作真做一遍
* 真遇到敌人：打完后接着走。打斗时人被拉开超过约 40 px，或拉到参考图外面，会报跟丢；到时候再考虑打完先全图搜一次
