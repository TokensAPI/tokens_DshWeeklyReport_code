export const DEMO_CHART_URL = '/__weekly_demo__/inventory.svg';
export const DEMO_CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="280" viewBox="0 0 800 280"><rect width="800" height="280" rx="12" fill="#f0f5f1"/><g font-family="sans-serif" fill="#285548"><text x="36" y="40" font-size="22">Inventory trend · DEMO ONLY</text><text x="36" y="68" font-size="14">Illustration, not market data</text><path d="M55 90V228H750" stroke="#b7c9be" fill="none"/><path d="M60 120L195 138L330 128L465 174L600 181L740 211" stroke="#35785b" stroke-width="4" fill="none"/><g font-size="14"><text x="55" y="253">W1</text><text x="190" y="253">W2</text><text x="325" y="253">W3</text><text x="460" y="253">W4</text><text x="595" y="253">W5</text><text x="730" y="253">W6</text></g></g></svg>`;
export const DEMO_CHART_DATA = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DEMO_CHART_SVG);
export const editorPlayground = `
## 八、编辑体验区（全部为模拟样例）

可以修改下面的任意内容，再切换 Markdown 或 PDF 实时浏览对照。图片为插件内置示意图，不发起外部网络请求。

### 8.1 行内格式与链接

这是**粗体结论**、*斜体补充*、~~已撤回的判断~~与行内代码 \`inventory_delta\`。选择文字试试工具条，也可以编辑[研究方法示例链接](https://example.com/research)。

#### 四级标题：口径说明

库存变化包含统计范围变化，暂不能直接解释为消费变化。

##### 五级标题：核验细节

同一仓库、同一时点对齐后，再比较环比变化。

###### 六级标题：记录备注

这是一段可直接修改的普通正文。按 Enter 拆段，试试撤销和重做。

### 8.2 清单与嵌套列表

- [x] 核对样例价格单位
- [ ] 补充下游订单证据
- [ ] 复核库存统计范围

- 供应跟踪
  - 检修计划：模拟厂 A 下周恢复
  - 原料到货：样例到港量增加
- 需求跟踪
  1. 收集样例订单
  2. 对照开工变化

### 8.3 引用与代码

> 模拟访谈：订单略有恢复，但尚未观察到持续补库。
>
> 请将这一段改写为你自己的核验结论。

\`\`\`python
# 仅演示代码排版，不会执行
inventory_now = 8420
inventory_before = 8760
change_pct = (inventory_now / inventory_before - 1) * 100
print(round(change_pct, 2))
\`\`\`

---

### 8.4 表格与图片

| 核验项目 | 负责人（模拟） | 状态 |
| --- | --- | --- |
| 库存口径 | 研究员甲 | 待核对 |
| 订单样本 | 研究员乙 | 已补充 |

可以修改单元格，新增或删除行列；在图片下修改说明文字或图片地址。

![模拟库存走势：六周示意图](${DEMO_CHART_URL})

### 8.5 保留语法对照

此处保留一个脚注示例[^demo]，用于观察暂未适配的内容如何保留。它不参与模拟行情结论。

[^demo]: 编辑器保留此原始语法；可在 CodeMirror 中修改。
`;
