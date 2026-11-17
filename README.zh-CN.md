# Plan Files for DeepSeek Harness

[English guide](README.md)

DSH Plan Files 为 DeepSeek Harness（DSH）保存独立的 Markdown 计划文件，并沿用 DSH 原生 Plan Review 完成反馈和审批。

插件支持 DSH `0.2.2-rc.3`，需要 Node.js 22 或以上版本。

## 安装

### 本地源码

克隆仓库后，将仓库根目录安装到所用的 DSH profile。下面以原生 `tui` profile 为例。

```bash
git clone https://github.com/paigeman/dsh-plan-files.git
cd dsh-plan-files
dsh plugin --profile tui add "link:$PWD"
dsh --profile tui --dump-config
```

在输出中检查组件 ID `plan-files` 和包名 `dsh-plan-files`。本地安装会引用源码目录，需要保留该目录。

使用 DSH Desktop 时，打开 **插件**，选择 **添加插件**，安装来源选本地目录，填入仓库的绝对路径。安装后启用 bundle 及 **计划文件** 组件。

### npm 包

可以直接按包名安装到所用 profile。

```bash
dsh plugin --profile tui add dsh-plan-files
```

Desktop 的插件管理器中选择 npm registry 来源，输入 `dsh-plan-files` 即可。

## 使用流程

```text
/plan
  → 创建并保存 Markdown 计划文件
  → 打开原生 Plan Review
  → 用户提供自然语言修改意见
  → Agent 局部编辑同一文件
  → 再次打开原生 Plan Review
  → 批准后退出 Plan Mode，并保留文件
```

用户照常用自然语言反馈，Agent 自行定位相关段落，通过精确替换或局部补丁修订同一文件。补丁外文本原样保留。意见存在歧义，或修改范围需要明显扩大时，再澄清。

插件沿用原生 `/plan`、`exit_plan_mode`、**Approve**、**Keep planning** 和反馈流程。

## 计划文件

计划文件的默认目录为 `~/.dsh/plans/`，配置 `DSH_HOME` 时会使用对应目录。文件名采用以下形式。

```text
~/.dsh/plans/YYYY-MM-DD-任务摘要-短ID.md
```

`plan_file` 工具负责首次创建，并提供 `read` 和 `edit` 动作。修改时提交上次读取的文件版本及精确的 `old_text`、`new_text` 替换。工具参数由 Agent 处理，用户照常用自然语言反馈。

每个会话关联一个计划文件。反馈、恢复会话，以及退出后再次进入 Plan Mode，都会继续使用这个文件。Fork 会根据继承历史中最后记录的计划内容，为新会话创建独立副本。计划目录下的 `.state/` 保存简要关联记录。首次创建先记录文件身份，再发布 Markdown，写入中断后可以重试同一路径。

## 编辑与审批检查

精确编辑保留匹配范围外的文本，包括换行格式、UTF-8 BOM 和文件末尾是否换行。匹配不唯一、编辑重叠、版本过期和全文替换会被拒绝。原生文件工具对计划目录的写入会被引导到 `plan_file`，嵌套工具调用也经过这些检查。

插件核对 `exit_plan_mode` 参数与已保存文件，在打开审批及将批准答案交还原生工具前再次检查文件。读取、搜索、临时目录操作和其他工具沿用 DSH 现有权限。

Shell 和其他独立进程仍使用 DSH 既有权限。拥有计划目录写权限的进程可以绕过文件工具限制，版本检查会检测已经观察到的外部改动。对于非协作的外部写入，DSH 文件后端在版本检查到文件发布之间仍有竞态窗口。

## 兼容性

| 插件版本          | 支持的 DSH 版本 |
| ----------------- | --------------- |
| 0.1.0             | 0.2.2-rc.3      |
| 0.1.1（当前源码） | 0.2.2-rc.3      |

支持的 DSH 版本与 `engines.dsh` 及固定版本的测试 workspace 一致。GitHub Actions 已配置 Linux、macOS、Windows 的原生兼容性测试和打包验证。本地已在 macOS 验证 DSH 原生运行时及 Desktop 真实模型会话，覆盖标准预设和 PTC 预设。另已验证 dsh-TUI `0.20.1` 的兼容性，包括 `/plan` 选择器和 Shift+Tab 只读模式。Linux 沙箱行为尚未验证。

## 参与开发

开发环境、格式化规则、lint 命令和 CI 检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

版本标签会触发打包验证、GitHub Release 创建，并在 npm 发布配置启用后执行发包。发布预演和版本标签见[发布说明](CONTRIBUTING.md#releases)。

本项目采用 MIT 许可。
