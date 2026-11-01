# move_scripts

分支招式脚本（离线）。当前只有 `c11.json`，用于证明 c11/c40 金光连段能不能按“整招时间表”防住；运行时尚未接入。

## 为什么不是 movetable

`model/dufu1/movetable.json` 是**每个前缀组**的按键提前量/应对，适合“认到下一拍是什么组”后逐拍反应。它表达不了：

- 同一组在不同分支下的不同时间表（k0 命中后的 k1 在 +4..21 帧，k0 闪掉后的 k1 在 +20..67 帧）；
- 一拍失败后下一拍该不该继续按键（k0 命中后 k1/k2 在硬直里，按键只会浪费 330 ms 卸势锁）；
- 收招后的惩罚窗口（execute / light / follow 各自需要多少帧）。

`c11.json` 是补这一层的第一个样例。

## schema（v1）

- `tell`：什么时候加载脚本。按头部连续两帧给出 `k0:c11/c40` 且 `P(grp) >= 0.5`。
- `clock`：帧单位、30 fps、`t0` 的定义（金光 opener 的真值接触；被闪掉时用按键的预测接触 `press_f + remF`）。
- `state`：角色状态估计。`hitstun_f`、`dodge_iframe_f`、`dodge_lock_f`、`parry_lock_f`、`parry_cd_f` 都是**从实机数据估的**，不是引擎常量；`hitstun_f=12` 是工作下界，r185 目视 k0 硬直 10093–10105（约 12 帧），k1 10106 续到 10119。帧表里每个状态都标 `est: true`。
- `beats`：按拍写。每拍有：
  - `match`：匹配哪一类真值接触（k、颜色、组名里含 c11/c40）；
  - `offset_f`：相对 `t0` 的帧范围；
  - `response`：`dodge` / `parry` / `none`；
  - `press_lead_f`：按键提前量（相对该拍接触）；
  - `state_required` / `state_forbidden`：按键时必须/不能处于哪些状态；
  - `branches`：`hit` / `ok` / `dodge` / `whiff` 后跳到哪一拍。
- `punish`：收招后的惩罚窗口。`min_gap_f` 是“到下一个真值接触至少多少帧”，`press_delay_f` 是硬直结束后的延迟；动作按 `execute > light > follow` 选，条件是各自的最小窗口。
- `forbidden`：老师规则禁止的分支（金光 opener 不许 parry）。

## 离线回放

```bash
uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_replay.py \
  --rounds r185 r186 ... r223 --script workspaces/WhereWindsMeet/move_scripts/c11.json
```

回放器只读 `data/moveid/p1/live/rNNN/{contacts,trace,result,args}.json` 和 meta，不 import `s5_ab` / `s5_analyze`。输出：

- `data/moveid/offense/online/c11_replay.json`：逐 episode 的 observed / script 分支、k0 是否避开、k1/k2 命中、按键 lead、hitstun 覆盖、post_gap、惩罚窗口。
- `c11_replay.md`：汇总表。

验收口径：脚本回放的 k1/k2 命中必须为 0；做不到就必须写机械原因并停，不允许用运行时开关去补。
