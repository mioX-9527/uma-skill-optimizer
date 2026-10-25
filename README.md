# uma-skill-optimizer · 赛马娘技能PT规划器

> 按你的**实际 PT 预算**,基于[ uma-race-sim ](../uma-race-sim)赛道模拟引擎,求**马身收益最大**的技能购买组合。

育成完一匹马后,技能购买界面里每项技能都有一个"实际价格"(hint/继承等折扣因号而异)。本工具以这些**实际价格**为输入,在预算内搜索购买组合——目标不是评价点,而是**比赛里能快多少个马身**(社区同类工具都只做评价点最大化,这里直接用赛道模拟做目标函数)。

## 状态

v0.1(命令行 + 网页版)已跑通:

- **网页版**(推荐):`npm run web` 或双击 `打开规划器.bat` → http://localhost:5183 。配置面板(赛道筛选/五维/跑法/适性/干劲)、技能搜索添加(中/日/繁模糊匹配,pt 可逐条改)、一键计算(Worker 后台跑,不卡界面)、结果表格(推荐清单 + 未上车分类)、计划 JSON 导入导出(与 CLI 同格式)、配置自动保存在浏览器本地
- **优化器**:贪心(按 马身/PT 效率,每装入一项重算全部候选边际)+ 交换局部搜索 + 预算回填。技能收益**非加性**(加速技能互相重叠、回体改变发动位置等),因此组合评估全部走真实模拟,单次模拟 ~1.3ms,31 候选全流程 ~2s
- **引擎**:vendor 自 [mioX-9527/uma-race-sim](https://github.com/mioX-9527/uma-race-sim)(单马确定性期望模型;引擎/分析源码与技能/赛道数据通过 `npm run sync` 从本地 uma-race-sim 仓库同步)
- **马身口径**:与 uma-race-sim 的消融分析一致(Δ时间 × 末速 ÷ 2.5 米)
- **输出**:推荐购买清单(按购入顺序,含 单独马身/集内边际 两列)、未购买技能及原因(超预算/无正收益/被挤出,含"再差多少 PT 能上车")、技能间交互差值如实展示

## 用法

**双击即用(免安装)**:根目录的 [`打开规划器.html`](打开规划器.html) 是单文件构建产物,双击直接在浏览器打开即可(无需 Node;此模式下优化器在主线程运行,计算时界面会短暂停顿)。

**网页版**(开发/流畅模式):

```bash
npm run web        # 或双击 打开规划器.bat
```

**命令行版**:

```bash
npm install
npm run sync        # 从 ../uma-race-sim 同步引擎与数据(可用 --from <路径> 指定)
npm test
npm run optimize -- --input examples/input.example.json [--budget 1000] [--out result.json]
```

> 引擎或数据更新后跑 `npm run web:standalone` 重新生成 打开规划器.html。

输入 JSON 格式(完整示例见 [`examples/input.example.json`](examples/input.example.json)):

```jsonc
{
  "course": "东京 草 2400m",          // 赛道名或 id(如 c10606)
  "budget": 1000,                     // PT 预算(硬约束)
  "runner": {                         // 面板(育成结果 + 因子 + 绿技能前提值)
    "stats": { "speed": 1200, "stamina": 1000, "power": 1100, "guts": 700, "wisdom": 900 },
    "tactic": "senko",                // nige/senko/sashi/oikomi
    "distanceAptitude": "A",
    "surfaceAptitude": "A",
    "motivation": "normal"
  },
  "skills": [                         // 候选技能,pt 填游戏内实际显示价
    { "name": "中距离直线◎", "pt": 180 },  // 名称匹配(有歧义时请用 id)
    { "id": "901121", "pt": 120 }
  ]
}
```

注意事项:

- **pt 请填游戏内技能购买界面的实际显示价**(折扣因号而异);不填则用 `src/base-pt.json` 的兜底估算价并给出警告——兜底价不代表你的号的真实价格
- 绿技能(仅被动加成)当前引擎版本不参与比赛过程模拟,建模收益为 0,不会被推荐购买
- 依赖其他马娘的技能(数据层 `approx`)按期望近似,与 uma-race-sim 同一口径

## 工作原理

1. **无技能基准** → 逐候选单独模拟(单项马身)
2. **贪心装入**:每轮对全部在池候选重算"当前组合下的边际收益",选 边际/PT 最高者;收益重叠的技能(如两个加速技能)后装者的边际会被压低,自然避免重复堆同类技能
3. **交换局部搜索**:尝试"换出已选 + 换入未选",收益提升则交换并回填预算再贪心
4. **汇报**:最终组合的 leave-one-out 边际 + 未上车技能分类;"单项收益之和"与"实测总收益"同时给出,差值即技能间交互

## 路线图

- **P1** 截图识别:国服技能购买界面截图 → OCR 实际价格 + 技能名匹配,一键导入(对齐"直接读取实际 PT 价格"的需求)
- **P2** Web 界面增强:速度曲线/发动位置可视化(复用 uma-race-sim 的 uPlot 方案)、多方案对比、URL 分享

## 结构

```
src/engine, src/analysis   vendor 自 uma-race-sim(npm run sync 重同步,勿手改)
src/data.ts                技能/赛道数据加载
src/optimizer.ts           优化器核心
src/lookup.ts              赛道/技能名称模糊匹配
src/cli.ts                 命令行入口
src/base-pt.json           PT 兜底估算价(仅当输入未提供 pt 时使用)
web/                       网页版(Vite + React,优化器在 Web Worker 中运行)
tools/sync-from-uma-race-sim.mjs
```

## 来源与致谢

- 模拟引擎、技能数据(2641 条)、赛道数据(138 条)全部 vendor 自 [mioX-9527/uma-race-sim](https://github.com/mioX-9527/uma-race-sim),其数据与公式来源见该仓库 README
- 社区调研中参考的同类工具:GameWith/umax-tools 评价点最大化、[daftuyda/UmaTools](https://github.com/daftuyda/UmaTools) Rating 优化器、[alpha123/uma-skill-tools](https://alpha123/uma-skill-tools) —— 它们的目标函数均为评价点/Rating,基于赛道模拟的马身收益优化目前没有先例

## 免责声明

本项目为非官方同人工具,与 Cygames / bilibili 无关。数值仅作育成参考,与游戏实际表现可能存在差异。

## 许可证

代码以 [GPL-3.0-or-later](LICENSE) 发布;`src/engine`、`src/analysis`、`data/` 中的内容来自 uma-race-sim,沿用其许可与版权说明(游戏解包数据归 Cygames 及相应数据来源方所有)。
