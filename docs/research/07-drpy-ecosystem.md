# drpy / T3 / T4 生态实现分析

## 1. 为什么 drpy 值得优先

drpy 规则的核心价值是：

```text
用 JavaScript 描述站点规则
    ↓
宿主提供网络、解析、Cookie、加密等能力
    ↓
统一输出 home/category/search/detail/player
```

相比 Android Dex/JAR：

- 跨平台；
- 可审计；
- 可调试；
- 可放在 Worker；
- 更新方便；
- 不依赖 Android ARM `.so`。

## 2. 公开实现线索

目前最成熟、持续维护且可直接核验的桌面实现是 zyfun，它明确支持：

```text
T4_DRPYS
T3_DRPY
T4_CATVOD
T3_XBPQ
T3_XYQ
T3_APPYSV2
T3_PY
T3_ALIST
```

原 `drpy-node` 主仓的公开可访问状态不稳定，因此当前调研不建议将其作为唯一上游依赖。

## 3. 建议的 DrpyAdapter 架构

```text
DrpyAdapter
├── RuleLoader
├── WorkerPool
├── HostRequest
├── CookieJar
├── CryptoHost
├── HtmlParser
├── LocalStorage
├── Proxy
├── Cache
└── Logger
```

## 4. Worker 隔离

每个规则不能直接共享全局上下文。

建议：

```text
规则文件
    ↓ hash
Provider Worker
    ↓
初始化缓存
    ↓
方法调用
```

需要：

- 超时；
- 最大内存；
- 取消；
- 初始化失败熔断；
- Worker 重建；
- 日志关联 siteKey；
- 禁止任意文件系统访问；
- 限制网络访问策略。

## 5. 宿主 API

第一阶段至少需要：

```text
request / fetch
get / post
setCookie / getCookie
base64
md5 / sha1 / sha256
AES / DES / RSA（按实际规则补）
HTML selector
JSONPath
URL
localStorage
proxy
```

不要一开始实现全部 drpy API，应采用：

```text
真实规则驱动兼容
```

每增加一个真实测试源，再补对应 API。

## 6. T3 与 T4 的关系

### T3 本地执行

```text
macOS
    ↓
本地规则 Worker
```

优点：

- 离线；
- 延迟低；
- 无额外服务。

缺点：

- 宿主 API 兼容成本高；
- 不可信规则安全风险。

### T4 服务执行

```text
macOS
    ↓ HTTP
T4 服务
```

优点：

- 客户端简单；
- 规则更新独立；
- 可使用 Python/Playwright。

缺点：

- 需要服务；
- 可能存在隐私和可用性问题。

建议两者都支持：

```text
优先 T4 兼容
逐步实现本地 T3 Drpy
```

## 7. XBPQ、XYQ、APPYSV2

这些属于不同规则描述或适配器生态，不应强行全部塞进 DrpyAdapter。

建议：

```text
RuleProvider
├── DrpyAdapter
├── XbpqAdapter
├── XyqAdapter
└── AppYsV2Adapter
```

共享：

- 网络；
- Cookie；
- 缓存；
- 解析；
- 播放模型。

## 8. 当前项目建议

近期优先级：

1. T4Adapter；
2. DrpyAdapter MVP；
3. BrowserSnifferAdapter；
4. XBPQ；
5. XYQ；
6. Python；
7. Desktop Java；
8. Android Bridge。

## 9. 后续跟进任务

- [ ] 收集 3 个公开 drpy 测试规则；
- [ ] 定义 DrpyAdapter 接口；
- [ ] 建立 Worker RPC；
- [ ] 接入 CookieJar；
- [ ] 接入 HTML 解析器；
- [ ] 建立宿主 API 兼容清单；
- [ ] 完成 search/detail/player 最小闭环；
- [ ] 与 zyfun 的 T3Drpy 行为做黑盒对比。
