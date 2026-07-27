# 在线 TVBox / FongMi / 影视仓源兼容审计

> 审计日期：2026-07-26  
> 测试工程：FongMi macOS  
> 测试目的：验证公开配置的下载、解析、运行时识别、搜索、详情、播放地址和媒体内容签名。  
> 说明：本报告只记录技术兼容性和网络状态，不代表对第三方配置内容、版权状态或长期稳定性的认可。

## 1. 测试配置

| 类型 | 名称 | 地址 |
|---|---|---|
| TVBox / 综合配置 | qist `jsm.json` | `https://raw.githubusercontent.com/qist/tvbox/refs/heads/master/jsm.json` |
| FongMi / Drpy 配置 | 高天流云 `js.json` | `https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json` |
| XYQ 配置 | 高天流云 `XYQ.json` | `https://raw.githubusercontent.com/gaotianliuyun/gao/master/XYQ.json` |
| FongMi 官方开发示例 | CatVodSpider `config.json` | `https://raw.githubusercontent.com/FongMi/CatVodSpider/main/json/config.json` |
| 影视仓多仓索引 | noimank `tvboxmuti.json` | `https://gitlab.com/noimank/tvbox/-/raw/main/tvboxmuti.json` |

## 2. 四个直连配置审计

更新运行时指纹后，四个直连配置均能下载和解析：

```text
配置：4，成功：4，失败：0
站点：506
可识别：301
不可识别或 Android-only：205
配置兼容率：59.49%
```

运行时分布：

```text
Drpy          258
Android Dex   200
HTTP           15
XYQ            15
XBPQ            8
Unknown         5
JavaScript      4
AppYsV2         1
```

说明：这里的“可识别”表示客户端具备对应 Adapter，不表示每个上游站点当前都能正常返回内容。

## 3. 影视仓多仓展开结果

多仓索引顶层使用：

```json
{
  "urls": [
    { "name": "线路名称", "url": "下级配置地址" }
  ]
}
```

当前项目已支持递归识别和批量展开。将四个直连配置与该多仓索引一起审计后：

```text
配置：18
成功加载：11
失败：7
站点：1175
可识别：659
不可识别或 Android-only：516
兼容率：56.09%
```

失败的 7 条下级配置主要原因：

- 连接超时；
- HTTP 404；
- 返回 HTML 页面而不是 JSON；
- 代理地址返回附加 Hash 或损坏内容；
- 返回非 UTF-8 或不可解析内容。

## 4. 配置级结论

### 4.1 qist `jsm.json`

```text
站点总数：156
已识别运行时包括：HTTP、Drpy、XBPQ、XYQ、AppYsV2、JavaScript
```

适合作为综合兼容回归配置，但其中混有大量具体 Android CSP、失效接口和需要专用解析器的站点。

### 4.2 高天流云 `js.json`

```text
站点总数：298
可识别站点：约 227（运行时指纹修正前统计）
主要运行时：Drpy
```

适合作为 Drpy 批量兼容回归配置。部分站点受 HTTP 403、域名失效、上游反爬或模板依赖影响。

### 4.3 高天流云 `XYQ.json`

```text
站点总数：49
可识别站点：19（首轮统计）
主要运行时：Drpy、XYQ
```

该配置包含 `//` 注释和尾逗号，原严格 JSON 解析会失败。项目现已支持安全的宽松 JSON/JSON5 解析。

### 4.4 FongMi CatVodSpider 官方示例

```text
站点总数：3
当前可运行：0
```

三个站点为 `csp_Local`、`csp_Market`、`csp_Push`，依赖 Android JAR/CSP。该文件适合协议开发参考，不适合作为 macOS 实际影视源。

### 4.5 noimank 影视仓多仓

多仓索引本身当前可下载，项目已能识别并展开其 `urls`。下级配置存在明显时效差异，必须逐条审计，不能仅依据多仓索引可访问就判断全部可用。

## 5. 实际业务链测试

### 5.1 已完成真实 HLS 播放链

#### 非凡资源

```text
搜索关键词：庆余年
搜索结果：8 条
测试影片：庆余年第二季粤语
详情：2 条线路、62 集
测试线路：ffm3u8
测试剧集：第01集
媒体探测：HTTP 206
Content-Type：application/vnd.apple.mpegurl
格式：HLS
结果：通过
```

播放会话：

```text
resolvedBy：direct
format：hls
engine：web
playbackUrl：fongmi-media://session/.../resource/root
```

说明：搜索、详情、Resolver、媒体签名验证和内置播放会话均完成。

#### 尤酷资源

```text
搜索结果：3 条
详情：2 条线路、72 集
抽样 HLS：HTTP 206
媒体格式：HLS
结果：通过
```

#### 极速资源

```text
搜索结果：8 条
详情：2 条线路、72 集
抽样 HLS：HTTP 200
媒体格式：HLS
结果：通过
```

### 5.2 部分可用或需要嗅探

#### qist 飞飞 AppYsV2

```text
搜索“庆余年”：3 条
详情：1 条线路、46 集
剧集地址：加密标识
```

搜索与详情可用，但最终播放需要站点解析接口或浏览器嗅探，CLI 无法仅靠通用 JSON 解析器确认最终媒体。

#### qist 爱奇艺 Drpy

```text
搜索“庆余年”：24 条
详情：1 条线路、15 集
第一集：爱奇艺网页地址
```

Drpy 搜索与详情可用，播放需要网页嗅探。统一播放服务已修正为：明显网页地址直接进入 BrowserSniffer，而不是误当媒体直链。

#### qist 杯狐 Drpy

```text
搜索“庆余年”：2 条
详情元数据：可用
线路与剧集：0
```

当前规则只能返回元数据，没有生成播放列表。

### 5.3 已确认失效或异常的抽样线路

#### 量子资源

```text
搜索“庆余年”：3 条
详情：2 条线路、72 集
liangzi 分享页：HTTP 404
lzm3u8 第一集：HTTP 404
```

配置接口仍能搜索和返回详情，但抽样播放地址已经失效。项目现会在创建播放会话前探测明显媒体直链，404、410、HTML 和格式不匹配会明确报告线路失效。

#### 其他 HTTP 抽样

- 天涯：搜索接口返回“暂不支持搜索”；
- 电影天堂：搜索接口返回 HTML；
- 卧龙：搜索接口返回 HTML/异常响应；
- 小绵阳、金蝉、789：连接失败；
- 索尼：本次关键词返回 0 条。

### 5.4 Drpy 上游异常抽样

- 芒果：HTTP 403；
- 路漫漫：HTTP 403；
- NT 动漫：HTTP 444；
- 海洋听书：网络请求失败；
- 部分规则返回 0 条，但运行时执行未报错。

## 6. 本次发现并修复的问题

### 6.1 宽松配置格式

新增支持：

- `//` 行注释；
- `/* */` 块注释；
- 尾逗号；
- 单引号；
- 未加引号的对象键；
- UTF-8 BOM。

### 6.2 影视仓多仓索引

新增：

- `urls` 顶层格式识别；
- 相对地址解析；
- 多仓递归展开；
- 最大深度和最大配置数量限制；
- 下级配置独立失败记录。

### 6.3 Clash/TUN Fake-IP

本机 DNS 将公网域名解析为：

```text
198.18.0.0/15
fdfe:dcba:9876::/48
```

原安全策略把这些地址误判为内网。现在：

- 用户直接配置私网 IP 仍然阻断；
- localhost、链路本地、真实 RFC1918 地址仍然阻断；
- 公网域名仅解析到已知 Clash Fake-IP 池时允许交给系统代理；
- 其他私网 DNS 解析仍阻断。

修复后杯狐和优酷等公网 Drpy 站点能够正常请求。

### 6.4 Drpy 宿主兼容

新增：

- `play_url` 全局变量；
- `urlencode`、`encodeUrl`、`decodeUrl`；
- 通用远程 JS 引擎 + JS 规则的 Drpy 指纹识别；
- 整体 Base64 编码规则脚本识别和解码。

### 6.5 播放地址验证

统一播放准备阶段新增：

- 明显网页播放地址自动进入 BrowserSniffer；
- 明显媒体直链先进行内容签名探测；
- HTTP 404/410、HTML 伪媒体、格式不匹配直接判定线路失效；
- 403、超时、一次性鉴权等不确定失败仍保留兼容回退。

## 7. 当前建议

用于实际测试和产品演示时，优先选择已经通过完整播放链的站点，而不是把整个公开配置视为统一质量：

```text
非凡资源
尤酷资源
极速资源
```

用于兼容开发和回归时：

```text
qist jsm.json          综合运行时样本
高天流云 js.json       Drpy 样本
高天流云 XYQ.json      XYQ / 宽松 JSON 样本
noimank tvboxmuti.json 影视仓多仓样本
```

公开源高度依赖第三方域名、接口和解析规则，应定期复测，不建议把未经验证的整份配置直接作为默认内置源。
