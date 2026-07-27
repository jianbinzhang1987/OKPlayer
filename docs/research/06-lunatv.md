# LunaTV / MoonTV 实现分析

仓库：<https://github.com/MoonTechLab/LunaTV>

许可证：仓库声明为 CC BY-NC-SA，禁止商业化并要求衍生项目按相同协议开放。

## 1. 项目定位

LunaTV 是 Web 化、自托管的聚合播放器：

- Next.js 14；
- Tailwind CSS；
- TypeScript；
- HLS.js；
- ArtPlayer；
- Docker；
- Redis/Kvrocks/Upstash。

它不是 TVBox Spider Runtime，而是标准数据源聚合与 Web 播放器。

## 2. 核心架构

```text
浏览器/PWA
    ↓
Next.js
├── 多源搜索
├── 详情
├── 收藏/历史
├── HLS.js
├── ArtPlayer
└── Redis/Kvrocks
```

## 3. 可借鉴部分

### 3.1 聚合搜索 UI

- 多源结果；
- 卡片展示；
- 响应式布局；
- 用户历史和收藏。

### 3.2 Web 播放器

- HLS.js；
- ArtPlayer；
- 跳过片头片尾；
- 去广告实验；
- PWA。

### 3.3 存储

支持多个远程存储后端，适合跨设备同步。

## 4. 不能解决的问题

- 不执行 CatVod Android JAR；
- 不执行 Dex/JNI；
- 不提供完整 drpy Runtime；
- 不等同于 T4 Provider；
- 主要依赖用户自行配置标准资源。

## 5. 对当前项目的价值

主要用于参考：

- Web 播放器降级；
- 多源搜索 UI；
- 历史/收藏同步；
- 切片广告过滤；
- PWA 或 Web 管理端。

不建议将其作为当前 Provider 主引擎。

## 6. 许可证风险

其许可证明确限制商业化。即使当前项目暂不商业化，也不应直接复制：

- 页面代码；
- 播放组件封装；
- 服务端代码。

可以借鉴产品思路，但需要自行实现。

## 7. 后续跟进任务

- [ ] 研究 HLS.js/ArtPlayer 请求头限制；
- [ ] 研究切片广告过滤思想；
- [ ] 研究跨设备历史同步模型；
- [ ] 不直接复制受非商业许可证限制的源码；
- [ ] 将其定位为 UI/播放器参考，而非源运行时参考。
