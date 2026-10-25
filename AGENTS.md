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
├─ test/optimizer.test.ts       12 项单测
├─ examples/input.example.json  CLI/网页共用的输入示例
├─ app/                         ★ Python 侧:桌面窗 + 从模拟器自动读取(§10)
│  ├─ main.py                   pywebview 壳,把 Bridge 方法暴露给前端 window.pywebview.api
│  ├─ adb.py                    连接/取帧/滑动(雷电自带 adb,127.0.0.1:5555)
│  ├─ capture.py                翻页编排:划到顶→逐屏识别→去重→判停
│  ├─ ocr.py                    RapidOCR 封装(行带 det / 单行 rec-only,2× 放大)
│  ├─ match.py                  名称→技能匹配 + ○/◎ 跨行价格消歧
│  ├─ layout.py + layouts/      版式 profile(720x1280 一份,坐标待校准)
│  ├─ cli.py                    doctor / shot / calibrate / ocr / capture
│  ├─ requirements.txt          pywebview + rapidocr + onnxruntime
│  └─ tests/                    test_match.py(纯逻辑)、test_capture.py(造假帧的端到端)
├─ 运行示例.bat                 双击跑 CLI 示例(注意:批处理调 npm 必须 `call npm`,否则闪退)
├─ 打开规划器.bat                双击起 vite dev
├─ 启动桌面版.bat                ★ 双击开桌面窗(带「从模拟器读取」按钮)
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
- **区段随机取位技能(`randomPosition`)必须按期望计价,不能按引擎默认取位**。这条踩过坑,数据量还不小:
  `SKILLS` 里 2641 条有 1118 条是 `randomPosition: true`。
  - 引擎默认取位 = "一进入区段就发动"。「迅速果断」(差行·中盘随机·+0.35 速度 2.4s)在中山 2500m 上默认落在 **417m(中盘刚起点)**,只得 **0.62 马身**;
    而收益随位置变化极大:中盘主体稳定在 ~1.04,**临近终盘时因"存速带进末脚加速段"能到 2.3**(尾部窗口 = 速度buff还覆盖 1667m 末脚起点)。
    按满足区段均匀采样 12 点求均值 = **1.11 马身**,与 `uma-race-sim` 的 `ablate().rows[].expectedBody`(24 组 LHS 抽样)的 1.116 一致。
  - 用单点值会把这些技能系统性压低约 **45%**,后果是金技能被下位白技能挤掉、加点方案整体偏保守。
  - **实现是两档口径**(`src/optimizer.ts`):搜索排序用 `simSearch`(随机技能固定区段中点,1 次模拟,偏差只剩尾部那一小块 ~7%);
    汇报数值用 `simExpected`(12 点等距采样的完赛时间均值)。只有汇报那几处(单项收益 / 组合边际 / 总收益)跑 N 遍,
    全流程 44 候选从 ~4s 涨到 ~7s;全跑 N 遍会到 ~28s,不可接受。
  - 高方差技能(如 `straightFastest` 类,收益区间 0.00~3.14)即使 12 点也只能精确到 ±10%,参考工具 24 点也一样飘,**不要**为了对齐它无脑加大采样数。
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

参数默认值:`maxSims=30000`(单次 ~5ms 起、带技能更慢,最坏远超 40s),`minImprovementSec=0.0005s`(≈0.003 马身),交换搜索 `SWAP_ROUNDS=10` 轮、换入候选池 `SWAP_POOL=50` 剪枝,
随机取位期望采样 `RANDOM_POSITION_DRAWS=12`(只作用于汇报口径,见 §3)。

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
- PT 基价不在上游数据里(skills.json 没有 pt 字段,BWIKI/lua 解包里也没有)。`src/base-pt.json` 是兜底估算(白100/其余200),**仅当输入未给 pt 时使用并警告**;P1 的自动读取(§9/§10)落地后应以实际价格为准。

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
1.5. **`.bat` 必须纯 ASCII,中文一律交给 Python 打印**(2026-10-25 实测)。
   `chcp 65001` + 批处理里有非 ASCII 时,cmd 会**按字节错位重读文件**,把某行 echo 的尾巴当命令执行:
   `'��」自动填技能和价格' is not recognized as an internal or external command`。
   同一份文件里中文放第 5 行没事、放第 6 行就炸,取决于字节偏移 —— 任何一次编辑都可能把它挪到会炸的位置。
   三个 bat 的真源是 `tools/fix-bat-encoding.py`(改 bat 请改那里再跑一遍,直接改 .bat 会被覆盖),
   脚本会**断言纯 ASCII**,混进中文就报错退出。中文启动横幅放在 `app/main.py`(Python 在 chcp 65001 下输出 UTF-8 完全正常,实测 `sys.stdout.encoding == utf-8`)。
   同理:bat 里连 CJK **文件名**也别写(`打开规划器.html` 那个存在性检查已移进 main.py)。
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

- **P1 自动读取实际 PT(已完成首版,2026-10-25 真机跑通)**:ADB 连雷电 → 逐屏截图 → 局部 OCR 读「技能名 + 实际价格 + PT 余额」→ 喂优化器。
  落地形态:**pywebview 桌面窗**(见 §10),只读技能屏,面板/赛道仍手填。
  实测一把 30 行的育成:43 屏 / 44 帧 / 约 100 s,读出 **44 条可购买技能 + PT 余额 2034**,价格与界面逐个一致。
  为什么不用其它路线:uiautomator/无障碍读不到 Unity 控件树;内存读取成本高且与版本强耦合。
- **P2 Web 增强**:速度/体力曲线与发动位置可视化(上游有 uPlot 方案可搬)、多方案对比、URL 分享。
- **P1.5 白↔金价格联动(已完成)**:已从 BWIKI 的 SMW 查询拿到全部前置关系,并接进优化器
  (`data/skill-chains.json` + `app/chains.py` + `CandidateSkill.requires`),详见 §10。
  重新抓数据:`node tools/fetch-skill-chains.mjs`(游戏更新后跑一次)。
  注意:当前只处理**一层**前置(金 ← 白);多层链条(金 ← 白 ← 更下位)在赛马娘里基本不存在,遇到再扩。
- **待办小事**:courseFix 网页端暴露;手动 greenBonus 输入;CLI 增加进度输出(onProgress 已预留)。

## 10. 桌面版与自动读取(app/)

**是什么**:pywebview 装一层壳(`app/main.py`),窗口里加载 `打开规划器.html`,并把 Python 能力通过
`window.pywebview.api` 暴露给前端(`doctor` / `capture_skills` / `save_plan`)。前端只要判断
`window.pywebview?.api` 存不存在来决定是否显示按钮,所以**单文件 HTML 版照旧可用**。

**为什么不走 HTTP 服务**:网页版是纯前端,`file://` 下调不到 adb;桌面壳省掉一个常驻进程,
也不用改 Vite 打包方式。代价是要 `pip install -r app/requirements.txt`(pywebview + rapidocr + onnxruntime)。

**实测环境(2026-10-25)**:雷电 9.5.39,实例 0 = `127.0.0.1:5555`,**720×1280 @320dpi**,Android 9 / SDK 28,
游戏包名 `com.bilibili.umamusu`。用雷电自带 `E:\leidian\LDPlayer9\adb.exe`(与设备 SDK 同代,比新版 platform-tools 稳)。
`exec-out screencap -p` 实测 **280~350ms/帧**(早期用 shell 重定向测出的 ~1s 是 Git Bash 的额外开销,不是真实值)。

**多模拟器共存:先列设备再读,别写死序列号**(2026-10-25 用户报"读取不了"的根因之一)。
用户机器上 MuMu 和雷电同时开着,而 `127.0.0.1:5555` 当天被 **MuMu** 占着(前台碧蓝航线),
雷电的实际连法不一样 —— 写死序列号就会去读另一台模拟器的画面,报出来的却是"横屏/读不到技能行"。
- `adb.list_devices(connect="auto")`:`adb devices -l` 解析;**只有一台在线都没有时**才扫常见端口
  (`connect=True` 强制扫,给「刷新设备」按钮用)。扫端口**并行 + 1.5s 超时** —— 串行 8 个端口实测 **14.7s**,
  因为"端口在监听但不讲 adb"时 adb 会等满超时,界面像卡死。
- `adb.describe(serial)`:一条 shell 拿全 `机型 / ro.serialno / 分辨率 / 前台应用`
  (用 `echo M=$(...)` 前缀解析,机型为空时 getprop 会吐空行,按行号取会整体错位)。
- `adb.dedupe_devices()`:同一台模拟器常同时挂在 `127.0.0.1:5555` 和 `emulator-5554` 下
  (**serialno 一样**),不去重下拉框里就是两条一模一样的选项;保留 `host:port`(emulator-N 编号会变)。
- `adb.resolve_serial()`:显式 > 唯一在线 > 前台是赛马娘的那台 > **报错让人选**(不瞎猜)。
  CLI 的 `--serial` 默认值因此从写死的 5555 改成 `None`(自动),另外加了 `app.cli devices` 子命令。
- 前端 `.actions` 里是设备下拉框 + 「刷新设备」,选中项存 localStorage(`uma-skill-optimizer-adb-serial`)。

**五个必须记住的坑**(都是踩出来的):
1. **`get-state` 是 adb 宿主命令,不是设备 shell 命令**,写成 `shell get-state` 会报 not found。
2. **价格/角标这类单行小数字必须走 rec-only**(`engine(img, use_det=False, use_rec=True)`):
   det 对"右侧贴着裁剪边缘的小数字"经常直接检不到(同样字号下 200 检不到、130 检得到),
   而 rec-only 四条都是 0.999+。
3. **PP-OCR 会整个丢掉「◎」**(中距离直线◎ → 中距离直线),把「○」认成「。」,「×」反而认得对。
   所以匹配分两步:先按**原样**精确匹配(尊重 OCR 给的符号,否则 直线赛道× 会被展开成三个候选凭空多出"需确认"),
   再补符号变体;真正区分 ○/◎ 靠 `match.resolve_rows()` 的**跨行价格消歧**(游戏里价格随等级单调,比 OCR 可靠)。
4. **去重键是 (归一化名字, 价格),不能只用名字**:OCR 常把 ○/◎ 的符号都读丢,
   只按名字会把两个不同技能合并成一行。
5. **开抓之前必须先预检,否则翻车是「静默」的**(2026-10-25 用户报"读取不了了"后补的):
   - **横屏**:`wm size` 报的永远是竖屏物理尺寸(720×1280),而 `screencap` 给的是**旋转后的位图**
     (横屏时 1280×720)。方向一错,所有裁切框全落在错误位置,每屏都读不出名字 ——
     不报错、不中止,只会滚满 26 屏后给一堆空结果。`capture.check_orientation` 拿 `image.size` 跟
     `meta.size` 比,**在 OCR warmup 之前**判,横屏立刻报「模拟器现在是横屏,先转回竖屏」。
   - **不在技能页**(开着别的游戏 / 育成已结束在结算页):`检查第一屏是否至少读出一个技能名`。
     失败时报错并带上**前台包名**(`Adb.foreground_package()`),用户一看就知道开错了东西。
     这次现场就是:模拟器前台是 `com.bilibili.azurlane`(碧蓝航线),而赛马娘**根本没装**
     (`pm list packages -3` 里只有 6 个第三方应用)。所以别急着怀疑 adb/OCR。
   - 两条都有假帧回归:`app/tests/test_capture.py` 的「预检」段(横屏 1280×720、空页)。

**版式是「锚定式」,不是固定行高**(2026-10-25 真机校准时改的,原因很硬):
- **卡片高度不统一**:带「达成进化条件」标题的金卡更高,已获得的灰卡更矮,同一屏内就有差;
  用户也确认「每把技能数量不一样,高度会不同」。按 `row.height` 累加切行,滚几屏后必然把名字和价格串到隔壁卡。
- 做法:每张可购买卡片右侧有一个**纯绿「+」按钮**(实测 x=629..671, HSV 落在 (35,90,80)~(75,255,255)),
  用连通块求它的中心 `cy`,再以 `cy` 为基准裁名字(`cy-80..cy-34`)与价格(`cy-26..cy+18`)。
  与卡片高度、滚动位置完全无关。
- 附带收益:**已获得/不可购买的卡片没有这个按钮**,天然被排除,不需要再判灰度。

**滑动与判停的四条规矩**(全部踩坑得来,别改回去):
1. **起点终点都必须落在列表区内(y≈480~960)**。用比例坐标 `0.30→0.80` 时起点 y=384 落在上半屏马娘立绘上,
   那块是纯背景图,游戏直接忽略这次滑动——表现为"怎么划都滚不动"。
2. **回顶用短促 fling**(`duration=120ms`, y 700→960):实测每次滚 1~2 行,从底部回顶要 **17~19 次**;
   而慢速拖 250px 只滚不到一行,十几步也回不来。所以 `max_steps` 给到 26。
3. **判停比对 `find_rows` 的 cy 序列 / 技能名序列,不用像素差**:列表到底/到顶会 overscroll 回弹,
   像素一直在抖(实测差 5~20),永远等不到"画面不变";而 cy 和名字会稳定下来。
   回顶阶段要求**连续 3 次一致**才算到顶——只要求 2 次时,偶发一次 fling 没滚动就会误判,
   顶部两条(闪光☆着陆 / ∴win Q.E.D.)就是这么漏掉的。
4. **精读用小步慢拖**(y 900→770, `duration=420ms`):每次 1~1.5 行,保证相邻两屏重叠 ≥1 行。
   重叠是唯一的防漏手段;步长一旦超过可见行数就会跳行。

**`list.top` 为什么是 540**:列表顶端有一条黑色渐隐遮罩(约到 y≈460 结束)。若允许 `cy` 更小,
名字带会伸进遮罩区,OCR 会把「标准距离○」读成「准此高」;更糟时整块落在「当前技能点数 2034」那条上,
凭空多出一条叫「当前技能点数20」的技能。`list.bottom=978` 则是避开底部「确定/重置」按钮。

**两条技能界面机制(用户 2026-10-25 告知,已据此改实现,别再搞错)**:
0. **进化必须一路传到优化器,断在哪一段用户就会问「为什么还是只有迅速果断」**(2026-10-25 真实踩坑):
   游戏链路是「进化 ⓘ 弹窗 → Row.evolve(PopupInfo) → `match.evolutions_of()` 把目标名解析成 id
   → 桌面壳 `capture_skills()` 返回 `evolutions: [{fromId,from,toId,to,conditionMet}]`
   → 前端 `desktop.applyEvolutions()` 挂到 `PlanSkill.evolvesTo/evolveAlternatives`
   → `RunInput.skills` → 优化器」。**网页端此前完全没有这段**,CLI 有(走 plan.json 的 `evolutions`),
   所以同一个技能 CLI 里能显示「进化前→进化后」、网页里永远只有未进化数值。
   条件未达成(conditionMet=false)的方向也要返回 —— 前端提示「有这个方向但本局不行」,
   比让它无声消失好(用户会以为抓漏了)。
   注意:进化后的技能**不在候选列表里**(金技能免费变来的),所以必须回全量技能库把名字解析成 id;
   而且**同一技能的方向互斥**(只能变其中一种),优化器按 max 择优,不是求和。
   真实关系速查(用户 2026-10-25 指正):**迅速果断(200591)有 6 个进化方向** ——
   盛夏的奋力一搏 / 雷腾云奔 / 赶快开始吧! / 胜利之路 / 疾行！英雄登场！ / 魔术:阳魂不散。
   中山2500 差行上未进化 1.11 → 盛夏的奋力一搏(同值但 2.4s→4s)**1.86** 马身。
   **别拿 `data/skill-evolutions.json` 里的方向数当真相** —— 旧抓取脚本按第一个 `</tr>` 截断,
   6 个只抓到 1 个(悬浮说明里嵌着内嵌表格);已改成按 `<span class="popup">` 标签配平,
   回归见 `test/evolution-parse.test.ts`。重抓:`node tools/fetch-evolutions.mjs`
   (并发压到 2,BWIKI 有 EdgeOne 防护,连续请求会被 567 拦截页挡掉)。
   用户定的展示口径:游戏里点开「进化 ⓘ」读到的名字 → 检索 → **在马身收益那格标注
   「雷腾云奔（迅速果断进化）」**,不要自己发明映射。
1. **○ 是 ◎ 的下位,两者占同一格**。格子里显示的是「当前可买等级」——没学过时显示 ○,买了 ○ 之后同一格才变成 ◎。
   享受的折扣相同。**所以「同名两行」(○ 和 ◎ 同时出现)根本不会发生**。
   早期 `resolve_rows()` 里那段「按价格给同名多行配 ○/◎」的逻辑基于错误前提,从未触发过,**已删除**。
2. **金技能的下位白技能是分开的两格**。买了下位白技能,金技能的价格会**减少相应点数**;折扣分开算。
   → 更关键的是:**列表里金技能显示的价格本身就等于「前置价 + 金技能自己的折后价」**。
   实测四组(与 BWIKI 原始价吻合):

   | 抓到的显示价 | BWIKI 消耗/共需 | 拆解(前置显示价 + 金自己) |
   |---|---|---|
   | 先走一步！304 | 160 / 320 | 游戏到此为止！160 + 160×0.9 = **144** |
   | 巅峰之梦 320 | 200 / 400 | 背负信念 180 + 200×0.7 = **140** |
   | 浑然忘我 288 | 180 / 360 | 不顾一切 144 + 180×0.8 = **144** |
   | 内侧体验 304 | 160 / 320 | 弯里横 160 + 160×0.9 = **144** |

   所以「金 304 + 前置 160 = 464」是**高估**,两者一起买只要 304。
   反过来说:前置**还在列表里**说明没买过,显示价才含前置;前置**不在列表里**(已获得)时显示价就是纯金价
   —— 「迅速果断 180」正是这种情况(它的前置「向前抢位」在界面上是已获得灰显)。

**上下位关系怎么用**(数据 + 代码):
- 数据:`data/skill-chains.json`,由 `node tools/fetch-skill-chains.mjs` 从 **BWIKI 的 SMW 查询**生成
  (`[[前置技能::+]]|?前置技能|?技能消耗PT|?共需技能PT`;简中页标题是 `简/<技能名>`)。
  实测 995 页命中 → **249 条关系 / 190 个金技能**(350 个金技能里 54% 有前置,其余本来就没有下位)。
- 注入:`app/chains.py` 的 `pairs_within()` 只挑**两端都在候选里**的配对(前置不在=已买,不能抵扣),
  由 `app/cli.py` 与 `app/main.py` 写进 plan 的 `chains: [{skillId, prereqId}]`;网页 PlanState 有同名字段。
- 优化器:`CandidateSkill.requires` → `Cand.withSkills`(自己 + 前置,模拟时按 id 去重合并)
  + `costOf()`(前置已在组合里就只付差额)。等价于「买金自动带前置、前置只收一次」,与购买顺序无关。
  回归用例见 `test/optimizer.test.ts` 的两条 requires 用例。

**符号识别走形状,不走 OCR**(`app/symbol.py`):PP-OCR 对 ○ 的识别率是 0——det/rec-only × 2×/4× 四种配置
全部返回「良场地」(放大也救不回来,因为 ○ 的笔画只有 1~2px,汉字是 4~6px)。
改用二维连通域的特征判定,实测(720×1280 @320dpi):

| | 宽高 | 填充率 | 说明 |
|---|---|---|---|
| 汉字 | 18~20 × 19~20 | 0.47~0.83 | 笔画粗 |
| ○ | 15 × 16 | 0.23~0.30 | 1px 细环 |

判据用「填充率 ≤ 0.36 且尺寸 11~18 × 12~20」→ ○(实测 9/9 全中,误判 0)。
「洞占比」看着更直观但**不可用**:环只有 1px,抗锯齿下常有缺口,洞会和背景连通,时有时无。
◎ 的阈值(填充率 0.36~0.47)是**推断值**,当前截图里一条 ◎ 都没有(因为要学了 ○ 才会显示 ◎),
所以判成 ◎ 时标 `needs_confirm`,等真样本再收紧。

**版式 profile**:`app/layouts/<w>x<h>.json`。`calibrated: false` 时 `capture_all()` 直接拒绝执行。
校准流程:把游戏停在技能购买列表 → `python -m app.cli calibrate`
→ 看 `app/_debug/calib_lines.png`(画了列表区、PT 框、每行 cy 与名字/价格框)调 `list.*`、`anchor.*`、`crops.*`。

**匹配层的三条过滤**:
- `SkillIndex` 会剔除 **× 类减益绿技能**(效果全为负的 passive,如 良场地× 力量-40)。
  它们是对手施加给你的,不可能出现在自己的购买列表;不剔除就会把「良场地○ 81pt」错配成「良场地× 81pt」。
- `SkillIndex` 会剔除 **固有技能本体(unique1~6)**,只保留**继承版(uniqueHeir)**。
  购买界面能学到的固有技能一定是继承版,而继承版数值只有本体的 50~60%
  (实测 93 对**全部不同**: 向着更远的地方 acc 0.4/4.0s → 0.2/2.4s;闪光☆着陆 targetSpeed 0.25+acc 0.3 → 0.05+0.1)。
  界面显示的又是**不带「(继承)」**的名字,所以 OCR 的裸名字会精确命中本体 —— 收益直接高估近一倍。
  实测影响:同一次抓取的 44 条候选里 4 条是固有技能,纠正后总收益 **15.92 → 11.18 马身(虚高 30%)**。
  另:481 个本体里有 272 个**根本没有继承版**,更不可能出现在购买列表。
- `normalize()` 把 `.／．／…` 统一成 `…`:「向着,更远的地方……」每屏认出的点号个数都不同,
  不归一就会被当成两个技能重复计数(实测多算出一条 900591)。

**验证入口**:
```bash
python -m app.cli doctor            # adb + 分辨率 + 版式状态
python -m app.cli calibrate         # 出调试图
python -m app.cli ocr -i frame.png --rows   # 离线调解析(不连模拟器)
python -m app.cli capture -o plan.json      # 全流程
python app/tests/test_match.py      # 18 项:归一化/符号消歧/灰显过滤
python app/tests/test_capture.py    # 端到端:造假帧 → 真 OCR → 匹配 → plan
```
`test_capture.py` 特意把 PP-OCR 的真实缺陷(丢 ◎、○→。)写进断言,OCR 模型升级会立刻暴露。

**注意**:`打开规划器.html` 由 `npm run web:standalone` 生成,桌面窗加载的是这份产物;
改了前端要重建,否则桌面窗里还是旧界面。

## 11. 约定

- UI 与文档一律中文;代码注释只写"代码本身说不出的约束"。
- 代码 GPL-3.0-or-later(随上游);`src/engine`、`src/analysis`、`data/` 沿用上游许可与版权说明。
- 提交信息中文,一行主题即可;文档里的"用户"指项目作者 mioX-9527。
- 改 vendored 代码是错误;要改引擎行为应改上游 uma-race-sim 然后 `npm run sync`。
