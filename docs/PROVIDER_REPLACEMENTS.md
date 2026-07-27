# 替代 Provider 注册表

## 1. 目标

替代 Provider 注册表用于处理具体 Android Spider：

```text
原站点：csp_NewSomethingGuard + Android Dex/JAR
        ↓ 精确匹配
替代实现：HTTP / Drpy / XYQ / XBPQ / CatOpen / T4 / Alist
        ↓
继续使用原站点 key 和 name，对 UI 与历史记录保持透明
```

注册表不模拟 Android，也不自动猜测替代关系。只有经过能力、许可证和真实链路验证的条目才能进入默认注册表。

当前内置 `DEFAULT_PROVIDER_REPLACEMENTS` 保持为空，项目不会默认启用未经验证的第三方替代源。

## 2. 注册表格式

注册表可以直接使用数组，也可以使用带 `replacements` 字段的对象：

```json
{
  "replacements": [
    {
      "id": "example-replacement",
      "enabled": true,
      "match": {
        "api": "csp_NewExampleGuard",
        "jarHash": "可选的原 Spider MD5"
      },
      "replacement": {
        "runtime": "catopen",
        "api": "https://example.com/provider.js",
        "ext": "可选扩展参数",
        "header": {
          "User-Agent": "可选请求头"
        }
      },
      "capabilities": {
        "home": true,
        "category": true,
        "search": true,
        "detail": true,
        "player": false,
        "proxy": false,
        "health": false
      },
      "source": {
        "name": "替代实现名称",
        "repository": "https://example.com/repository",
        "license": "MIT",
        "verifiedAt": "2026-07-26"
      },
      "notes": "该替代实现只提供元数据，不提供播放能力"
    }
  ]
}
```

## 3. 匹配规则

- `match.api` 使用精确匹配，忽略大小写；
- 不进行包含、前缀或相似名称匹配；
- 配置了 `jarHash` 时，原站点的 `jar` 必须包含相同的 `;md5;<hash>`；
- `enabled=false` 的条目不会生效；
- 多个条目匹配同一个站点时，使用注册表中第一个有效条目；
- 替代后仍保留原站点的 `key`、`name`、超时、搜索开关和其他业务配置。

## 4. 支持的替代运行时

```text
http
javascript
drpy
t4
appysv2
xbpq
xyq
catopen
alist
```

不允许将替代目标配置为：

```text
android-dex
unknown
```

## 5. 能力裁剪

`capabilities` 用于表达替代实现与原 Spider 的能力差异。

例如替代源只提供豆瓣推荐、搜索和详情，但没有播放能力：

```json
{
  "capabilities": {
    "home": true,
    "category": true,
    "search": true,
    "detail": true,
    "player": false
  }
}
```

客户端会在播放源页面展示实际能力，并在调用被禁用能力时返回明确错误，而不是静默失败。

## 6. 应用内导入

在应用中进入：

```text
设置 → 替代 Provider 注册表
```

填写本地 JSON 文件路径或远程 HTTP/HTTPS 地址后点击“加载注册表”。

应用行为：

- 先下载并验证注册表结构；
- 保存注册表来源到 SQLite；
- 销毁当前 Adapter 和子进程；
- 清空 Provider LRU 缓存；
- 使用新注册表重新创建当前配置的站点；
- 启动时先恢复注册表，再恢复活动配置；
- 加载或重建失败时回滚到旧注册表；
- 点击“清除”后恢复内置默认注册表。

播放源页面会展示已经应用的替代来源和许可证。

## 7. 审计命令

单配置应用注册表：

```bash
npm run audit:config -- <配置> --registry <注册表.json>
```

批量配置审计：

```bash
npm run audit:config:batch -- \
  --list <配置地址清单.txt> \
  --registry <注册表.json> \
  --top 30
```

JSON 输出：

```bash
npm run audit:config:batch -- \
  --list <配置地址清单.txt> \
  --registry <注册表.json> \
  --json \
  --output compatibility-report.json
```

批量报告会输出：

- 配置加载成功和失败数量；
- 总站点数及整体兼容率；
- 各运行时分布；
- 已应用替代 Provider 数量；
- Android-only API 出现次数；
- 每个 API 覆盖的配置数量和站点名称。

## 8. 进入默认注册表的验收条件

每个候选条目至少需要确认：

1. 替代实现的功能边界；
2. 首页、搜索、详情、播放、代理等能力是否与声明一致；
3. 开源许可证和分发方式；
4. 是否需要 Cookie、登录或用户凭据；
5. 是否包含不稳定的硬编码接口；
6. 是否通过固定样本和在线样本回归；
7. 失效时能否快速禁用或撤回；
8. 替代实现是否会执行未经隔离的远程代码。

未经上述验证的候选只能用于本地审计或手动测试，不能加入默认注册表。
