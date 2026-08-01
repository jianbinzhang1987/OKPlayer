# HANDOFF：网盘原画播放修复（夸克/百度）

> 生成时间：2026-08-01（用户将把此文档交给其它模型继续修复）
> 项目：`/Users/adolf/Desktop/code/TV/mac`（FongMi Desktop / OKPlayer，Electron 43 + Vue3 + 原生 libmpv addon）
> 当前状态：**应用在跑（PID 45537）**；夸克二次播放已经用户验证正常，百度原画的 provider-aware 直连修复已重建并重启，待用户复测。

> 2026-08-01 21:02 更新：用户验证到“夸克首次可播，关闭后夸克/百度都不可播”。日志确认 CatVod legacy 分块代理会在新媒体 key 进入时删除其他活跃会话目录，导致关闭后的并发写入持续 `ENOENT .../vod_cache/<session>/req-*.dl`；同时网关曾将媒体缓存验证头透传为上游 `304` 空响应。已修复为启动时持久化 CatVod `smart` 代理模式，并禁止媒体条件缓存/response cache；334/334 测试通过，已重建并启动 PID 36468，**修复后的真实网盘二次播放仍待用户验证**。

> 2026-08-01 21:12 更新：夸克修复已验证。百度原画返回 `206 video/mp4`，3.3 秒交付约 22 MB 但 Chromium 仍卡在“正在加载媒体”，排除账号和代理无数据；判定为 4K/HEVC MP4 的 Chromium 编解码兼容问题。已让网盘原画 MP4 在 auto 模式直接走内嵌 libmpv，并补齐 loopback 媒体 CORS/CORP；334/334 测试通过，已重建启动 PID 41166，**百度真实播放待用户复测**。

> 2026-08-01 21:20 更新：用户复测百度时进入 libmpv 后 15 秒自动退页。日志定位 CatVod smart 代理对百度的 16 路 256KB 分块大量出现 `chunk read timeout / download incomplete`，并非 libmpv 崩溃；同一百度签名 CDN 直链实测首段 1MB 约 0.55 秒、另一 Range 约 0.88 秒且响应范围正确。现改为**百度代理 payload 解包后由主进程网关带原始 User-Agent 直连 CDN，夸克/UC 继续走 CatVod 16 线程代理**；同时播放状态持久化已尝试线路，禁止“百度原画/无限”失败后循环互切直至退页。全量 334/334、typecheck、build 均通过，已重启 PID 45537，待用户验证。

---

## 0. 三句话总结

1. 本机 `npm start`（dev 模式）下 libmpv 原生播放器**之前根本没启用**，导致夸克/百度原画（MKV 容器）无法播放、自动换线到其他线路——**已修**（dev 模式自动发现 libmpv 运行时）。
2. 网盘代理必须按提供商分流：夸克/UC 走 CatVod 16 线程代理；百度多线程会被 CDN 限流并产生分块超时，改由主进程网关带原始请求头直连。
3. 重建 libmpv addon 时加的 `cache-pause-initial=yes` 导致**起播前卡死**（"15 秒未读取到有效媒体数据"→自动换线，夸克/百度原画全部中招）——**已去掉该参数**并重建 addon（20:45 版），但**用户尚未验证最终效果**。

**下一手优先动作**：让用户在 PID 45537 上复测百度原画，确认进入“高兼容播放模式”并正常出画。

---

## 1. 运行方式

```bash
cd /Users/adolf/Desktop/code/TV/mac
npm start          # dev 模式：verify:electron + electron dist/main/main.js（后台跑，日志在 zcode exec 文件里）
npm run build      # 重建 dist（renderer + main）
npm test           # 全量 332 个测试（node --experimental-strip-types --test tests/**/*.test.ts）
npm run typecheck  # tsc -p tsconfig.app.json
```

- 当前应用是后台任务启动的，日志路径（随会话变化，供参考）：
  `/Users/adolf/.zcode/cli/exec/sess_9e4cddea-adff-45b5-8df6-a72df437506f/call_00_VK4Xey9vawhCfi9JF0cr4469-stdout.log`
- **应用数据/服务日志**：`~/Library/Application Support/FongMi Desktop/catvod-node/logs/service.log`（CatVod 蜘蛛行为，含 `resolve.play.start mode=original/speed`、`proxy.session.create` 等关键行）。
- **换线原因诊断**（新增）：主进程 stdout 里 grep `[playback-compat-failure]`（mpv 播放中失败→换线，JSON 含 reason）和 `[playback-line-fallback]`（prepare 失败→换线）；renderer console 已转发进 stdout（`[renderer]` 前缀）。
- **媒体层诊断**（新增）：stdout 里 `[media-protocol] GET kind=media upstream=206 ... range=...`（每次上游请求的状态/range）、`done 206 bytes=... elapsed=...`（实际交付字节与耗时，可算吞吐）、`STALL idle=...`（>5s 无数据）；`[media-gateway]` 为 loopback 网关日志。

---

## 2. 播放链路（当前最终形态）

```
用户点夸克/百度原画
 → 凭据预检（App.vue: play() 开头，panStatuses expired/not-configured → 先弹扫码）
 → DesktopPlaybackService.prepare()
     → source.resolve() → CatVod /play → 返回 127.0.0.1:<port>/spider/duoduo/3/proxy/quark/<uuid>?pst=<加密{url,headers}>
     → unwrapLocalPanProxyMedia() 解出真实 CDN URL+headers（仅供探测/信息）
     → 咨询性探测（4s 超时）：探测 206 且格式=mkv → format=mkv；探测失败/异常 → 保持 unknown（绝不换线）
     → 【播放 URL 始终保留代理地址】sourceMedia.url（重要！不走 unwrap 后的直连）
     → selectPlaybackEngine：mkv/mp4/hls → web(Chromium)；mkv/flv/dash/mpeg-ts → mpv(libmpv)
         · 注：MP4/HLS 走 web；MKV 走 mpv；unknown 先 web，10s 无 buffered 数据 → 切 mpv
 → web: <video>/HLS.js ← http://127.0.0.1:<gateway>/session/<id>/resource/root（LocalMediaGateway loopback HTTP）
 → mpv:  NativeFallbackPlaybackController → NativeLibmpvController（内嵌 libmpv，OpenGL render API）
         mpv 加载 → http://127.0.0.1:<gateway>/session/...（网关注入 session headers + Cookie）
         → MediaProtocolService（net.fetch）→ resolveUpstream() 还原 → CatVod 代理 → 夸克 CDN
```

**关键文件**：
- `src/desktop/desktop-playback-service.ts` — `resolveMedia()`（探测/解包/换线分类/`MEDIA_URL_EXPIRED`、`SOURCE_RESOLVE_FAILED` 同线路重取）、`selectPlaybackEngine` 包装。
- `src/desktop/main.ts` — `fromAppServices(...)` 传 `nativePlaybackTarget`（HLS 直连、其余走 gateway）与 `webPlaybackUrl`（web 也走 gateway loopback HTTP）；renderer console 转发。
- `src/desktop/media-protocol/local-media-gateway.ts` — loopback HTTP 网关（含流 error/close 处理，防 `net::ERR_CONNECTION_CLOSED` 未捕获异常）。
- `src/desktop/media-protocol/media-protocol-service.ts` — 协议转发 + 响应头/字节/STALL 诊断 + 客户端中止取消上游 reader。
- `src/desktop/renderer/App.vue` — `play()`（凭据预检、同线路重取、换线/换源）、`handleCompatibilityPlaybackFailure`（mpv 失败→换线，带日志）、`fallbackEmbeddedPlayback`（web→mpv 同 session 切引擎）。
- `src/desktop/renderer/components/EmbeddedPlayer.vue` — web 播放器：10s 看门狗（有 buffered 数据则延长、否则切 mpv）、网络错误→重取链接、解码/格式错误→切 mpv。
- `src/desktop/renderer/components/NativePlayerHost.vue` — mpv 宿主：15s 看门狗。
- `src/desktop/player-engine-selector.ts` — 引擎选择。
- `src/desktop/renderer/player-navigation.ts` — 线路评分（网盘源优先原画：`夸克原画`+120 vs `夸克极速`+40，不受"稳定/原画"偏好影响）。
- `src/desktop/native-libmpv-addon.ts` — **dev 模式 libmpv 运行时自动发现**（`hasDevelopmentNativeLibmpvRuntime`，仅 `process.defaultApp===true` 时查 `resources/native/libmpv-player/<platform>/` + `build/native-runtime/libmpv/<platform>/`）。
- `native/libmpv-player/src/libmpv_player.cc` — **原生 addon 的 mpv 选项**（本轮改过：加缓存参数、去掉 cache-pause-initial）。
- `src/desktop/native-libmpv-controller.ts` — JS 侧封装（500ms 轮询状态）。

---

## 3. 本轮全部改动（git 未提交，`git status` 可见）

| 文件 | 改动 |
|---|---|
| `native/libmpv-player/src/libmpv_player.cc` | 新增 mpv 选项：`demuxer-readahead-secs=60`、`demuxer-max-bytes=512MiB`、`cache=yes`、`cache-secs=300`；**已去掉 `cache-pause-initial=yes`**（它导致起播卡死） |
| `resources/native/libmpv-player/darwin-x64/fongmi_libmpv_player.node` | **重建后的 addon（20:45 版，已生效）**；备份在 `/tmp/fongmi_libmpv_player.node.bak` |
| `src/desktop/native-libmpv-addon.ts` | dev 模式自动发现 libmpv（`hasDevelopmentNativeLibmpvRuntime`、`libraryNamesForPlatform`）；仅 defaultApp 生效 |
| `src/desktop/player-engine-selector.ts` | 删 `isPanOriginalLine` 强制 mpv；`COMPATIBILITY_FIRST_FORMATS` 去 unknown；unknown → web |
| `src/desktop/desktop-playback-service.ts` | ① 网盘代理探测改为**咨询性**（成功→带 format；失败/异常→返回代理 URL，绝不换线）；② **播放 URL 保留代理地址**（不再用 unwrap 直连）；③ 412 → `MEDIA_URL_EXPIRED`（重取链接而非换线）；④ 新增 `webPlaybackUrl` resolver（web 走 gateway loopback HTTP） |
| `src/desktop/main.ts` | `fromAppServices` 传 `webPlaybackUrl`（web 走 `http://127.0.0.1` 网关）；renderer console 转发（兼容 Electron 43 新签名） |
| `src/desktop/media-protocol/local-media-gateway.ts` | 新增（git 显示 `??`）：loopback HTTP 网关 + 流 error/close 处理 + 字节/耗时诊断 |
| `src/desktop/media-protocol/media-protocol-service.ts` | 上游响应头/字节/STALL 诊断；`countedResponse` 客户端中止时取消上游 reader |
| `src/desktop/renderer/App.vue` | 凭据预检（`shouldPromptPanLoginBeforePlayback`）；`sameLineRetries`（`MEDIA_URL_EXPIRED`/`SOURCE_RESOLVE_FAILED` 同线路重取一次）；`handleWebPlayerReprepare`；换线日志（`playback-compat-failure`/`playback-line-fallback`） |
| `src/desktop/renderer/components/EmbeddedPlayer.vue` | `reprepare` 事件；10s 看门狗（有 buffered 数据延长×2，否则 `fallback` 切 mpv）；网络错误（code 2/HLS NETWORK_ERROR）→重取；解码/格式错误→切 mpv |
| `src/desktop/renderer/components/PlayerContainer.vue` | `reprepare` 事件透传 |
| `src/desktop/renderer/player-navigation.ts` | 网盘源评分：原画优先（夸克原画>极速），不受偏好影响 |
| `src/core/media-probe.ts` | （原本已有 EBML 魔数→mkv；本轮加注释/顺序微调） |
| 测试 | 新增 `tests/player-engine-selector.test.ts`；`tests/local-media-gateway.test.ts` 新增流错误/客户端中止用例；更新 `desktop-playback-service`/`media-probe`/`player-navigation`/`renderer-playback-recovery` 断言 |

**当前测试状态**：全量 334/334 通过。

---

## 4. 尚未解决 / 待继续排查（重要）

### 4.1 播放中周期性卡顿（"播一秒等一会"）
- **已确认的机制**：MKV 索引在文件尾，mpv 会发超大 Range（如 `bytes 14445-1734143862`，1.7GB）。之前 unwrap 直连 CDN 是**单 TCP 连接顺序流** → 慢速交付 → 卡。已改走 CatVod 代理（16 线程 256KB 分块），**理论上解决，但用户尚未验证最终效果**。
- **待验证**：最新构建（代理 + 无 cache-pause-initial + 15s 看门狗）下夸克原画是否：① 正常起播；② 还卡。
- **若仍卡**：下一步排查方向（按优先级）：
  1. mpv 经网关打代理时 Range 请求是否被逐块串行化（对比日志：代理会话 `threads:16 chunkKB:256` 是否真正并行）；
  2. 是否 HEVC 软解（Intel Mac + `hwdec=auto-safe` 可能软解 2160P HEVC）→ 试显式 `hwdec=videotoolbox`（改 C++ 后 `cd native/libmpv-player && FONGMI_NATIVE_ARCH=x64 npx node-gyp rebuild`，复制到 `resources/native/libmpv-player/darwin-x64/`，重启）；
  3. 参考 mpv 的 `--cache-secs` 与 demuxer 参数是否被正确接受（可用 probe 脚本/日志确认无 setOption 报错）。

### 4.2 "15 秒未读取到有效媒体数据"→自动换线（已修复，待验证）
- **根因**：`cache-pause-initial=yes` 让 mpv 等缓存填满才起播，配合 15s 看门狗 → 起播前被判超时 → 换线（夸克/百度原画同时中招）。
- **已修**：去掉该参数 + 重建 addon（20:45 版）。**待用户验证**。
- 若再出现，检查 `[media-protocol] done bytes=... elapsed=...`（媒体是否在交付）与 `[playback-compat-failure]` reason 即可判断。

### 4.3 其他可能残留
- HLS/DASH 走 mpv 时仍是 mpv **直连真实 CDN**（`main.ts` nativePlaybackTarget 对 hls/dash 返回 `session.sourceUrl`）——文档注释明确这是遗留项，若 HLS 原画有问题需让网关接管 manifest 重写。
- `native-libmpv-controller.ts` 与 `native-libmpv-addon.ts` 有未提交改动（git status 显示 M），确认用途后再提交。

---

## 5. 接手验证清单

1. 重启应用（确保加载 20:45 addon + 最新 dist）：
   ```bash
   ps aux | grep -E "[e]lectron" | awk '{print $2}' | xargs kill -9; sleep 2
   cd /Users/adolf/Desktop/code/TV/mac && npm start
   ```
2. 播放**夸克原画**（2160P MKV）：
   - 期望：正常起播（不再"启动内核 15 秒退出"）；起播后持续播放（不再"播一秒等一会"）。
   - 观察：主进程 stdout 的 `[media-protocol]` 吞吐（`done ... bytes=... elapsed=...`，理想 >10MB/s）、`[playback-compat-failure]` 是否出现。
3. 播放**百度原画**确认不再退化。
4. 播放一个 **MP4 原画**确认 web 引擎正常（不受 mpv 改动影响）。
5. 拖动进度条 2~3 次，观察 seek 后是否卡（MKV 大 range + 代理线程合并）。

---

## 6. 关键日志速查

```bash
# 主进程 stdout（换线原因 + 媒体吞吐 + 网关）
grep -E "\[playback-compat-failure\]|\[playback-line-fallback\]|\[media-protocol\]|\[media-gateway\]" <zcode stdout log>

# CatVod 蜘蛛行为（mode=original/speed、代理线程、播放 URL 域名）
tail -200 ~/Library/Application\ Support/FongMi\ Desktop/catvod-node/logs/service.log
#   · resolve.play.start mode=original → 服务端给了原画
#   · proxy.session.create threads=16 chunkKB=256 → 代理会话
#   · resolve.play.ok proxy=true url=127.0.0.1:PORT/spider/.../proxy/quark/<uuid>?pst=... → 代理 URL
```

---

## 7. 回滚预案

- **addon**：`cp /tmp/fongmi_libmpv_player.node.bak resources/native/libmpv-player/darwin-x64/fongmi_libmpv_player.node`（20:24 版，含 cache-pause-initial——已知会导致起播卡死，仅作极端回滚）。
- **代码**：`git checkout -- <file>` 逐文件回滚（改动未提交）。
