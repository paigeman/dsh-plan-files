# Plan Files for DeepSeek Harness

[English guide](README.md)

DSH Plan Files 计划为 DeepSeek Harness（DSH）提供独立的 Markdown 计划文件，并沿用 DSH 原生 Plan Review 完成反馈和审批。

项目目前处于调查与设计阶段，仓库已建立格式化和 lint 工具链。下面描述的是插件预期提供的工作流程。

## 预期使用流程

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

设计沿用原生 `/plan`、`exit_plan_mode`、**Approve**、**Keep planning** 和反馈流程。

## 计划文件

计划文件的默认目录为 `~/.dsh/plans/`，文件名采用以下形式。

```text
~/.dsh/plans/YYYY-MM-DD-任务摘要-短ID.md
```

第一次提交审批前，计划已经保存为文件。后续每次审批展示的内容都需要与当前文件一致，批准后保留该文件。文件关联需要覆盖会话恢复、并行会话、同会话多个计划、Fork、外部修改和写入中断。

当前实现方向是局部编辑计划文件，再调用原生 `exit_plan_mode`。插件新增的权限检查集中在当前计划文件的写入与提交审批，其他工具沿用 DSH 现有权限。

## 兼容性调查

静态源码核查采用以下版本和提交。

| 组件 | 调查版本     | 源码提交                                                                                                 |
| ---- | ------------ | -------------------------------------------------------------------------------------------------------- |
| DSH  | `0.2.2-rc.3` | [38a6a5c](https://github.com/deepseek-ai/deepseek-harness/tree/38a6a5c965aa99ab525161efb7cc5cf1fe62fced) |

端到端行为与 Linux 沙箱仍需在隔离测试环境中验证。

## 参与开发

开发环境、格式化规则、lint 命令和 CI 检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。
