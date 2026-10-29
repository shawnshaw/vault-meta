# Vault 元系统管理（vault-meta）

一个轻量的 Obsidian 元系统管理器：**整库备份与恢复**、**项目三位置只读检查**、**组件登记 / 打包 / 跨 vault 迁移 / 受保护卸载**，为后续能力扩展提供统一入口。

首版只管理**当前 vault**；其他 vault 仅作为导出与安装目标。界面为中文，遵循 Obsidian 现有 UI 规范（主题变量、原生控件、键盘可达）。

---

## 1. 边界（请先读）

- **云同步 ≠ 历史备份。** iCloud、OneDrive、坚果云同步的是“当前状态”，误删会被同步到所有设备。本插件生成的是带时间、范围与逐文件 sha256 的独立归档（`.vmbak`），请把它当作可回溯的备份。
- **不运行任何自动定期任务。** 只有点击“创建整库备份”或执行命令时才会备份；插件不会声称后台定时任务正在运行。项目检查也只在点击时执行，不会自动轮询。
- **不创建远端仓库、不发布。** 打包产物由用户自行分发。
- **只读联网检查。** 项目页的“检查”会读取 **github.com 公开 API**（最新正式 release、分支提交、开发线版本）：只发 GET，不写入远端、不上传内容、不保存凭据；非 github.com 地址会被拒绝。断网、限流或失败时显示真实原因与最后检查时间，绝不显示“已是最新”。
- **项目检查不修改任何源码或运行文件。** 唯一写入是 `.obsidian/vault-meta/projects.json` 的本机记录。
- **首版只管理一个 vault。** 多 vault 集中管理、云服务与账户系统不在范围内。

## 2. 安装

本插件按独立仓库组织，安装时只需三个文件：

```
.obsidian/plugins/vault-meta/
├── main.js
├── manifest.json
└── styles.css
```

将上述文件放入 vault 的 `.obsidian/plugins/vault-meta/`，在 Obsidian「设置 → 第三方插件」中启用「Vault 元系统管理」。仅支持桌面端（备份需要访问文件系统）。默认在**主标签页**以完整宽度打开；可在设置中改为右侧边栏。

## 3. 使用

### 概览
显示 vault 路径、已接入项目数、已登记组件数量、备份目录与最近备份时间，并给出备份边界说明。

### 项目
把同一个自研插件在三个位置上的状态放在一起看，**所有检查只读**：不修改源码目录，也不修改 `.obsidian/plugins` 下的运行文件。

- **接入项目…**：选择本地源码目录，自动识别 `manifest.json` / `package.json` 的版本与名称、git 远端与分支、对应安装位置；确认后可编辑。
- **项目详情**：三张卡片分别显示本地源码（版本、提交、源码身份、基线时间）、云端项目（地址、分支、最新正式 release、开发线版本、最后检查时间）、当前库使用（版本、文件校验、改动/缺失）。
- **真实比较**：文件级 sha256（当前库 vs 登记表）、构建产物级（源码 `main.js` vs 运行 `main.js`）、提交级（本地 HEAD vs 云端分支）、源码基线（当前源码身份 vs 上次记录）。同版本号但代码或提交不同会显式标记“同版本不同代码”。
- **检查 / 全部检查**：只在点击时联网；云端最新以最新正式 release 为准，分支头只标为“开发线（未发布）”。
- **更新基线**：记录当前源码身份；只写 `projects.json`。
- **移除关联**：只删除本机项目记录，保留源码、插件文件与用户数据。

### 组件
- **安装组件包…**：选择 `.vmpkg`，先做预检（依赖、文件冲突、路径安全），通过后再写入；升级会自动建立快照。
- **打包组件…**：从已登记组件或指定插件目录导出 `.vmpkg`，自动排除 `data.json` 等用户配置与 sourcemap。
- **导出套装…**：用 `suite@1` 描述引用多个组件版本，自动补齐必需依赖并导出单个 `.vmsuite`。
- **卸载**：只删除“登记在册且内容未被修改”的文件；用户修改过的文件、`data.json` 与用户新增文件一律保留。

### 恢复
- 选择备份目录（任意可访问的绝对路径，包括 iCloud / OneDrive 同步目录；界面不做硬编码）。
- 选择备份范围（`.git`、`node_modules`、组件快照、`.trash` 默认不包含）。
- **创建整库备份**：生成 `.vmbak`，备份目录若位于 vault 内会被自动排除，避免递归打包自身。
  写入完成后会再完整校验一次；校验不通过则删除本次产物并报错，既有备份不受影响。
- **校验**：逐文件核对 sha256。
- **恢复…**：恢复到指定目录；默认拒绝写入非空目录与当前 vault 内部，恢复过程逐文件校验。

## 4. 数据与格式

### 安装登记表

位置：`.obsidian/vault-meta/registry.json`，随 vault 一起被备份。

```json
{
  "format": "vault-meta/registry@1",
  "components": {
    "demo": {
      "id": "demo",
      "name": "Demo 插件",
      "purpose": "演示用途",
      "version": "1.0.0",
      "type": "obsidian-plugin",
      "source": { "kind": "vault", "path": ".obsidian/plugins/demo", "origin": "" },
      "installLocation": ".obsidian/plugins/demo",
      "files": [{ "path": "main.js", "sha256": "…", "size": 123 }],
      "dependencies": [{ "id": "core-lib", "range": "^1.0.0", "optional": false }],
      "installedAt": "2026-10-24T00:00:00.000Z",
      "updatedAt": "2026-10-24T00:00:00.000Z",
      "status": "installed",
      "snapshots": []
    }
  }
}
```

### 项目记录

位置：`.obsidian/vault-meta/projects.json`，只保存本机关联与最后一次检查结果，不保存凭据、不进入导出包。

```json
{
  "format": "vault-meta/projects@1",
  "projects": [{
    "id": "vault-meta-3fa9c1",
    "name": "Vault 元系统管理",
    "purpose": "元系统管理器",
    "pluginId": "vault-meta",
    "sourcePath": "/本机/源码路径",
    "remote": { "url": "https://github.com/owner/repo", "branch": "main" },
    "installLocation": ".obsidian/plugins/vault-meta",
    "baseline": {
      "sourceIdentity": "…", "sourceVersion": "0.2.0",
      "commit": "…", "artifactSha256": "…", "recordedAt": "…"
    },
    "lastCheck": {
      "at": "…", "ok": true, "code": "", "error": "",
      "branch": "main", "commit": "…", "developmentVersion": "0.2.0",
      "release": { "tag": "v0.2.0", "version": "0.2.0" }
    }
  }]
}
```

- 项目 id = 名称 slug + 源码路径哈希前 6 位，与组件 id 分属不同命名空间；同一安装位置或同一源码目录不能被两个项目占用。
- `baseline` 只在接入 / 编辑（更换源码目录）/ 更新基线时写入；`lastCheck` 只在检查时写入。普通刷新不改基线。
- 源码身份 = 排除 `.git`、`node_modules`、`.obsidian`、`data.json`、`.env`、`tmp` 后，对 `path\0sha256` 排序再取 sha256；超过 8000 文件或 200 MB 时标记为“过大”，不计算身份。

### 组件描述 `vault-meta/component@1`

| 字段 | 说明 |
| --- | --- |
| `id` | 小写字母/数字/`.`/`_`/`-`，全局唯一 |
| `name` / `purpose` | 展示名与用途 |
| `version` | 语义化版本；插件以 `manifest.json` 为准 |
| `type` | `obsidian-plugin` 或 `files`（其余类型需扩展） |
| `source` | `{ kind, origin, path }` |
| `install.location` | vault 内相对安装位置 |
| `files[]` | `{ path, sha256, size }`，用于逐文件校验与卸载归属判断 |
| `dependencies[]` | `{ id, version, optional }`（内部规范化为 `range`） |

### 套装描述 `vault-meta/suite@1`

见 `examples/suite.example.json`。成员未写版本时使用登记表中的当前版本；必需依赖会被自动补齐，缺失或版本不满足则拒绝导出。

### 归档容器

`.vmbak` / `.vmpkg` / `.vmsuite` 均为 `gzip(tar)`，路径能放进 ustar 时保持传统格式，
超出 ustar 长度限制（中文长文件名、深层目录）时自动写入 PAX 扩展头；旧归档仍可读取。
相对路径上限为 4096 字节（对齐常见系统 PATH_MAX），超过会被拒绝。POSIX 文件名中的反斜杠按普通字符处理（vault 中确有此类目录）；Windows 上因路径分隔符歧义会拒绝。

```
vault-meta.json          # 清单：类型、时间、范围、逐文件 sha256/size/mode/mtime
payload/<相对路径>        # 文件内容
```

清单永远是第一个条目；恢复时先校验清单再逐文件写入并复核哈希。归档内路径一律按相对路径处理，拒绝绝对路径、盘符、`..` 与反斜杠。

## 5. 一致性、权限与安全边界

**备份不是原子快照。** 备份过程中若文件被其他程序修改（同长度改内容、大小变化），哈希会与清单不一致，
本次备份会失败并删除刚生成的半成品，不会留下“看起来成功、实际校验不过”的归档；既有备份不会被触碰。
备份活跃 vault 时请暂停大规模写入，或失败后重试。

**权限恢复。** 恢复时按归档记录恢复文件权限位（只保留 `rwx` 三位，丢弃 setuid/setgid/sticky），
记录为 0 时退回 `0600`；内容与时间戳同时恢复。解包期间临时文件固定以 `0600` 独占创建；
权限设置失败会中止该文件并报 `E_PERMISSION`、清理临时文件，**不会**把文件以错误权限 rename 出去或报告成功。
Windows 平台跳过权限位。

**快照唯一性。** 每次安装/升级的快照目录使用“时间戳 + 随机后缀”并独占创建，
同一秒内连续操作也不会复用或覆盖历史快照；失败快照保留并标记 `failed`。

**状态目录边界。** 登记表、项目记录、快照与临时目录都位于 `.obsidian/vault-meta/`；
该目录或其 `projects.json`、`snapshots`、`tmp` 子目录若被符号链接指向 vault 之外，所有读写都会在落盘前被拒绝。
这也意味着：若把整个 `.obsidian` 目录做成指向外部的符号链接，本插件将拒绝工作（安全优先）。

## 6. 安全规则

- 写入前检查既有祖先链，任何指向目标目录之外的符号链接都会被拒绝（`E_SYMLINK_ESCAPE`）。
- 安装位置必须位于 vault 内；插件类型限定在 `.obsidian/plugins/<id>`。
- 安装/升级前复制现有目录到 `.obsidian/vault-meta/snapshots/<id>/<时间>/`，失败自动回滚文件与登记表。
- 每个组件最多保留最近 5 条成功快照记录；失败快照会保留并标记 `failed` 便于排查。
- 打包前硬拒绝 `data.json`、`.env`、密钥/证书、Cookie、凭据命名文件、`.git`、`node_modules`。
- 恢复默认只写空目录，且默认拒绝写入当前 vault 内部。
- 项目检查只读：不跟随符号链接、不执行 git 命令、不 fetch、不写源码或插件目录；网络只允许 `https://github.com`，超时 8 秒，不保存 token。

## 7. 扩展组件类型

```js
const { TypeRegistry } = require('./src/core/types');

const registry = new TypeRegistry();
registry.handlers // 已注册处理器
registry.register({
  id: 'theme',
  label: '主题',
  validateSpec(spec, ctx) { /* 抛错即拒绝安装 */ },
  selectFiles(absDir) { return ['theme.css', 'manifest.json']; },
  async verifyInstalled({ targetAbs, spec }) { /* 安装后真实校验 */ },
});
```

未注册的类型会在预检阶段以 `E_UNSUPPORTED_TYPE` 拒绝，不会“尽力安装”。

## 8. 构建与验证

```bash
npm install          # 仅安装构建期依赖 esbuild，无运行时依赖
npm run build        # 生成 main.js
npm test             # node --test，覆盖路径/归档/备份/安装/卸载/套装/项目检查/UI 结构
npm run check        # 发布前检查：版本一致性、私有数据、语法、Skill 完整性
npm run verify       # 端到端：真实打包→安装→加载→回滚→备份恢复→套装导出→项目只读检查
```

`npm run verify` 全部在临时目录执行，不触碰正式 vault。

## 9. 目录结构

```
Plugins/vault-meta/
├── manifest.json / versions.json / package.json / esbuild.config.mjs
├── main.js                 # 构建产物（发布时随包提供）
├── styles.css
├── src/
│   ├── main.js             # 插件入口（视图、命令、设置、快捷备份）
│   ├── core/               # 纯 Node 逻辑，可独立测试
│   │   ├── paths.js fs-utils.js tar.js archive.js
│   │   ├── component-spec.js registry.js backup.js installer.js packager.js
│   │   ├── projects.js identity.js git-meta.js remote.js project-inspect.js
│   │   └── types/          # 组件类型处理器 + 私有数据规则
│   └── ui/                 # 视图、对话框、DOM 辅助、路径选择
├── test/                   # node:test 测试与 fixture
├── scripts/                # check-release.js / verify-integration.js
├── skills/vault-plugin-release/SKILL.md
└── examples/               # 组件与套装描述示例
```

本目录可直接作为独立仓库根目录使用；请勿把 vault 笔记、`data.json`、`.env` 或 `node_modules` 一并提交。

## 10. 已知限制

- 本仓库内的验证不包含 Obsidian 图形界面截图；UI 检查为 DOM 结构 / 可访问性 / 渲染冒烟与静态样式检查，**未做像素级视觉验证**。
- 首版不提供批量安装套装的图形流程（套装导出已实现；安装仍以单个组件包为单位）。
- 不提供自动定期备份与云端上传。
- 项目生命周期当前只到“看清三个位置”：不发布新版、不从发布版打包、不更新当前库、不恢复旧版、不归档，也不校验 release 资产。
- 云端检查未登录 GitHub，限额 60 次/小时；每个项目一次检查最多 4 个请求。分支头版本只作“开发线”展示，不等于已发布版本。
- “同版本不同代码”只在存在 `main.js` 构建产物或可比较提交时可强断言；源码目录过大时降级为“未计算源码身份”。
