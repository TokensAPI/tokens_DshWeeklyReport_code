# 周报工作台样式约定

## 命名与边界

业务组件统一使用 `rr-` 前缀（report review）；语义块如 `rr-workspace`、`rr-sidebar`、`rr-report-header`、`rr-canvas`、`rr-inspector`。修饰类采用 `rr-button--primary`、`rr-button--danger`；选中和展开状态使用 `aria-current`、`aria-pressed`、`data-focus`、`hidden`。

静态布局、颜色、边框、字体写在 `src/workspace.css`，不在 JSX 增加内联样式。CodeMirror 自身提供的 `.cm-*` 类属于编辑器 API，其主题扩展只使用 `--rr-*` 变量。不要重命名编辑器内部类。

所有业务选择器使用 `rr-` 前缀，通用元素规则必须限定在 `.rr-workspace` 下。不要覆盖全局 `body`、宿主布局、标题栏高度或宿主 `--theme-*` 定义。模态使用原生 `dialog.showModal()`，进入浏览器顶层并隔离背景焦点；不在交互祖先上增加 `backdrop-filter`。

## 主题契约

| 工作台别名 | 宿主语义变量 |
| --- | --- |
| `--rr-canvas` / `--rr-shell` | `--theme-bg-canvas` / `--theme-bg-shell` |
| `--rr-paper` / `--rr-raised` | `--theme-bg-surface` / `--theme-bg-surface-raised` |
| `--rr-text` / `--rr-muted` | `--theme-fg-primary` / `--theme-fg-secondary` |
| `--rr-border` | `--theme-border-default` |
| `--rr-accent` / `--rr-fill` | `--theme-accent-primary` / `--theme-accent-fill` |
| `--rr-on-accent` / `--rr-selection` | `--theme-fg-on-accent` / `--theme-accent-soft` |
| 状态色 | `--theme-danger` / `--theme-success` / `--theme-info` |
| 字体、圆角、过渡 | 对应 `--theme-font-*` / `--theme-radius-*` / `--theme-duration-*` |

宿主更新 `data-theme` 和 `data-color-scheme` 后，由 CSS 继承即时更新，无 JS 主题枚举、监听器或编辑器重建。新增宿主主题只需满足相同契约。没有宿主变量时，使用 `light-dark()` 跟随系统的研究纸面/暗色回退（Chromium 123+）。显式宿主明暗设置优先于系统，包括原生输入框与日期控件。

不复制参考项目的全局 `.theme-card` 规则，避免其悬浮位移、裁剪及背景特效影响长文编辑。复用的是配色、圆角、字体与交互状态契约。

工作台背景必须不透明：canvas、shell、paper、raised 保留宿主 RGB 色值，以 CSS 相对颜色强制 alpha 为 1，避免玻璃主题透出底层会话。Markdown 编辑器高亮使用语义主题颜色，不改变字号或行高。模板选择、名称输入与操作按钮统一 40px 高。

## 布局与可访问性

生成页隐藏右侧审阅区，编辑页使用桌面左导航 208px、右审阅 302px；980px 以下审阅落到正文后；650px 以下导航堆叠，正文独立滚动。专注模式保留同一个编辑器，只收起两侧。按钮至少 40px 高，键盘焦点可见，减少动态效果设置禁用过渡。正文标题用本机宋体回退，不依赖外部字体请求。

Markdown 实时浏览、PDF 实时浏览均在进入时自动开启专注，用户仍可手动退出专注。Markdown 源码和阅读区按源码行号双向同步滚动；手机宽度分栏改为上下排列。

根目录 `npm run test:client` 检查真实浏览器中的主题切换、布局溢出、编辑器实例保持、冲突保护、原版确认发布顺序及只读核对。截图仅代表浏览器；宿主 Electron 窗口材质与真实 PDF 渲染需在部署后验收。
