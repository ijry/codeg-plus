# PLUS 本地变更清单与上游同步

PLUS 指本仓库相对上游 [spacering-net/codeg](https://github.com/spacering-net/codeg)
的全部自有改动。本文档回答两个问题：上游更新了怎么跟进；本地改了什么、为什么存在。

## 同步机制：merge 流

- `main` = `upstream/main` + 本地 commit（含合并节点），不另设集成分支
- `plugins` 为封存分支，不参与日常同步；将来启用时 `git merge main`（其 40 个
  commit 落后上游较多，也可按需改走 rebase）
- 同步一条命令：`node scripts/sync-upstream.mjs`（fetch → merge → 冲突指引）
- `rerere.enabled = true`：相同冲突自动复用历史解法
- `remote.pushDefault = origin`：fetch/pull 面向上游，push 面向 fork（ijry/codeg-plus）

### 方案取舍

| 方案 | 适合 | 不适合 |
| --- | --- | --- |
| rebase | 本地 ≤ ~10 个小 commit | commit 多了每次逐个解冲突、SHA 全改写、必须 force push |
| **merge（采用）** | 本地功能成体系、长期演进 | 历史带合并节点（可接受） |
| patch 文件 | 无 git 历史的构建环境（如 Docker 构建期注入品牌） | 冲突无三方上下文、一断全断，只作补充不当主力 |

### 降低冲突面的规则（比 git 机制更重要）

1. **增量式落位**：自有功能放新文件/新组件，与上游的接线点压缩到一行
   import/注册，不改上游函数内部。
2. **品牌字段构建期注入**：包名、软件名、图标、identifier、updater 这类高频
   冲突字段不直接 patch 文件内容，改为构建期注入（待重建
   `scripts/apply-plus-identity.mjs`；旧实现在 reflog 的 `ce867362f`，约 60
   天内可 `git cherry-pick ce867362f` 找回）。
3. **每个本地 commit 登记到下表**：同步冲突时逐条核对"这个差异还要不要"。

## 本地变更清单

| commit | 主题 | 触碰的上游文件 | 说明 |
| --- | --- | --- | --- |
| 本次提交 | 上游同步机制 + 本文档 | `.gitignore`、`docs/`、`scripts/` | 基础设施，预期不冲突 |

## 向上游贡献（参考 PR #1062 的路径）

1. `git switch -c feat/xxx upstream/main`——从纯上游起点开分支
2. `git cherry-pick <main 上的本地 commit>`（或按 PR 范围重写）
3. push 到自己的 fork、向上游发 PR；上游合并后该内容与本地一致，merge 不再
   冲突，在下表把它标记为"已上游"
