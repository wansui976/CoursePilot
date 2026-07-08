# 统一左侧栏(AppSidebar)设计

日期:2026-07-07
状态:已与用户确认

## 背景与问题

桌面宽屏下应用有两个左侧栏,形态与入口都不一致:

- **课程库视图**:`CourseSidebar`(约 260px 宽栏)——品牌行、新建课程、处理队列(带徽标)、课程列表(悬停 `…` 菜单)、底部一行(主题/回收站/设置)。
- **工作台视图**:`renderRail()` 图标窄栏——logo、返回课程库、课程视频弹层按钮、主题、设置(无回收站、无队列)。

用户痛点(已确认):两个侧栏不一致、功能入口逻辑乱、希望可折叠更省空间。

## 目标

一个全局唯一的侧栏组件,双态(展开宽栏 / 折叠图标栏),手动折叠、分视图记忆;
功能入口固定归置;课程库与工作台视觉与交互完全一致。

不做:手机窄屏布局改动(BottomTabBar 与整屏课程页保持现状)。

## 设计决策(用户逐项确认)

1. **统一模型**:单侧栏双态,手动折叠按钮切换;展开 ≈260px,折叠 ≈56px。
2. **入口归置**:底部固定功能区 = 主题切换、回收站、设置;处理队列是带状态的导航项,留在顶部内容区。
3. **状态记忆**:分视图记忆(localStorage `course-ai-sidebar-collapsed`,值 `{ library: boolean; workbench: boolean }`);首次默认课程库展开、工作台折叠。
4. **工作台视频列表**:展开态在当前课程条目下内联该课程视频(当前播放高亮);折叠态保留"列表图标 → 临时弹层"(即现有 flyout)。

## 组件结构

### `AppSidebar.tsx`(新)

统一侧栏壳。桌面宽屏下课程库与工作台都渲染它。

Props:
- `view: "library" | "workbench"`
- `collapsed: boolean`、`onToggleCollapsed()`
- 课程:`selectedCourseId`、`onSelectCourse(id)`
- 工作台:`videos: Video[]`、`selectedVideoId`、`onOpenVideo(id)`、`onBackToLibrary()`
- 工具:`theme`、`themeToggleLabel`、`onToggleTheme`、`onOpenSettings`、`onOpenRecycleBin`、`queueOpen`、`queueCount`、`onToggleQueue`

展开态结构(自上而下):
1. 品牌行:logo + "课程库" 标题 + 折叠按钮(PanelLeftClose 图标)
2. 新建课程按钮
3. 处理队列导航项(计数徽标)
4. `我的课程` 分组标签 + `<CourseList>`;`view === "workbench"` 时当前课程条目下内联视频列表
5. 底部固定功能区:主题、回收站、设置

折叠态结构(自上而下):
1. logo(工作台下点击 = 返回课程库,带 title 提示)
2. 展开按钮(PanelLeftOpen 图标)
3. 队列图标(`queueCount > 0` 时数字小徽标)
4. 视频列表图标(仅工作台;点击弹现有 flyout,弹层实现随迁至 AppSidebar)
5. 弹性空隙
6. 主题、回收站、设置图标

### `CourseList.tsx`(从 CourseSidebar 抽出)

课程条目渲染 + `…` 菜单(重命名/重选根目录/删除)+ 重命名输入 + iOS 滑出菜单 +
空态 + 课程 CRUD mutations(含 ErrorNote 错误提示)。
新增插槽 prop:`selectedCourseExtra?: ReactNode` —— 渲染在选中课程条目下方,
工作台用它插入内联视频列表;课程库视图不传。

### `CourseSidebar.tsx`(瘦身)

仅保留窄屏手机整屏课程页(`variant="screen"`),内部改用 `CourseList`;
桌面 sidebar 形态删除,由 AppSidebar 接管。

### Home.tsx

- 渲染:`isPhoneDevice ? null : <AppSidebar view={inVideoSession ? "workbench" : "library"} …/>`
- 删除 `renderRail`、`renderSidebar`、`renderRailVideoFlyout`
- 折叠状态:`useState` 初始化自 localStorage;点折叠按钮时写回对应视图字段

## 交互逻辑

- 工作台点**其他课程** → 返回课程库并选中该课程(清 selectedVideoId + selectCourse)
- 工作台点**当前课程名** → 返回课程库(保持选中)
- 工作台点内联**视频** → `openVideo(id)`,留在工作台
- 折叠/展开只影响当前视图对应的记忆字段,切视图时读各自字段

## 外观

- 导航项沿用 `ca-nav-item` 样式;折叠态按钮沿用现 `rail-btn`(36px、圆角、active 态),
  两态选中/激活样式统一(accent 高亮)。
- logo 恒在顶、设置恒在底:折叠仅"去文字、收窄",入口位置连续不跳跃。
- 侧栏宽度变化加 0.2s 过渡;`prefers-reduced-motion: reduce` 时由全局兜底规则关闭。
- 内联视频列表:缩进 + 小 Play 图标 + 当前视频 accent 高亮(样式取自 flyout 现有 `on` 态)。

## 数据流

- `videos` 已在 Home 按 `selectedCourseId` 查询,直接下传 AppSidebar,无新查询。
- 课程列表查询与 CRUD mutations 随 CourseList 迁移,行为不变。

## 测试

- 新增 `AppSidebar.test.tsx`:
  - 展开/折叠两态入口齐全(队列徽标、底部功能区)
  - 折叠按钮触发 `onToggleCollapsed`
  - 工作台展开态:内联视频列表渲染、点击调用 `onOpenVideo`、当前视频 `aria-current`
  - 工作台折叠态:视频列表图标弹出弹层
- Home.test.tsx:更新原 rail 按钮断言("返回课程库"、"课程视频");新增折叠状态记忆(localStorage 读写)断言。
- CourseSidebar 相关现有测试:调整为 screen variant / CourseList。

## 风险

- CourseSidebar 拆分时 iOS 滑出菜单与重命名细节较多,迁移需保持行为一致(靠现有测试 + 补 CourseList 断言兜底)。
- `.ca-app` 第一列宽度改为随折叠态变化,需确认 grid 列定义与 `data-view` 相关样式不冲突。
