'use strict';

/**
 * Vault 元系统管理 —— 独立 Obsidian 插件。
 * 首版只管理当前 vault：整库备份/恢复、组件登记/打包/安装/升级/卸载、套装导出。
 * 不自动创建远端仓库、不发布、不安装到其他 vault（除非用户显式指定目标）。
 */
const path = require('path');
const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { VaultMetaView, VIEW_TYPE } = require('./ui/view');
const { createDefaultTypeRegistry } = require('./core/types');
const { createBackup } = require('./core/backup');
const { describeError } = require('./core/errors');
const { loadRegistry, listRecords } = require('./core/registry');

const DEFAULT_SETTINGS = {
  backupDir: '',
  exportDir: '',
  lastBackupAt: '',
  lastBackupFile: '',
  openInSidebar: false,
};

class VaultMetaPlugin extends Plugin {
  async onload() {
    this.types = createDefaultTypeRegistry();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new VaultMetaView(leaf, this));
    this.addRibbonIcon('archive', 'Vault 元系统管理', () => this.activateView());
    this.addCommand({
      id: 'open-manager',
      name: '打开 Vault 元系统管理',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'open-restore',
      name: '打开“恢复”页',
      callback: () => this.activateView('restore'),
    });
    this.addCommand({
      id: 'quick-backup',
      name: '创建整库备份（使用已保存的备份目录）',
      callback: () => this.quickBackup(),
    });
    this.addSettingTab(new VaultMetaSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  getVaultRoot() {
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    return adapter && adapter.basePath ? adapter.basePath : '';
  }

  isSidebarLeaf(leaf) {
    const workspace = this.app.workspace;
    const root = leaf && typeof leaf.getRoot === 'function' ? leaf.getRoot() : null;
    if (!root) return false;
    return Boolean(
      (workspace.rightSplit && root === workspace.rightSplit)
      || (workspace.leftSplit && root === workspace.leftSplit),
    );
  }

  async activateView(tab) {
    const workspace = this.app.workspace;
    const wantSidebar = Boolean(this.settings.openInSidebar);
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    let leaf = leaves.find((item) => this.isSidebarLeaf(item) === wantSidebar) || null;
    if (!leaf) {
      leaf = wantSidebar
        ? workspace.getRightLeaf(false)
        : typeof workspace.getLeaf === 'function'
          ? workspace.getLeaf('tab')
          : workspace.getRightLeaf(false);
    }
    if (!leaf) {
      new Notice('无法打开管理器面板');
      return;
    }
    // 新建标签页自带 EmptyView，不能以 view 是否存在判断，必须看视图类型。
    const currentType = leaf.view && typeof leaf.view.getViewType === 'function'
      ? leaf.view.getViewType()
      : '';
    if (currentType !== VIEW_TYPE) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view && typeof view.setTab === 'function' && tab) await view.setTab(tab);
  }

  async quickBackup() {
    const vaultRoot = this.getVaultRoot();
    if (!vaultRoot) {
      new Notice('Vault 元系统管理仅支持 Obsidian 桌面端');
      return;
    }
    if (!this.settings.backupDir) {
      new Notice('尚未设置备份目录，请先在“恢复”页选择并保存');
      await this.activateView('restore');
      return;
    }
    try {
      const result = await createBackup({ vaultRoot, destDir: this.settings.backupDir });
      this.settings.lastBackupAt = result.manifest.createdAt;
      this.settings.lastBackupFile = result.file;
      await this.saveSettings();
      new Notice(`备份完成${result.verified ? '并已校验' : ''}：${result.fileCount} 个文件，${result.totalText}`, 8000);
    } catch (err) {
      const detail = describeError(err);
      new Notice(`备份失败：${detail.message}`, 10000);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class VaultMetaSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Vault 元系统管理 · 设置' });

    new Setting(containerEl)
      .setName('默认备份目录')
      .setDesc('保存整库备份的目录；可使用任意可访问的绝对路径（含 iCloud / OneDrive）。留空则使用 vault 同级目录。')
      .addText((text) =>
        text
          .setPlaceholder('/absolute/path/to/backups')
          .setValue(this.plugin.settings.backupDir)
          .onChange(async (value) => {
            this.plugin.settings.backupDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('默认导出目录')
      .setDesc('组件包（.vmpkg）与套装（.vmsuite）的默认输出目录。')
      .addText((text) =>
        text
          .setPlaceholder('/absolute/path/to/exports')
          .setValue(this.plugin.settings.exportDir)
          .onChange(async (value) => {
            this.plugin.settings.exportDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('打开位置')
      .setDesc('默认在主标签页中以完整宽度打开；侧栏适合常驻窄屏。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('tab', '主标签页')
          .addOption('sidebar', '右侧边栏')
          .setValue(this.plugin.settings.openInSidebar ? 'sidebar' : 'tab')
          .onChange(async (value) => {
            this.plugin.settings.openInSidebar = value === 'sidebar';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('登记状态')
      .setDesc('组件登记表位于 .obsidian/vault-meta/registry.json，随 vault 一起备份。')
      .addButton((button) =>
        button.setButtonText('查看已登记组件').onClick(() => {
          const vaultRoot = this.plugin.getVaultRoot();
          if (!vaultRoot) {
            new Notice('仅支持桌面端');
            return;
          }
          const records = listRecords(loadRegistry(vaultRoot).registry);
          new Notice(records.length === 0 ? '尚未登记任何组件' : `已登记 ${records.length} 个组件`);
        }),
      );

    const note = containerEl.createDiv({ cls: 'vm-note' });
    note.createEl('strong', { text: '重要边界' });
    note.createEl('p', {
      text: '云同步服务（iCloud / OneDrive / 坚果云）同步的是“当前状态”，误删会被同步，不能替代历史备份。请把本管理器生成的 .vmbak 归档视为备份。',
    });
    note.createEl('p', {
      text: '本插件不会自动运行定期备份；如需定时任务，请另行配置并自行确认其运行状态。',
    });
  }
}

module.exports = VaultMetaPlugin;
