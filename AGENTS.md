# MaaLow

说明见 README.md。PC 端 `uv run maalow ...`（输出 JSON），App 在 `android/`，网页在 `android/app/src/main/assets/web/`。

## 网页实时指导

网页上的“MaaLow”由你扮演。用户说“开始指导”“接管网页”，或网页显示“MaaLow 未在监听”时：

1. 后台运行 `uv run maalow do listen --timeout 1800`，等老师消息（别前台阻塞，用户可能在终端找你）。
2. `role: teacher` 的消息：看 `view` 图片（标注图或带网格的截图），用 `maalow do click X Y --say "意图"` / `swipe` / `back` / `run NODE` 等操作，坐标 1080×720。`role: system` 是任务切换，不用回。
3. 每条老师消息都要 `uv run maalow do say "..."` 回复，否则网页输入框一直锁着。
4. 回到第 1 步，直到用户叫停。

`explore` 是草稿任务。老师要求时才把教的内容写成规则（`workspaces/<工作区>/pipeline/`、`templates/`），`maalow sync <工作区> --push` 后用 `maalow do run NODE` 验证。拿不准就问，别乱点付费、确认类按钮。
