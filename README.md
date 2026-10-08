# dsh-plugin-whale-overlay · 小鲸鱼桌宠（DSH 插件）

把桌面上那只小鲸鱼搬进 DSH Web GUI：它浮在整个界面之上，会自己游来游去、可以被拖到任何地方、戳一下会说本地台词；**agent 需要你确认、或者干完活的时候，它会跳一下并说出来。**

- 插件 ID / 包名：`dsh-plugin-whale-overlay`
- 适用面：**web profile**（也就是 `dsh web` / 你现在用的这个 GUI）
- 依赖：无第三方依赖，只用 Node 内置模块 + 宿主提供的 React
- 素材：沿用 [小鲸鱼桌宠](../whale-pet0) 的原图（`whale_*.gif` / `*.png`），未重画

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 待机 + 随机游动 | 每 9–20 秒随机向左或向右游一段，撞到窗口边缘会停下并吐槽 |
| 拖拽 | 按住左键拖到任意位置，松手后位置记在 `localStorage`，下次打开还在原地 |
| 戳一下 | 单击说一句本地台词（13 句），连续戳不会重复同一句 |
| 右键 | 在人形 / 鲸鱼形态之间切换，选择会被记住 |
| **需要你确认时提醒** | 会话出现 `approval` / `plan-review` / `question` 时，跳三下 + 说「有人要你点头才能继续哦！」 |
| **干完活时提醒** | 会话从「运行中」变为「结束」，说「干完啦～」 |

提醒气泡带一圈橙色描边（桌宠自己的强调色），停留 9 秒后自动消失；普通台词停留 2.6 秒。

## 它不做什么

这一点是刻意的：

- **不调用任何模型**。台词全是本地句子库，不会产生 token 费用 —— 你在 GUI 里已经有一个在跟模型对话的窗口了。
- **不发送消息、不碰会话数据**。它只读两个标量：当前会话的 `running` 和 `pendingInteraction`。
- **不改主题、不动产品 DOM**。样式全部锁在 `.dshWhaleOverlay_*` 前缀下，颜色走 `--dsw-*` 主题变量，所以深色/浅色自动跟随。
- **不常驻全屏遮罩**。它只占自己那 96×96 的方块，其余区域照常点得动。

---

## 结构

```
dsh-plugin-whale-overlay/
├── lib/
│   ├── index.js      # host 半：注册一条 /dsh-plugin-whale-overlay/assets 静态素材路由
│   └── client.js     # client 半：手写的 __ModuleLoader__ bundle，往 shell.overlay 注册桌宠
├── assets/           # 8 张图（whale_idle/walk/drag + 人形 idle/blink/walk/drag）
└── tests/
    ├── plugin-harness.js           # 离线自检：153 条断言
    └── fixtures/outside-asset.png  # 目录穿越测试的诱饵文件
```

两个设计要点：

1. **为什么有 host 半？** 浏览器端的插件 bundle 必须是**单文件**（模块表只解析平台种子、shell 自身模块、以及已注册的 bundle），所以素材没法 require 进来 —— 要么把 1MB 图片 base64 塞进 bundle，要么由 host 开一条静态路由。这里选了后者。
2. **为什么挂在 `shell.overlay`？** 那是 AppFrame 的整屏浮层（`list` 类型、root 作用域、click-through），并且按契约会给入住者发 `useSessions` / `useWorkspaces` —— 正好是桌宠需要的会话状态来源。

---

## 安装

> ⚠️ **需要重启一次 `dsh` 进程**：浏览器插件的花名册（`window.__DSH_BOOT__`）是启动时扫描出来的，所以新增插件必须重启才能生效。重启不会丢会话历史。
> 装好之后的后续改动**不需要再重启**（client-hmr 会监视 bundle 变化并热重载）。

```bash
# 0) 先把本仓库放在任意位置，然后记进 $PET_HOME
#    （下面全程用变量，命令里不写死任何本机路径）
PET_HOME="$HOME/Desktop/dsh-plugin-whale-overlay"     # ← 改成你实际放这个文件夹的位置

# 1) 让 web profile 能按名字解析到这个包（本机没装 pnpm，所以直接建软链）
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn "$PET_HOME" ~/.dsh/profiles/web/node_modules/dsh-plugin-whale-overlay

# 2) 在 profile 的 patch 层插入一行插件
#    ~/.dsh/profiles/web/cordis.patch.yml 的内容改成下面这样（原来只有注释和一个空数组 []）
cat > ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'
- insert:
    - id: pet
      name: dsh-plugin-whale-overlay
YAML

# 3) 验证解析，然后重启
node -e "console.log(require.resolve('dsh-plugin-whale-overlay/package.json', { paths: [process.env.HOME + '/.dsh/profiles/web'] }))"
# 输出应为 $PET_HOME/package.json
```

然后重启：在跑 `dsh web` 的那个终端按 `Ctrl-C`，再执行一次 `dsh web`，浏览器刷新页面。

### 装好之后应该看到

- 屏幕左下角出现一只小鲸鱼，过一会儿自己开始游动；
- 拖它、戳它、右键它都有反应；
- 设置里的插件清单（Plugin inventory）中会出现 `dsh-plugin-whale-overlay` 一行；
- 在浏览器里打开 `http://127.0.0.1:3080/dsh-plugin-whale-overlay/assets/whale_idle.gif` 能直接看到图（用你 GUI 的实际地址，默认端口 3080）。

如果 GUI 起不来，说明第 2 步的 YAML 写错了 —— 见下面的回滚。

### 卸载 / 回滚

```bash
# 1) 配置文件恢复成空 patch（GUI 立刻恢复正常，不需要动软链）
cat > ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'
[]
YAML

# 2) 删掉软链
rm -f ~/.dsh/profiles/web/node_modules/dsh-plugin-whale-overlay
```

桌宠写进 `localStorage` 的位置/形态可以这样清掉：打开浏览器控制台执行
`localStorage.removeItem('dsh-plugin-whale-overlay:position'); localStorage.removeItem('dsh-plugin-whale-overlay:form')`。

---

## 自检

```bash
cd /path/to/dsh-plugin-whale-overlay      # 换成你实际放这个文件夹的位置
node tests/plugin-harness.js
```

153 条断言（含一组"脱敏守卫"），全部离线，不需要 Electron、不需要浏览器、不需要网络。它做的事不是"跑一遍看有没有报错"，而是**把真实的 bundle 真正跑起来**：

- 用一个真的 `window.__ModuleLoader__` 接住注册（并像产品那样**延迟**执行 factory，不提前跑副作用）；
- 一个迷你 React（`useState` / `useRef` / `useCallback` / `useEffect`，含"先渲染后跑 effect"的顺序），所以组件是真的被执行的 —— 戳它、拖它、切换形态、推进时钟，断言渲染结果和 DOM 写入；
- 一个可控时钟（同时驱动 `setTimeout`/`setInterval` 和 `Date.now`），所以"游动"和"提醒"是可复现的，而不是"等 7 秒碰运气"；
- host 半是按真请求测的：真实文件流、content-type、content-length、HEAD、405、非法转义 400、目录穿越 404。

这些断言经过**变异测试**验证不是摆设：故意去掉"切换会话保护""目录穿越保护""拖拽后那次点击的忽略""游动边界夹取""台词去重""位置持久化""右键不进入拖拽"之后，对应断言都会红。

### 交付前实际验证到了什么

除了离线自检，这份插件在**真实浏览器里跑过一次**（用另一个 `DSH_HOME` + 另一个端口起了一个临时实例，装好后用 Chrome headless 的 CDP 协议驱动，测完即销毁，没有碰你的 `~/.dsh` 和正在用的 GUI）：

| 验证项 | 结果 |
|---|---|
| host 素材路由 | `GET /dsh-plugin-whale-overlay/assets/whale_idle.gif` → 200 / `image/gif` / 194714 字节，与源文件逐字节一致 |
| client bundle 被扫进花名册 | 页面里 `__DSH_BOOT__` 含 `{"id":"dsh-plugin-whale-overlay","url":"/plugins/dsh-plugin-whale-overlay/client.js?rev=…"}` |
| 真的挂载了 | 浮层内 `.dshWhaleOverlay_root` 恰好 1 个，渲染尺寸 96×96，GIF `naturalWidth > 0`（真的加载了） |
| 浮层不会挡住全屏点击 | 插槽渲染器给的 wrapper 是 `display: contents`（不产生盒子），只有桌宠那 96×96 可点 |
| 单击 | 真实鼠标事件 → 气泡「嘿嘿～在呢！🐟」 |
| 拖拽 | `data-dragging="true"`、切到 `drag.png`、位置 (54,211)→(214,121)、`localStorage` 写入 `{"x":214,"y":121}` |
| 拖到角落 | 被夹取到 (10,10)，并吐槽「🐟 要掉下去了！快拉我一把～」 |
| 右键 | 切到人形（`idle.png`），`localStorage` 写入 `human` |
| 自主游动 | 12 秒内自己从左移到右，始终在视口内 |
| 运行时异常 | 0 条 |

唯一**没有**在浏览器里跑到的路径是"提醒"：它需要一个真的在跑 agent 的会话，而临时实例没有凭据。这条路径由离线自检的状态机断言覆盖（`announceFor` 的 6 种迁移 + 组件级的完成/提问/静默场景）。

---

## 脱敏

本仓库不含任何本机身份信息，可以直接公开：

| 检查项 | 结果 |
|---|---|
| 含用户名的绝对路径（macOS / Linux / Windows 的 home 前缀） | 无 —— 安装与自检命令全部用 `$HOME` / `$PET_HOME` / `process.env.HOME` / 占位路径 |
| 本机用户名、主机名 | 无 |
| 邮箱地址 | 无（`package.json` 没有 `author` 字段） |
| API Key、访问令牌、私钥、手机号 | 无 |
| 硬编码的内网/VPN 地址 | 无（只有 `127.0.0.1` 这种回环地址） |
| Git 身份 | 本目录**不是** git 仓库，没有 `.git`，因此不带任何提交者信息 |

而且这条防线是**自动**，不是靠人眼：`tests/plugin-harness.js` 里有一组"脱敏守卫"断言，每次跑自检都会重新扫描实际交付的文件（`package.json`、`README.md`、`lib/index.js`、`lib/client.js`），一旦有人把本机路径、用户名、主机名、邮箱、令牌形态或私钥块写回去，自检立刻变红。守卫用的是运行时的 `os.userInfo()` / `os.hostname()`，所以它在谁的机器上跑，就守谁的信息。

> 关于浏览器里的隐私：API Key 之类的东西从来不经过这个插件 —— 它不读也不写任何凭据，只往 `localStorage` 写两个自己的键（`dsh-plugin-whale-overlay:position`、`dsh-plugin-whale-overlay:form`），清掉的方法见上面的卸载一节。


---

## 可调项

常量都在 `lib/client.js` 顶部的 `tuning` 一段，改完保存即可（已装好的话浏览器会自动热重载）：

| 常量 | 默认 | 含义 |
|---|---|---|
| `PET_SIZE_PX` | 96 | 桌宠边长（素材是 1:1 方图，所以一个值管两个方向） |
| `WALK_FIRST_DELAY_MS` | 7000 | 打开页面后多久开始第一次游动 |
| `WALK_MIN_DELAY_MS` / `WALK_MAX_DELAY_MS` | 9000 / 20000 | 两次游动之间的随机间隔 |
| `BUBBLE_MS` | 2600 | 普通台词停留时间 |
| `REMINDER_BUBBLE_MS` | 9000 | 提醒停留时间 |
| `POKE_PHRASES` | 13 句 | 本地台词库 |
| `PENDING_PHRASES` | — | 三种"等你确认"的台词 |

---

## 已知限制

- **只跟随「当前会话」**。切到别的会话时桌宠会重新记基线（不会把"切走"误判成"干完活"），代价是**在别的会话里发生的完成/提问不会提醒你**。想改成"任何会话都提醒"，改 `lib/client.js` 里 `announceFor` 的会话比较 + `sessions` 选择器即可。
- **必须重启一次 dsh 才能首次生效**（见上）。
- **只对 web profile 生效**。桌面端（Electron）那份 `dist` 走 `file://`，没有 webserver 路由可用。
- **没有农历/节日祝福**。原桌宠的节日感知依赖 `js/lunar.js`（约 300KB），这一版没有引入，所以桌宠不会说"端午安康"。
- 桌宠会**挡住它自己那一小块区域的点击**（比如刚好压在输入框上时）。拖开即可。
- **产品弹出阻塞式对话框时，桌宠也点不动** —— 那时整个 app 被设成 `inert`，这是 DSH 自己的行为（弹窗期间不该让你点到后面的东西），不是桌宠的问题。想让桌宠在这种情况下也能被点到，得让它挂到比弹窗更高的层，那就不属于 `shell.overlay` 的语义了，所以没做。

---

## 素材与致谢

图片素材来自 [小鲸鱼桌宠](../whale-pet0)：基于**西瓜皮老师**的 Windows 版桌宠创意移植，素材版权归原作者所有。本插件仅把同一只鲸鱼搬进了 DSH 界面。
