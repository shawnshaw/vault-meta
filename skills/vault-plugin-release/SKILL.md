---
name: vault-plugin-release
description: 维护并发布一个 Obsidian 插件前的标准流程：README、版本一致性、构建、独立安装验证、私有数据检查。适用于本仓库内的插件（如 vault-meta、knowledge-canvas、task-workflow-enhancer）以及从 vault 拆出的独立插件仓库。
---

# 插件发布维护 Skill

> 目标：让"能跑"变成"可交付"。发布前逐项执行，任何一项失败都不得发版。
> 边界：本 Skill **不创建远端仓库、不推送、不发布 Release、不安装到正式 vault**；这些动作必须由人确认后单独执行。

## 1. README 检查

- [ ] 说明插件用途、边界与已知限制（尤其"云同步 ≠ 备份""不运行自动任务"这类容易误解的点）。
- [ ] 写清安装方式：`.obsidian/plugins/<id>/` 下需要哪些文件。
- [ ] 写清数据位置与格式；涉及用户数据时说明如何备份与恢复。
- [ ] 不包含个人绝对路径、内网地址、真实密钥示例。

## 2. 版本一致性

同一版本号必须同时出现在：

| 文件 | 字段 |
| --- | --- |
| `manifest.json` | `version` |
| `package.json` | `version` |
| `versions.json` | `"<version>": "<minAppVersion>"` |
| `CHANGELOG.md` | 顶部版本小节（如仓库有） |

```bash
node -e "const m=require('./manifest.json'),p=require('./package.json');if(m.version!==p.version)process.exit(1)"
```

## 3. 构建

```bash
npm ci || npm install
npm run build          # esbuild 打包 src → main.js，external: obsidian/electron
```

- 只提交源码与该提交对应的 `main.js`；不要提交 `node_modules`。
- 构建后抽检 `main.js` 是否包含非预期内容（`grep -c "require(\"fs\")"` 等）。
- 若插件依赖 Node 能力（文件系统、child_process），`manifest.json` 必须 `isDesktopOnly: true`。

## 4. 独立安装验证

在**临时目录**创建干净 vault，而不是覆盖正式 vault：

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.obsidian/plugins/<id>"
cp manifest.json main.js styles.css "$TMP/.obsidian/plugins/<id>/" 2>/dev/null || true
```

- [ ] 插件能被解析加载（无顶层异常）。
- [ ] 命令/视图/设置页按预期注册。
- [ ] 至少执行一次真实功能（如备份 → 校验 → 恢复；或打包 → 安装 → 卸载）。
- [ ] 失败路径也要验证一次（冲突、缺失依赖、回滚）。
- [ ] 卸载/删除插件后不残留关键文件，不误删用户数据。

本仓库的 `npm run verify` 已把这些步骤自动化，可直接复用。

## 5. 私有数据检查

发布包中不得出现：

- `data.json`（插件设置，可能含 token / cookie / 绝对路径）
- `.env`、`.env.*`
- `*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.kdbx`
- 含 `credential` / `secret` / `token` / `password` 命名的文件
- `.git/`、`node_modules/`、`*.map`、`*.log`
- 任何 vault 笔记、附件或导出数据

```bash
npm run check           # 内置扫描 + 版本/语法/Skill 检查
grep -rIn --exclude-dir=node_modules -E "(/Users/|/home/|Mobile Documents|com~apple~CloudDocs)" .
```

> 插件设置文件是用户数据：升级与卸载都应保留，不得打包、不得删除。

## 6. 交付清单

- [ ] `README.md` 更新
- [ ] `manifest.json` / `package.json` / `versions.json` / `CHANGELOG.md` 版本一致
- [ ] `main.js` 为最新构建产物
- [ ] `npm test`、`npm run check`、`npm run verify` 全部通过
- [ ] 独立安装验证记录（命令、结果、临时 vault 位置）
- [ ] 私有数据扫描无命中
- [ ] 未自动建远端、未发布、未安装到正式 vault（如需，交给人执行）

## 7. 绝对禁止

- ❌ 在 vault 仓库上给插件打 tag
- ❌ 只改 `main.js` 不改源码（下次构建会被覆盖）
- ❌ 为了"通过"而删除失败测试或跳过检查
- ❌ 把 `data.json`、笔记、密钥、Cookie 打进发布包
- ❌ 未经确认推送 / 发版 / 覆盖正式 vault
