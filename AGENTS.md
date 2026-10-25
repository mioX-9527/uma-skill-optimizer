# uma-skill-optimizer · 交接文档(AGENTS.md)

> 写给接手本项目的开发者/AI agent。读完本文应能独立修改、测试、扩展本项目而不需要再考古。
> 本项目是 [mioX-9527/uma-race-sim](https://github.com/mioX-9527/uma-race-sim)(赛马娘国服赛道模拟器)的姊妹项目;上游仓库的 `AGENTS.md` 同样值得一读,理解引擎侧的公式与数据管线。

## 1. 项目是什么、为什么存在

**一句话**:按玩家的**实际 PT 预算**,基于真实赛道模拟求**马身收益最大**的技能购买组合。

**背景与立项依据**(2026-10 社区调研结论,详见 git 首个提交前的对话记录):

- 现有社区工具(GameWith 評価点最大化、umax-tools.com、daftuyda/UmaTools、alpha123/uma-skill-tools)的技能优化目标都是「评价点」或「Rating」——与比赛胜负无关的加性面板分数。**没有人做过以赛道模拟为目标的 PT 预算优化**,这是空缺。
- 上游 uma-race-sim 已有校准过的确定性模拟引擎(无技能东京草2400 实算 116.724s vs 游戏实录 116.987s)和 leave-one-out 技能消融分析,天然就是本项目的目标函数。
- **核心用户需求**:技能购买有折扣(hint/继承等,因号而异),所以技能价格必须由用户填**游戏内实际显示价**,不能用静态表。这是用户的原话要求("因为技能存在打折,需要直接读取我的当前实际pt价格")。
- 关键非加性事实:技能组合收益 ≠ 单项收益之和(加速技能重叠、回体改变后续发动位置)。上游 `AblationReport` 里 `sumDeltaSec ≠ totalDeltaSec` 早已标注此现象。**因此优化器不能做纯背包,装入后必须重算边际**——这是本项目算法设计的核心约束。

## 2. 技术形态与目录结构

单 npm 包(非 monorepo),TypeScript + ESM,零运行时依赖(引擎是纯函数),开发依赖 tsx/vite/react/vitest。

```
uma-skill-optimizer/
├─ AGENTS.md                    ← 本文档
├─ README.md                    ← 用户向说明
├─ package.json                 scripts: sync / optimize / web / web:build / web:standalone / test / typecheck
├─ tsconfig.json                strict, noUncheckedIndexedAccess, bundler resolution
│                                 注意: 没有 exactOptionalPropertyTypes —— 因为 vendored 上游代码不兼容,勿随意加回
├─ vitest.config.ts             独立 vitest 配置(见 §7 坑 3)
├─ vite.config.ts               开发版 web(root='web', port 5183)
├─ vite.config.standalone.ts    单文件版 web(vite-plugin-singlefile)
├─ tools/
│  ├─ sync-from-uma-race-sim.mjs   从上游仓库同步 vendor 代码+数据,并自动重建单文件版
│  └─ copy-standalone.mjs          把 dist-standalone/index.html 复制为根目录 打开规划器.html
├─ src/
│  ├─ engine/                   ← VENDORED(上游 packages/engine/src),勿手改
│  ├─ analysis/                 ← VENDORED(上游 packages/analysis/src,仅 ablate.ts;
│  │                               其 import 已由 sync 脚本改写为 ../engine/index.js,勿手改)
│  ├─ data.ts                   加载 data/*.json,导出 COURSES/SKILLS/SkillEntry
│  ├─ base-pt.json              PT 兜底估算价(仅当输入未提供 pt 时使用;白100/金200 系估算)
│  ├─ optimizer.ts              ★ 优化器核心(§4)
│  ├─ lookup.ts                 名称归一化 + id/精确/模糊三级查找
│  ├─ fmt.ts                    终端对齐工具(全角按2列宽)
│  └─ cli.ts                    命令行入口
├─ data/
│  ├─ skills.json               2641 条技能(VENDORED 数据;条目几乎可直接当 SkillConfig 用)
│  ├─ courses.json              138 条赛道/17 赛场(VENDORED 数据)
│  └─ SYNC_INFO.json            sync 时间与来源记录(自动生成)
├─ web/
│  ├─ index.html
│  └─ src/
│     ├─ main.tsx / App.tsx     界面(单个 App 组件,~380 行)
│     ├─ api.ts                 数据查找/导入导出/Worker 调用(含 file:// 回退)
│     ├─ optimizer.worker.ts    Worker 入口(web 模式下优化器在此运行)
│     ├─ styles.css             浅色主题
│     └─ vite-env.d.ts          vite client 类型(支持 ?worker&inline)
├─ test/optimizer.test.ts       7 项单测
├─ examples/input.example.json  CLI/网页共用的输入示例
├─ 运行示例.bat                 双击跑 CLI 示例(注意:批处理调 npm 必须 `call npm`,否则闪退)
├─ 打开规划器.bat                双击起 vite dev
├─ 打开规划器.html               ★ 单文件构建产物(已入 git)。用户双击即用,无需 Node
└─ dist-web/ dist-standalone/   构建输出(gitignored)
```

**Vendored 模型的原因**:不把上游引擎当 npm 依赖(避免跨仓 file: 链接和新机器上必须同时 clone 两仓),改为"源码复制 + sync 脚本重同步"。代价是上游更新后需要跑一次 `npm run sync`。

## 3. 引擎调用链(必读)

上游引擎**不读数据库**——`RunnerConfig.skills` 里要塞完整的 `SkillConfig` 对象(含 effects/condition)。幸运的是 `data/skills.json` 的条目几乎就是 `SkillConfig`(上游 web 端也是直接 as 转换),所以:

```ts
import { simulate } from './engine/index.js';
import { COURSES, SKILLS } from './data.js';

const runner: RunnerConfig = {
  stats: { speed, stamina, power, guts, wisdom },
  greenBonus: {},          // 绿技能前提值,当前版本恒 {}
  tactic: 'senko',         // nige|senko|sashi|oikomi
  distanceAptitude: 'A', surfaceAptitude: 'A',   // S~G
  motivation: 'normal',    // best|good|normal|bad|worst
  courseFix: 'auto',       // 赛道补正,auto=按五维算
  skills: SkillConfig[],   // ← 优化器每次模拟都换这个字段
};
const r = simulate(course, runner);   // r.finishTimeSec 完赛时间, r.spurtTargetSpeed 末速, 确定性可复现
```

要点:

- **确定性**:同一输入同结果(引擎内部无 Math.random 随机;随机位置技能按规则取位)。单次模拟 ~1.3ms(东京2400,30技能,2026-10 实测)。
- **马身口径**(与上游消融一致):`body = Δsec × spurtTargetSpeed / 2.5`(`BODY_LENGTH_METERS=2.5`)。
- **绿技能(常时被动,condition=raceStart 且全 passive)自上游 0.8 起已建模**:引擎 `effstats.passiveBonusOf(runner, course)`
  把**已选绿技能**与手动 `greenBonus` 一起并入起跑属性(面板+绿逐项相加后统一过软上限与干劲;例外:耐力对决参照值里绿加成不吃干劲),
  它们不进发动通道、没有"发动位置",收益就是属性差。**带装配限制的绿技能按 course + 环境(场地/天气/季节)判定,不匹配则整场不生效**
  (213 条绿技能里 164 条带限制:赛场 65、距离档 25、季节 21、场地 23、属性门槛 39…)。
  例外两条仍不可用:数据层标 `unsupported` 的**条件型被动**(依赖名次/人数,如「独行侠◎」)、带 `prereq` 发动前提的被动。
- `RunnerConfig` 环境字段:`groundCondition`(0 良/1 稍重/2 重/3 不良,**会改变体力消耗**)、`weather`(1 晴/2 阴/3 雨/4 雪)、
  `season`(1 春/2 夏/3 秋/4 冬/5 樱花)——后两者**只用于技能条件判定**,缺省晴/春。
- `precision` 字段:`precise`/`approx`(依赖他马,期望近似)/`unsupported`(效果未建模,收益按 0)。UI 须标注。
- 马身/时间收益的**符号约定**:gain = t(before) − t(after),正值=变快。历史上曾写反过一次(单技能组合出现 +0.33 与 −0.33 并存),已修复并铭记。

## 4. 优化器(src/optimizer.ts)——算法与实现细节

**问题**:预算约束下最大化非加性收益(背包变体)。穷举不可行,用「贪心 + 边际重算 + 交换局部搜索」。

参数默认值:`maxSims=30000`(单次 ~1.3ms,最坏 ~40s),`minImprovementSec=0.0005s`(≈0.003 马身),交换搜索 `SWAP_ROUNDS=10` 轮、换入候选池 `SWAP_POOL=50` 剪枝。

流程:

1. **候选解析**:按 id 查 SKILL_INDEX(data.ts 的 SKILLS 建立);重复 id 报错;未知 id 报错。
   **装配限制预检**:用引擎的 `restrictionSatisfied()` / `skillApplicable()` 判定跑法/距离档/场地/赛场/场地状态/
   回转方向/天气/季节/干劲/海外/标准距离/面板阈值(含 `restriction.anyOf` 的"或"子句)是否满足,
   不满足者标 `state='blocked'` 并写入 `blockedDetail`(`describeRestriction()` 生成「仅限逃马」「仅限秋季」这类说明),
   **不参与模拟、不进候选池**。这类技能最终汇报为 `reason='inapplicable'`,**不能归成 no-gain**——它们的模拟收益恒为 0,
   若按「组合内无正收益」汇报会被误读成「技能没用」,实际是限制不满足或效果未建模。
   **绿技能(常时被动)自上游 0.8 起是正常候选**,只有两种情况仍 blocked:数据层 `precision==='unsupported'`
   的条件型被动(依赖名次/人数)、带 `prereq` 的非常时被动。
2. **基准 + 单项收益**:`sim([])` 为基准;逐候选单独模拟得 `soloSec`;`pt > budget` 直接标记(最终归类 unaffordable)。
3. **贪心装入**(greedyFill,会被多次调用):每轮对全部"在池且 pt≤剩余预算"候选重算边际 `sim(S+c)`,选 `gain/pt` 效率最高者装入(gain 必须 > eps);无正收益候选时,把本轮测得 gain≤eps 的标记为 no-gain 并停。**关键:每轮全部重算**,所以联动技能(如"拔得头筹"依赖前面技能建立领先)后装时能被正确捡起——E2E 已观察到"单独 0 收益、组合内转正"的案例。
4. **交换局部搜索**:每轮尝试所有 (换出 a∈S, 换入 b∈池前50) 组合(pt_b ≤ 剩余+pt_a),gain > eps 的最优交换则执行,然后**再跑一轮 greedyFill 回填预算**;最多 10 轮或无改进为止。
5. **汇报**:`sim(S)` 为最终结果;对每个已选技能做 leave-one-out 得 finalMarginal(注意符号:t_without − t_final);未选技能分类:
   - `unaffordable`: pt > 预算
   - `inapplicable`: 本配置下不会生效(装配限制不满足 / 条件型被动未建模 / 效果未建模),`detail` 给出具体原因;单独马身恒为 0
   - `no-gain`: 能发动但最后测得边际 ≤ eps(纯回复技能在体力跑不空的赛道会命中这一类,`detail` 会注明「本组合体力未耗尽」)
   - `outbid`: 有正收益但没被选(通常是预算用尽),附 `missingPt = pt − 剩余预算` 供"再充多少 PT 能上车"提示
   - 同时输出 `sumSoloBody`(单项之和)与 `totalBody`(实测),两者差 = 技能间交互,**必须同时展示**(上游 UI 也这么干)
6. `simsUsed` 接近 maxSims 时打"提前收敛"note。

**回归锚点**(改算法、改示例或跑完 `npm run sync` 后必对):示例输入(`examples/input.example.json`,东京草2400/先行/预算1000/14候选)
应得到:无技能 118.463s → 有技能 117.067s,购买 6 项共 1000pt,总收益 **13.23 马身**,183 次模拟。
CLI 与网页结果必须一致。示例特意包含"单项 4.07 → 组合内无正收益"(中距离直线○,直线类重叠)、
"单项 1.27 → 集内边际 1.30"(亲手把握未来,联动)与一条绿技能「博弈者(1)」(单项 1.17 → 边际 1.01,软上限挤兑);
候选总价 1910pt > 预算 1000pt,所以会同时出现 outbid 与「差PT」列。

## 5. 数据与 sync

- `data/skills.json`:字段 id/name/nameJa/nameTrad/cnReleased/rarity/effects/durationSec/condition/restriction/restrictionText/wisdomScaled/precision/cooldownSec/randomPosition/**prereq**/source/fetchedAt。
  0.8.2 数据快照:2641 条,precision 分布 precise 409 / approx 1988 / unsupported 244;`prereq`(发动前提)200 条、`restriction.anyOf`(「或」分支)10 条。
  **rarity 映射**:normal=白技能,rareEvolved=金技能,evolved=进化技能,unique1~6=本体固有,uniqueHeir=继承固有(900xxx)。固有多等级同名,如 全心全意(1)/(2)/(继承) 三条——名称匹配歧义时报错列出让用户用 id。
  **注意 `is_basis_distance`** ≠ 距离档:1 = 赛程是 400 米整数倍(标准距离),引擎判 `distance % 400 === 0`;按中文技能名猜会全反。
- `tools/sync-from-uma-race-sim.mjs`:从 `../uma-race-sim`(可 `--from` 覆盖)复制 engine/analysis 源码与数据 → 把 ablate.ts 里 `@uma-race-sim/engine` 改写为 `../engine/index.js` → 写 `data/SYNC_INFO.json` → **自动跑 `npm run web:standalone` 重建 打开规划器.html**(node_modules 未装则跳过并提示)。上游引擎更新后跑 `npm run sync` 一条命令全量同步。
- PT 基价不在上游数据里(skills.json 没有 pt 字段,BWIKI/lua 解包里也没有)。`src/base-pt.json` 是兜底估算(白100/其余200),**仅当输入未给 pt 时使用并警告**;P1 的截图识别(§8)落地后应以实际价格为准。

## 6. Web 版(web/)

- Vite + React 18,浅色主题。左栏配置(赛道筛选 select、五维、跑法/适性/干劲、**场地状态/天气/季节**),右栏候选技能(搜索下拉:归一化后 精确>前缀>包含 排序,显示稀有度标签/效果中文描述/默认pt,点选添加,pt 逐条可编辑),下方结果区(推荐表 + 未购买表 + notes)。
- **场地状态/天气/季节**(2026-10 加):三者都进 PlanState 与导入导出 JSON(`runner.groundCondition/weather/season`)。
  场地状态改体力消耗;天气/季节只决定绿技能与环境条件技能是否生效(缺省 良/晴/春)。绿技能效果在列表里显示为「绿技能 速度+80」。
- **表头与数值列对齐**:数值列 th/td 都要 `class="num"`(右对齐 + tabular-nums)。用户明确提过对齐问题,改表格时注意。
- **计算入口** `api.ts runOptimize()`:
  - `location.protocol === 'file:'` → **主线程直算**(单文件版);
  - 否则走 `./optimizer.worker?worker&inline`(内联 Worker,dev 和 http 都不卡界面);Worker 抛错时回退主线程。
  - 双通道的结果必须一致(同一段 optimize 代码)。
- **单文件版**(vite.config.standalone.ts + vite-plugin-singlefile):全部 JS/CSS 内联进一个 HTML(2.8MB),产物复制到根目录 `打开规划器.html` 并**提交进 git**——这是新机器零依赖的启动方式,git 里有、别删。file:// 下 Worker/模块脚本受限,靠上面的 file:// 回退保证可用。
- 计划 JSON 与 CLI 同格式(`{course, budget, runner{...}, skills[{id?,name?,pt}]}`),网页导入/导出与 CLI 输入互通;配置自动存 localStorage(`uma-skill-optimizer-plan-v1`),坏了会静默清掉回落示例。

## 7. 环境与已知坑(Windows + Git Bash)

1. **批处理调 npm 必须写 `call npm`**,否则 npm(.cmd)执行完直接终止批处理,`pause` 不会执行 → 窗口闪退。用户踩过。
2. **git 中文路径默认八进制转义**,`git ls-files | grep 打开规划器` 会误报不存在;用 `git -c core.quotepath=false ls-files`。commit 时大量 LF→CRLF warning 是正常的,别试图"修"。
3. **vitest 必须用独立的 `vitest.config.ts`**:vitest 会读取 `vite.config.ts`,其中 `root:'web'` 会让 vitest 在 web/ 下找测试而报 "No test files found"。
4. **tsconfig 没有 exactOptionalPropertyTypes**:vendored 的 ablate.ts 不兼容该选项。若要给本项目代码加,先改用 vendor 排除方案或推动上游修。
5. 网页端技能搜索默认过滤 `cnReleased === false`(未实装的日服技能)。
6. 上游数据里部分技能名有迷惑性(如「圆弧艺术家」实为金回体 heal 0.055,不是加速);判断技能行为以 effects 字段为准,别信名字。
7. 用户机器:Windows 10,Node v24,shell 是 Git Bash;项目在桌面,模拟器在 `C:\Users\mio\Desktop\uma-race-sim`。

## 8. 验证清单(接手后先跑一遍)

```bash
npm install          # 若 node_modules 缺失
npm run typecheck    # tsc -p . 零输出
npm test             # 12 passed
npm run optimize -- --input examples/input.example.json
                     # 对照 §4 回归锚点:118.463s→117.067s,1000pt,13.23 马身
npm run web          # 浏览器打开 5183,载入默认示例点"开始计算",结果应与 CLI 一致
```

单测覆盖:预算硬约束、总收益>0、组合不劣于最优单项、交互口径区分、超预算拒绝与分类、确定性复现、未知 id 报错、
装配限制→不适配(含 detail)、未建模→不适配、绿技能进入候选池有正收益、季节限制绿技能换季前后行为、可发动无收益仍归 no-gain。

## 9. 路线图

- **P1 截图识别(下一个大项,用户最期待)**:国服技能购买界面截图 → OCR 实际价格 + 技能名匹配 → 一键导入。背景:技能价格因 hint 折扣因号而异,直接 OCR 价格数字(而非识别 hint 等级再查折扣表)对游戏改版最鲁棒;名称匹配复用 src/lookup.ts + skills.json 国服译名,价格+稀有度可交叉校验。需用户提供截图定 UI 模板。参考:umax-tools.com(日服截图读评价点,本地处理)、国服自动化项目 shiokaze/UmamusumeAutoTrainer。落地形态待定:浏览器端 OCR(onnx/paddle.js)或本地脚本。
- **P2 Web 增强**:速度/体力曲线与发动位置可视化(上游有 uPlot 方案可搬)、多方案对比、URL 分享。
- **待办小事**:courseFix 网页端暴露;手动 greenBonus 输入(给「因子/面板抄来的前提值」用,绿技能本身已按候选自动计入);CLI 增加进度输出(onProgress 已预留)。

## 10. 约定

- UI 与文档一律中文;代码注释只写"代码本身说不出的约束"。
- 代码 GPL-3.0-or-later(随上游);`src/engine`、`src/analysis`、`data/` 沿用上游许可与版权说明。
- 提交信息中文,一行主题即可;文档里的"用户"指项目作者 mioX-9527。
- 改 vendored 代码是错误;要改引擎行为应改上游 uma-race-sim 然后 `npm run sync`。
