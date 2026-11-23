# 采收服务：小票追溯与退赔归属

入口是一张小票。服务把业务资料（`source`）、温度网关与售后台（`provider`）串起来，回答三件事：

1. 这张票各行称的盘混入了哪些源批、各占多少克；
2. 每个盘在哪些柜区、哪些分钟停留，这些分钟的温度观测是否完整、有无适用的越线样本、还缺哪些文件；
3. 实际赔出多少、已受理未结多少、每个源批还能按多少克处理、哪部分因缺凭据暂不能处理。

## 启动

```sh
npm run source      # 业务资料，:8700
npm run provider    # 温度网关与售后台演练，:8701
npm run harvest     # 本服务，:8702（PORT 可改）
```

命令行直接看报告：

```sh
npm run trace -- R            # 当前资料版
npm run trace -- R --edition r2 --json
```

环境变量：`SOURCE_URL`、`PROVIDER_URL`、`PORT`、`JOURNAL_PATH`（默认 `./data/harvest-journal.jsonl`）、`TIMEOUT_MS`。

## 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 服务与上下游地址 |
| `GET /tickets/{ticket}/report?edition=r2` | 整票追溯报告 |
| `POST /tickets/{ticket}/claims` | 按行、源批、克数、操作号提交处置，提交后强制回读台账 |
| `GET /journal` | 本机处置操作日志 |

`POST` 请求体形如：

```json
{ "line": 1, "lot": "L3", "grams": 400, "key": "R-1-L3", "edition": "r2" }
```

## 判定口径

- **份额**：混盘均匀，按父盘组件克数递归展开到源批，再按小票行重量用最大余数法整数分摊，各行合计等于实购克数。无混合记录或出现循环的盘进 `unresolvedSources`，不归给最近一批。
- **在柜观测**：该盘每个在柜分钟都须有同区有效读数，窗口才可能判“完整未发现过温”；任一有效读数超过 6°C 即“已证实过温”，其余分钟仍可待补；其余情况为“观测不完整”。
- **区域绑定**：只采信网关 `cold/files` 的最新探头分区。历史 `temp` 摘要仅作对照，其越线在新分区下落不到该盘时记入 `legacy.conflict`，不用于定责。
- **缺口原因**：`file-not-fetched`（没取到文件）、`invalid-reading`（读数无效）、`probe-remapped`（探头已划到别的区）、`file-expired`（410 已移出）、`fetch-failed`（读取失败）。`requiredFiles` 与 `missingCoverage` 给出所需文件和待补分钟范围。
- **台账**：业务 `payout` 与售后台 `refunds/lines` 按（票、行、批、克数）合并，同一份货只占一次额，两边回执都保留。`accepted` 与 `paid` 都占可处理克数；已不在当前混盘的旧批进 `disputed`，旧回执不消失，其克数继续占用行总帽。
- **申请约束**：同一小票行合计处置不得超过实购克数，单批不得超过其行内份额。同一操作号重放透传售后台并以 409 回读；新操作号超量在本地 422 拦截；证据不完整或完整观测无越线的批不允许提交。

## 模块

| 文件 | 职责 |
| --- | --- |
| `harvest/source-client.mjs` | 分页 TSV、`Link` 跟随、ETag/304、资料版隔离 |
| `harvest/cold-client.mjs` | 滚动文件清单、TEMP 二进制解析、410 与读取失败分类 |
| `harvest/refund-client.mjs` | 售后台占额读取与处置提交 |
| `harvest/trace.mjs` | 份额展开、时窗评估、越线/缺口/旧版冲突判定 |
| `harvest/ledger.mjs` | 处置合并、争议保留、行帽与批份额余量 |
| `harvest/report.mjs` | 整票报告编排与上下游降级 |
| `harvest/service.mjs` | HTTP 接口与操作日志 |
| `harvest/cli.mjs` | 门店中文报告 |
