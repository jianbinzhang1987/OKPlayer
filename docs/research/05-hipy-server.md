# hipy-server 实现分析

仓库：<https://github.com/hjdhnx/hipy-server>

许可证：GPL-3.0

## 1. 项目定位

hipy-server 是一个 T4 服务后端。它将规则执行、数据管理和浏览器能力放到独立服务，再向客户端提供 HTTP 接口。

官方 README 列出的技术栈：

```text
Python
FastAPI
Redis
SQLAlchemy
PostgreSQL / MySQL / SQLite
Playwright
```

## 2. 核心架构

```text
TVBox / 桌面客户端
        ↓ HTTP/T4
hipy-server
├── FastAPI
├── 规则管理
├── 数据库
├── 缓存
├── Playwright
└── 管理 UI
```

## 3. T4 路线的优势

T4 的核心价值是将运行时与客户端解耦：

```text
客户端只处理统一 JSON
规则引擎独立升级
```

优点：

- 客户端不需要 Python；
- 规则和浏览器运行环境集中管理；
- 可以远程或本地部署；
- 容易支持 Playwright；
- 可同时服务多个客户端；
- 出错不会拖垮 Electron 主进程。

## 4. 对纯 macOS 应用的两种用法

### 方式一：外部服务

用户自行运行 hipy-server，macOS 只配置 URL。

优点：

- 实现成本最低；
- 不增大 DMG；
- GPL 隔离更清晰。

缺点：

- 用户部署门槛高；
- 不是开箱即用。

### 方式二：应用管理本地 Sidecar

应用启动一个本地服务：

```text
127.0.0.1:port
```

优点：

- 用户体验统一；
- 可运行 Playwright/Python。

缺点：

- 包体大；
- 依赖安装复杂；
- 进程管理复杂；
- 签名和公证复杂；
- GPL 合规要求高。

## 5. Playwright 嗅探

hipy-server 已将 Playwright 作为技术栈的一部分，说明它适合：

- 动态页面；
- JS 渲染；
- Cookie；
- 登录状态；
- 监听媒体请求；
- 页面脚本。

但 Playwright 不是轻量能力：

- Chromium 体积大；
- 首次下载慢；
- 资源占用高；
- 反爬和验证码仍需处理。

## 6. 与当前项目的结合方式

建议首先实现 `T4Adapter`：

```text
AppService
    ↓
T4Adapter
    ↓
远程/本地 hipy-server
```

接口至少支持：

```text
home
category
search
detail
player
proxy
```

随后再考虑轻量浏览器 Sidecar。

## 7. 优点

- T4 服务模式成熟；
- Playwright 能力强；
- Python 规则生态；
- 多数据库和缓存；
- 服务端隔离良好；
- 适合复杂源。

## 8. 缺点

- 系统较重；
- 对桌面单机应用可能过度设计；
- GPL-3.0；
- 部署与升级复杂；
- 不能直接兼容 Android JNI Spider；
- 需要额外安全边界。

## 9. 推荐使用方式

不建议直接把整个 hipy-server 打包进当前应用。

推荐：

1. 先支持外部 T4；
2. 定义统一 T4Adapter；
3. 将 BrowserSniffer 设计成独立服务；
4. 后期再评估“精简版本地 Sidecar”。

## 10. 后续跟进任务

- [ ] 梳理 T4 请求参数和响应格式；
- [ ] 实现 T4Adapter 原型；
- [ ] 使用公开测试服务做回归；
- [ ] 研究 Playwright 媒体监听；
- [ ] 评估 Sidecar 包体与内存；
- [ ] 评估 GPL 分发影响；
- [ ] 设计服务鉴权和仅本机监听。
