# TokensCowork 周报插件

`@tokensapi/dsh-weekly-report` 将交接包中的五个 RUN-19 模块整理成一个可安装的
DSH bundle：安装后自动登记 Host 组合与 Web Client，不需要把开发机绝对路径写入
Profile。包保留原始源码、文档、作者署名和已有许可证。

## 功能

当前适配版：`0.1.5`，合并原开发人员的「周报插件 V1.1」；变更及适配说明见 [CHANGELOG.md](CHANGELOG.md)。

- 从本机 loopback 数据服务生成 Markdown 与图表。
- 持久化工作稿、修订、人工重点和确认版本。
- 生成 PDF 预览。
- 在会话标题区提供“生成周报”审阅界面。
- 可选连接 WeKnora；真实写入只在明确的人类发布操作后发生。

## 安装

通过 TokensCowork 插件市场安装后重启应用。手工验证包时只在测试 Profile 中执行：

```powershell
dsh plugin --profile weekly-report-test add C:\path\to\tokensapi-dsh-weekly-report-0.1.5.tgz
```

默认可加载核心、生成器、PDF 服务和审阅界面。WeKnora 连接器默认关闭，避免在未配置
凭证和知识库白名单时启动。数据默认写到
`%USERPROFILE%\.tokenscowork\weekly-report`（其他系统为用户主目录下同名目录）。

## Python 环境（零配置）

生成器需要 Matplotlib，PDF 需要 PyMuPDF。0.1.5 起插件自动解决 Python 环境，新机器
默认无需任何配置：

1. 显式配置最优先：环境变量 `TOKENSCOWORK_WEEKLY_REPORT_PYTHON` 或按行 `python` 配置，
   一旦设置不做任何探测和校验。
2. 未显式配置时，首次启动自动探测常见解释器（托管 venv、`python3`/`python`、Homebrew、
   系统 Python），选第一个同时具备 Matplotlib 与 PyMuPDF 的并缓存到
   `<插件目录>/python-runtime.json`。
3. 都不具备时，自动用现有 Python 在 `<插件目录>/venv` 创建托管 venv 并在后台
   `pip install matplotlib pymupdf`（尊重 `PIP_INDEX_URL`，国内可设 pypi 镜像）。安装期间
   生成会短暂失败，完成后无需重启即可用；进度与失败原因见 `<插件目录>/python-setup.log`。
4. 机器上完全没有 Python 时无法自举，需安装 Python 3.9+ 后重启（macOS 系统自带）。

数据服务（默认 `127.0.0.1:5100`）与 WeKnora 属外部服务，插件不代为部署。

## 运行时配置

可在启动 TokensCowork 前设置环境变量，或在独立 Profile 的 `cordis.patch.yml` 中按
下方行 id 覆盖配置。不要把密钥内容写进补丁；连接器只接受密钥文件路径。

| 环境变量 | 用途 |
| --- | --- |
| `TOKENSCOWORK_WEEKLY_REPORT_HOME` | 插件数据根目录 |
| `TOKENSCOWORK_WEEKLY_REPORT_DATA_DIR` | 工作稿与资产目录 |
| `TOKENSCOWORK_WEEKLY_REPORT_OUTPUT_DIR` | 生成器输出目录 |
| `TOKENSCOWORK_WEEKLY_REPORT_PYTHON` | 显式指定生成器与 PDF 共用的 Python 解释器；未设置时走上文自动探测/自建 venv |
| `TOKENSCOWORK_WEEKLY_REPORT_FONT_PATH` | PDF 使用的字体文件 |
| `TOKENSCOWORK_WEEKLY_REPORT_ASSET_ROOTS` | 逗号分隔的额外资产根目录；旧安装（如 `~/.dsh/report-review/data`）生成的草稿要继续导出 PDF 时加在这里 |
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

指定 Python 时建议优先用环境变量 `TOKENSCOWORK_WEEKLY_REPORT_PYTHON`（一处生效于生成器和
PDF 两行）。改用 Profile 补丁时，`python` 与 `pythonPath` 两个键名在两行上互为别名，写任一
个即可，但两行都要写（覆盖已注册行必须用顶层 `- id:`，不要用 `- insert:`，否则会报
`duplicate loader entry id`）：

```yaml
- id: tokens-weekly-report-source
  config:
    python: /path/to/venv/bin/python
- id: tokens-weekly-report-pdf
  config:
    python: /path/to/venv/bin/python
```

生成失败时错误会带出内部原因代码，如 `SOURCE_FAILED(cause=GENERATION_FAILED)`（Python 进程
非零退出，常见原因是解释器缺依赖）、`cause=GENERATION_TIMEOUT`（超时）、`cause=ENOENT`
（Python 路径不存在）；详细 stderr 仍不对外暴露，只落在运行目录的诊断里。

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

## 周报工作台 UI 开发

现已试接入 BlockNote 可视化块编辑器，默认直接编辑排版后的正文，保留 Markdown 源码入口。未修改块复用原始 Markdown，复杂语法以保留块展示；实现范围、限制和验收记录见 [BLOCK-EDITOR.md](packages/report-review/BLOCK-EDITOR.md)。

「可视化编辑」固定使用 BlockNote；Markdown 与 PDF 实时浏览使用 CodeMirror 编辑源码。模式与转换逻辑见 [EDITOR-COMPARISON.md](packages/report-review/EDITOR-COMPARISON.md)。

进入本地演示，点击「新建完整演示周报」可体验六级标题、嵌套列表、任务清单、引用、代码、分隔线、表格和图片说明/地址编辑。原有草稿保留；有未保存修改时先保存。内置图片支持离线预览和演示 PDF，其他图片资产预览与上传尚未接入。

宿主兼容基线为 React/React DOM 18.3.1，Mantine 使用 8.3.18。插件必须复用 DSH 提供的 `react`、`react-dom` 和 `react-dom/client`，不能捆绑自己的 React DOM。客户端测试包含最终构建包的宿主加载回归。

工作台支持生成/编辑分步流程、隔离的本地演示、Markdown 语法高亮、源码与阅读预览双向同步滚动、PDF 分栏及导出。进入两种浏览模式时自动专注正文，面板保持不透明。原版人工修改归因保留，尚无评论线程。

统一在仓库根目录使用 npm，不再维护 report-review 子包的独立 pnpm 构建：

```sh
npm ci
npm run build
npm run check
npm run test:client
npm test
```

浏览器测试默认使用本机 Chrome，可设置 `BROWSER_CHANNEL=msedge`。PDF 测试需要设置 `RUN19_PYTHON` 指向包含 PyMuPDF 的 Python；`RUN19_FONT` 指定中文字体。两项历史数据集成测试还依赖原始交接的 `packages/weekly-report-source/validation/weekly-8V6p06/` 样例目录（未纳入 Git）。测试截图和样例均不进入发布包。

客户端从 `src/entry.jsx` 构建，保留原生侧栏入口；使用根包标识 `@tokensapi/dsh-weekly-report` 和宿主提供的 UI primitives。UI 说明见 `packages/report-review/FUNCTION-PARITY.md`。
