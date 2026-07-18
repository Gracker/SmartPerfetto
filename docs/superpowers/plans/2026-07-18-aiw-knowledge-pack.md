# AIW Knowledge Pack 实施计划

依据规格：
`docs/superpowers/specs/2026-07-18-aiw-knowledge-pack-design.md`

实施仓库：

- `/Users/chris/Code/android-internals-wiki`
- `/Users/chris/Code/SmartPerfetto/SmartPerfetto`
- 新建 `Gracker/android-internals-knowledge-pack`

> 执行修订（2026-07-18）：原计划中的 eligibility gate 已被“所有正文”政策取代。
> `src/**/*.md` 正文不再按 status、Task 6/Task 9 或 queue 过滤；这些字段只进入
> 审计。导航文件、明确的生成报告和无法安全恢复正文边界的文件仍排除，私有上下文
> 行先脱敏，高置信秘密继续阻止整次发布。下文若保留旧 eligibility 名称，均按此修订
> 解释。

## Phase 0：文档与允许 API

### 已核实 API

TUF Node 客户端使用 `tuf-js@6`：

- `new Updater({metadataDir, metadataBaseUrl, targetDir, targetBaseUrl, config})`
- `Updater.refresh()`
- `Updater.getTargetInfo(targetPath)`
- `Updater.findCachedTarget(targetInfo, filePath?)`
- `Updater.downloadTarget(targetInfo, filePath?, targetBaseUrl?)`

复制模式：

- `theupdateframework/tuf-js`
  `examples/client/client.ts`
- `packages/client/src/updater.ts`

TUF Python 发布端使用 `python-tuf@6` 和 `securesystemslib`：

- `Metadata(Root|Targets|Snapshot|Timestamp)`
- `Metadata.sign(signer, append=False)`
- `TargetFile.from_file(targetPath, localPath)`
- `CryptoSigner.generate_ed25519()`
- `Signer.from_priv_key_uri(...)`

复制模式：

- `theupdateframework/python-tuf`
  `examples/manual_repo/basic_repo.py`
- `examples/manual_repo/hashed_bin_delegation.py`

consistent snapshot 规则：

- root、targets、delegated targets、snapshot 使用版本前缀；
- `timestamp.json` 不加版本前缀；
- target 下载文件使用 hash 前缀；
- signed metadata 内仍引用逻辑文件名，不写版本前缀。

### 禁止模式

- 不自己实现 TUF metadata 验签或回滚判断；
- 不手拼 TUF signed JSON；
- 不使用 ad-hoc crypto wrapper；
- 不把公共 Pack 写进可变 `RagStore`；
- 不放宽私有 AIW connector 的 consent/scope/path gate；
- 不让 `task9_state`、`task9_result` 或 `auto-fixed` 参与正文入包判断；它们只用于审计。

## Phase 1：AIW 严格 Pack 构建器

### 新增文件

- `knowledge-pack/policy.yaml`
  - 仓库级 `include-body`
  - 目录与生成路径 exclude
  - 允许导出的 metadata 字段
  - 双许可证和 attribution
- `knowledge-pack/golden-queries.yaml`
  - 中英文混合 query
  - expected article path/id
  - negative query
- `knowledge-pack/requirements.txt`
  - 锁定 `PyYAML`
  - 锁定 `python-tuf`
  - 锁定 `securesystemslib`
- `scripts/knowledge_pack/__init__.py`
- `scripts/knowledge_pack/frontmatter.py`
  - 重复 key 拒绝
  - 字段类型与规范化
- `scripts/knowledge_pack/eligibility.py`
  - 全正文接纳与路径排除
  - status/pipeline/Task6/Task9/queue 审计汇总
  - 缺失或无效 metadata 的稳定回退
- `scripts/knowledge_pack/markdown_chunks.py`
  - heading/block parser
  - table/fence 原子块
  - 稳定 section/chunk ID
- `scripts/knowledge_pack/security_scan.py`
  - secret/private key/local path/private URL
- `scripts/knowledge_pack/sqlite_pack.py`
  - schema
  - FTS5
  - deterministic insert
  - quick_check
- `scripts/knowledge_pack/manifest.py`
  - manifest、fingerprint、hash、CalVer identity
- `scripts/build_knowledge_pack.py`
  - build CLI
- `scripts/verify_knowledge_pack.py`
  - 独立 verify CLI
- `tests/test_knowledge_pack.py`
  - Python `unittest`
- `tests/fixtures/knowledge-pack/**`
  - 最小 fixture corpus、queue、policy
- `COMMERCIAL-LICENSE.md`
  - 第二许可仅在另行书面授权后生效
- `KNOWLEDGE-PACK-LICENSE.md`
  - SmartPerfetto 构建/打包/再分发授权与下游边界

### 修改文件

- `LICENSE`
  - 保留 CC BY-NC-SA 正文
  - 增加替代商业许可说明
- `README.md`
- `README.en.md`
  - 双许可与 Knowledge Pack 说明
- `scripts/check-metadata.py`
  - 复用 strict loader，至少对 pack candidate 拒绝重复 key
- `.gitignore`
  - 忽略 `dist/knowledge-pack`

### 实现顺序

1. 先写 fixture 和正文接纳/strict YAML/fallback 单测。
2. 实现文章扫描与全正文 audit。
3. 实现 Markdown block/section/chunk。
4. 实现 SQLite schema/FTS。
5. 实现 manifest、gzip `mtime=0` 和 verifier。
6. 用当前 AIW 构建真实 Pack，检查所有正文进入且目录/生成报告按策略排除。

### 验证

- `python3 -m unittest discover -s tests -p 'test_knowledge_pack.py'`
- `python3 scripts/build_knowledge_pack.py --output dist/knowledge-pack --version 0.0.0-dev`
- `python3 scripts/verify_knowledge_pack.py --pack-dir dist/knowledge-pack`
- `python3 scripts/check-metadata.py`
- `python3 scripts/progress-report.py`
- 同输入两次构建后比较 manifest fingerprint、article/chunk IDs 和逻辑表内容
- `git diff --check`

## Phase 2：AIW 候选 CI

### 新增/修改文件

- `.github/workflows/knowledge-pack-candidate.yml`
  - push/PR path filter
  - Python 3.11
  - locked requirements
  - build + verify + golden queries
  - artifact attestation
  - 上传短期 candidate artifact
- `.github/workflows/build.yml`
  - 保留 mdBook
  - strict pack candidate schema 与现有 metadata check 对齐

### 验证

- 本地解析 workflow YAML；
- `gh workflow view` 推送后确认 workflow 注册；
- PR/push run 至少一次成功；
- artifact 中只出现 manifest、sqlite.gz、audit、licenses；
- artifact 不含 `src/` Markdown、logs、queue、绝对路径。

## Phase 3：公开分发仓库与 TUF bootstrap

### 外部状态

- 创建公开仓库 `Gracker/android-internals-knowledge-pack`；
- 创建最小权限 write deploy key；
- 私钥只进入 AIW repo secret；
- 生成 root、top-level targets、nightly delegated targets、
  snapshot、timestamp 独立 key；
- root/top-level targets 私钥离线保存，不进入 Actions；
- nightly/snapshot/timestamp 私钥进入独立 repo secrets。

### 公开仓库布局

- `README.md`
- `LICENSES/CC-BY-NC-SA-4.0.txt`
- `LICENSES/AIW-COMMERCIAL-LICENSE.md`
- `metadata/1.root.json`
- `metadata/1.targets.json`
- `metadata/<version>.nightly.json`
- `metadata/<version>.snapshot.json`
- `metadata/timestamp.json`
- `targets/channels/<hash>.stable.json`
- `targets/packs/<hash>.android-internals-<version>.sqlite.gz`
- `targets/audits/<hash>.android-internals-<version>.audit.json`

### AIW 新增文件

- `scripts/knowledge_pack/tuf_keys.py`
  - 只调用 `securesystemslib` signer API
- `scripts/knowledge_pack/tuf_repository.py`
  - 只调用 `python-tuf` metadata API
- `scripts/bootstrap_knowledge_pack_repository.py`
  - 一次性 root/targets/delegation bootstrap
- `scripts/publish_knowledge_pack.py`
  - 更新 nightly/snapshot/timestamp 和 hash target
- `scripts/canary_knowledge_pack.py`
  - 用全新客户端验证公开 URL 和黄金检索

### 验证

- Python client 从只含 `1.root.json` 的空 cache refresh；
- 下载 stable channel；
- 下载指定 Pack；
- TUF length/hash、SQLite quick_check、manifest 均通过；
- 篡改 target、回滚 metadata、过期 timestamp 均失败；
- root/top-level targets 私钥不在任何 Git 仓库或 workflow log。

## Phase 4：AIW 每日自动晋升与更新脚本

### 新增文件

- `.github/workflows/publish-knowledge-pack.yml`
  - `cron: '30 16 * * *'`（次日北京时间 00:30）
  - `workflow_dispatch`
  - concurrency group
  - checkout 精确 SHA
  - build/verify
  - fingerprint no-op
  - deploy-key checkout public repo
  - TUF publish
  - push public repo
  - clean-room canary
  - artifact attestation
- `scripts/update_knowledge_pack.sh`
  - 维护者统一入口
  - `--dry-run`
  - `--publish`
  - `--version`
  - `--revoke`
- `knowledge-pack/channel-policy.yaml`
  - metadata expiry
  - retained versions
  - `minimumSafeVersion`
  - revoked versions

### 验证

- dry-run 不修改 Git/远端；
- 相同 fingerprint no-op；
- 同日修复版本 `N` 递增；
- 两个并发 publish 只有一个成功；
- revoke 后 clean client 拒绝不安全版本；
- GitHub scheduled 和 manual run 成功。

## Phase 5：SmartPerfetto 只读 Pack Store

### 新增文件

- `backend/src/services/androidInternalsPack/types.ts`
- `backend/src/services/androidInternalsPack/manifest.ts`
- `backend/src/services/androidInternalsPack/packPaths.ts`
- `backend/src/services/androidInternalsPack/androidInternalsPackStore.ts`
  - `better-sqlite3` immutable/read-only
  - FTS5/BM25 query
  - query token normalization
- `backend/src/services/androidInternalsPack/androidInternalsPackResolver.ts`
  - pin > active > bundled
  - last-known-good
- `backend/src/services/androidInternalsPack/backgroundKnowledgeReferences.ts`
- `backend/src/services/androidInternalsPack/__tests__/**`
- `backend/knowledge/aiw-pack/1.root.json`
- `backend/knowledge/aiw-pack/knowledge-packs.lock.json`
- `backend/knowledge/aiw-pack/LICENSES/**`

### 修改文件

- `backend/package.json`
- `backend/package-lock.json`
  - 增加 `tuf-js@6`
- `backend/src/types/sparkContracts.ts`
  - 新增 `android_internals_pack`
  - 新增 `BackgroundKnowledgeReference`
- `backend/src/services/rag/searchTokens.ts`
  - 复用 query normalization，不改变既有结果
- `backend/src/services/rag/lookupResponseFilter.ts`
  - 公共 Pack 的预算/脱敏/引用投影

### API 模式

- 复制 `better-sqlite3` 现有 store 的只读/close/quick_check 模式；
- 复制 `RagStore.search()` 的输入上限和返回 contract；
- 不调用 `RagStore.addChunks()`；
- Pack store 每个实例固定 manifest version/fingerprint。

### 验证

- manifest/schema/hash/compatibility；
- 中文 bigram、camelCase、snake_case；
- title/heading/tag/body 权重；
- Top-K 上限、空查询、超长查询；
- immutable DB；
- 损坏/不兼容 Pack 失败关闭；
- public/private source kind 不混淆。

## Phase 6：SmartPerfetto TUF 更新器与会话 pin

### 新增文件

- `backend/src/services/androidInternalsPack/knowledgePackUpdater.ts`
  - `tuf-js Updater`
  - file lock
  - staging
  - gzip 安全解压
  - validation
  - atomic pointer
  - retention
- `backend/src/services/androidInternalsPack/knowledgePackUpdateWorker.ts`
  - startup async check
  - 24h unref timer
  - stop handle
- `backend/src/services/androidInternalsPack/knowledgePackStatus.ts`
- `backend/src/services/androidInternalsPack/__tests__/knowledgePackUpdater.test.ts`
- `backend/src/services/androidInternalsPack/__tests__/knowledgePackSessionPin.test.ts`

### 修改文件

- `backend/src/runtimePaths.ts`
  - 继续通过 `backendDataPath('knowledge-packs')`，不新增 CWD 特例
- `backend/src/index.ts`
  - 启动/停止 updater worker
- `backend/src/agentv3/claudeMcpServer.ts`
  - `source: android_internals_pack`
  - MCP server 创建时固定 Pack handle
  - 更新后旧会话不切换
  - revoke 后使用现成
    `analysis_context_changed_restart_required`
- `backend/src/agentv3/sessionStateSnapshot.ts`
- `backend/src/services/resolvedAnalysisContext.ts`
  - 持久化/校验 Pack version + fingerprint
- `backend/.env.example`
  - enable/mode/pin/mirror/interval

### 验证

- TUF 错误签名、过期、rollback、hash mismatch；
- 下载中断、gzip bomb、SQLite corrupt；
- 并发 updater；
- active 指针原子切换；
- last-known-good；
- offline/read-only；
- session pin；
- revoke/minimum-safe-version；
- worker timer `unref()` 和 graceful stop。

## Phase 7：MCP、引用、报告与快照

### 修改/新增文件

- `backend/src/agentv3/claudeMcpServer.ts`
  - tool description 强制 background-only
  - 返回 Pack citation metadata
- `backend/src/services/rag/sessionToolResultRegistry.ts`
  - 记录 `BackgroundKnowledgeReference`
- `backend/src/services/agentResultNormalizer.ts`
- `backend/src/services/htmlReportGenerator.ts`
- `backend/src/services/analysisResultSnapshotPipeline.ts`
- `backend/src/cli-user/services/turnPersistence.ts`
- 对应 contract/types/tests
- `docs/reference/mcp-tools.md`
- `docs/getting-started/android-internals-knowledge.md`

### 反模式

- AIW hit 不注册为 Trace `evidenceRefId`；
- AIW 不满足 plan expectedCalls；
- report 保留引用不等于 claim verifier 接受它为当前 Trace 证据；
- SSE/log 不复制正文。

### 验证

- chat 简洁引用；
- report/CLI/snapshot 完整 provenance；
- SSE 只有允许元数据；
- claim verifier 仍要求 SQL/Skill；
- private connector title/URI 隐藏规则不回归。

## Phase 8：CLI、health 与发行资产

### 新增/修改文件

- `backend/src/cli-user/commands/knowledgePack.ts`
- `backend/src/cli-user/bin.ts`
  - `smp knowledge-pack status`
  - `smp knowledge-pack update`
- `backend/src/cli-user/services/runtimeGuard.ts`
  - doctor status/version/fingerprint/license
- `backend/src/agentRuntime/runtimeHealth.ts`
- `backend/scripts/fetch-aiw-knowledge-pack.cjs`
  - 按 lock + TUF 下载 bundled snapshot
- `backend/scripts/check-cli-pack.cjs`
- `backend/package.json`
  - `knowledge-pack:fetch`
  - `knowledge-pack:verify`
  - `prepack` 在 build 前 fetch
- `backend/knowledge/aiw-pack/bundled/<version>/`
  - 提交 lock 固定且已验证的压缩快照，保证 source 离线首启
- `Dockerfile`
  - builder fetch，runtime 从 builder copy verified Pack
- `scripts/package-portable.sh`
  - 打包前 fetch
- `scripts/verify-portable-package.cjs`
  - manifest/version/hash/license
- `scripts/__tests__/runtime-distribution-assets.test.mjs`
- release/package docs

### 验证

- `npm --prefix backend run cli:pack-check`
- isolated `npm pack` install：
  - `smp --version`
  - `smp doctor --format json`
  - `smp knowledge-pack status`
- Docker build + health + Pack status；
- portable build/manifest verify；
- source checkout 使用 committed bundled Pack，升级 lock 时 fetch 并验证新快照；
- offline发行物使用 bundled snapshot。

## Phase 9：总体验证、审查和交付

### SmartPerfetto 项目门禁

- 相关 focused Jest；
- `npm --prefix backend run typecheck`
- `npm --prefix backend run test:architecture`
- `npm --prefix backend run test:scene-trace-regression`
- `npm --prefix backend run cli:pack-check`
- portable/Docker 相关静态与真实 smoke；
- `npm run check:perfetto-skills-impact`，记录
  `not_required` 或按结果处理；
- `npm run verify:pr`
- 人工 simplify review + `git diff --check`（若无 `/simplify` 或项目脚本）。

### AIW 门禁

- Knowledge Pack unittest/build/verify/determinism/golden queries；
- metadata/progress/mdBook；
- GitHub candidate + nightly publish workflow；
- 公开仓库 clean client canary。

### 独立审查

- 构建/资格/泄漏审查；
- TUF/updater/atomicity/revocation 审查；
- SmartPerfetto public/private/privacy/evidence 审查；
- npm/Docker/portable/source completeness 审查。

### 提交与 push

1. AIW 提交并 push `master`；
2. 公开 Pack 仓库提交 bootstrap 和首个稳定版本并 push `main`；
3. SmartPerfetto 提交实现并 push `main`；
4. 等待三个仓库相关 Actions；
5. 从公开 URL 和干净 npm/Docker/portable 路径做最终 canary；
6. 确认用户已有 `docs/README.md` 改动未被误提交。
