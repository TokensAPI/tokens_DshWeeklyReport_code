# TokensCowork 周报插件

`@tokensapi/dsh-weekly-report` 将交接包中的五个 RUN-19 模块整理成一个可安装的
DSH bundle：安装后自动登记 Host 组合与 Web Client，不需要把开发机绝对路径写入
Profile。包保留原始源码、文档、作者署名和已有许可证。

## 功能

当前适配版：`0.1.1`，合并原开发人员的「周报插件 V1.1」；变更及适配说明见 [CHANGELOG.md](CHANGELOG.md)。

- 从本机 loopback 数据服务生成 Markdown 与图表。
- 持久化工作稿、修订、人工重点和确认版本。
- 生成 PDF 预览。
- 在会话标题区提供“生成周报”审阅界面。
- 可选连接 WeKnora；真实写入只在明确的人类发布操作后发生。

## 安装

通过 TokensCowork 插件市场安装后重启应用。手工验证包时只在测试 Profile 中执行：

```powershell
dsh plugin --profile weekly-report-test add C:\path\to\tokensapi-dsh-weekly-report-0.1.1.tgz
```

默认可加载核心、生成器、PDF 服务和审阅界面。WeKnora 连接器默认关闭，避免在未配置
凭证和知识库白名单时启动。数据默认写到
`%USERPROFILE%\.tokenscowork\weekly-report`（其他系统为用户主目录下同名目录）。

## 运行时配置

可在启动 TokensCowork 前设置环境变量，或在独立 Profile 的 `cordis.patch.yml` 中按
下方行 id 覆盖配置。不要把密钥内容写进补丁；连接器只接受密钥文件路径。

| 环境变量 | 用途 |
| --- | --- |
| `TOKENSCOWORK_WEEKLY_REPORT_HOME` | 插件数据根目录 |
| `TOKENSCOWORK_WEEKLY_REPORT_DATA_DIR` | 工作稿与资产目录 |
| `TOKENSCOWORK_WEEKLY_REPORT_OUTPUT_DIR` | 生成器输出目录 |
| `TOKENSCOWORK_WEEKLY_REPORT_PYTHON` | 已配置 Python 解释器 |
| `TOKENSCOWORK_WEEKLY_REPORT_FONT_PATH` | PDF 使用的字体文件 |
| `TOKENSCOWORK_WEEKLY_REPORT_CONNECTOR_ENABLED=1` | 启用 WeKnora 连接器 |
| `TOKENSCOWORK_WEEKLY_REPORT_WEKNORA_URL` | WeKnora HTTP(S) 地址 |
| `TOKENSCOWORK_WEEKLY_REPORT_READ_SECRET_FILE` | 只读密钥文件路径 |
| `TOKENSCOWORK_WEEKLY_REPORT_WRITE_SECRET_FILE` | 发布密钥文件路径，必须与只读密钥分离 |
| `TOKENSCOWORK_WEEKLY_REPORT_ALLOWED_KBS` | 逗号分隔的知识库 ID 白名单 |
| `TOKENSCOWORK_WEEKLY_REPORT_TENANT_ID` | 可选租户 ID |
| `TOKENSCOWORK_WEEKLY_REPORT_PUBLISH_KB_ID` | 审阅发布目标知识库 ID |

Profile 覆盖示例（值均为占位符）：

```yaml
- id: tokens-weekly-report-weknora
  config:
    enabled: true
    baseUrl: https://weknora.example.internal
    readSecretFile: C:\secure\weekly-report-read.key
    writeSecretFile: C:\secure\weekly-report-write.key
    allowedKbs: [kb-example]
    assetRoots: [C:\Users\example\.tokenscowork\weekly-report\data]
- id: tokens-weekly-report-review
  config:
    publishKbId: kb-example
```

发布会调用外部 WeKnora，可能触发上传、解析、向量化、摘要、标签或计费。适配测试不使用
真实账号、不执行真实写入。生成器还需要本机 `127.0.0.1:5100` 数据服务及带 Matplotlib
等依赖的 Python 环境；PDF 需要 PyMuPDF 和可用字体。

## 兼容性与限制

- 目标：TokensCowork 0.5.1 / DSH runtime 0.1.5-rc.2，Node 22.19+ 或 24+。
- 交接代码本身标记为 engineering preview；真实 GUI 重启、真实 WeKnora 写入与完整图片
  发布尚未由原作者验收。
- WeKnora 连接器仍是单用户 pilot，不是多用户授权系统。
- PyMuPDF 为 AGPL-3.0/商业双许可证，部署前必须完成许可证决策。
- 三个源模块缺少明确源码许可证；发布前必须由权利人补充或确认再分发授权。

原始设计和安全说明保存在各 `README*.original.md` 中。
