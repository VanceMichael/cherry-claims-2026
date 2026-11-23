// 命令行：node harvest/cli.mjs <小票号> [--edition r2] [--json]
// 按门店视角打印：混盘来源份额、柜区时窗与所需文件、证据缺口、实际赔出/已受理/剩余可处理。

import { buildTicketReport } from './report.mjs'

const reasonText = {
  'file-not-fetched': '未取到覆盖该分钟的探头文件',
  'invalid-reading': '该分钟读数无效',
  'file-expired': '温度原件当天已移出（410）',
  'probe-remapped': '探头已按最新分区划到其他柜区',
  'fetch-failed': '温度原件读取失败',
  'evidence-incomplete': '在柜观测不完整，暂不能排除过温',
  'no-excursion-found': '完整观测未发现过温',
  'no-claimable-grams': '该批份额或行总帽已无可处理克数',
  'over-occupied': '该批占额已超当前份额',
  'lot-not-in-current-mix': '该批已不在当前混盘，旧回执保留待回收',
  'no-source-record': '缺少该盘的来源混合记录',
  'mix-cycle': '混盘关系存在循环'
}

const verdictText = {
  'confirmed-excursion': '已证实过温',
  'complete-no-excursion': '完整观测未发现过温',
  incomplete: '观测不完整，待补证据'
}

function reason(reason) {
  return reasonText[reason] ?? reason
}

function printReport(report) {
  console.log(`小票 ${report.ticket}（资料版 ${report.edition}，生成于 ${report.generatedAt}）`)
  if (!report.cold.gatewayOk) console.log(`  ! 温度网关不可用：${report.cold.gatewayError}`)
  if (!report.cold.refundDeskOk) console.log(`  ! 售后台不可用：${report.cold.refundDeskError}`)
  for (const failure of report.cold.failures) {
    console.log(`  ! 温度文件缺口：${failure.path ?? failure.sensor ?? ''} ${reason(failure.reason)}`)
  }

  for (const line of report.lines) {
    console.log(`\n行 ${line.line}  实购 ${line.purchasedGrams} 克，称重盘：` +
      line.plates.map(item => `${item.plate} ${item.weighedGrams}克`).join('、'))

    for (const window of line.windows) {
      console.log(`  时窗 盘${window.plate} / 柜区${window.zone} / 分钟[${window.from}, ${window.until})：${verdictText[window.verdict]}`)
      for (const sample of window.excursionSamples) {
        console.log(`    - 越线样本：第${sample.minute}分钟 ${sample.celsius}°C（探头${sample.sensor}，文件 ${sample.path}）`)
      }
      for (const gap of window.gaps) {
        console.log(`    - 缺口：第${gap.minute}分钟 ${reason(gap.reason)} ${gap.detail ?? ''}`)
      }
      for (const file of window.requiredFiles) {
        console.log(`    - 所需文件：${file.path}（探头${file.sensor}，本盘需要分钟[${file.from}, ${file.until})）`)
      }
      for (const conflict of window.legacy.conflict) {
        console.log(`    - 旧版冲突：第${conflict.minute}分钟旧摘要 ${conflict.celsius}°C，按最新分区与本盘位置无关`)
      }
    }

    if (line.unresolvedSources.length) {
      for (const item of line.unresolvedSources) {
        console.log(`  - 来源待查：盘${item.plate ?? item.id} ${reason(item.reason)}`)
      }
    }

    console.log('  源批分摊与可处理范围：')
    for (const lot of line.lots) {
      const tag = lot.processable ? '可处理' : '暂不能处理'
      console.log(`    批 ${lot.lot}：份额 ${lot.shareGrams} 克，判定「${verdictText[lot.verdict]}」，${tag}` +
        `（已占 ${lot.occupancy.occupiedGrams}，本批剩 ${lot.occupancy.lotRemainingGrams}，可申请 ${lot.occupancy.claimableGrams}）`)
      for (const blocker of lot.blockers) {
        console.log(`      × ${reason(blocker.reason)} ${blocker.detail ?? ''} ${blocker.zone ? `（盘${blocker.plate}/区${blocker.zone}/第${blocker.minute}分钟）` : ''}`)
      }
    }

    const summary = line.ledger.summary
    console.log(`  行台账：实际赔出 ${summary.paidGrams} 克，已受理未结 ${summary.acceptedGrams} 克，` +
      `合计占用 ${summary.occupiedGrams}/${line.purchasedGrams} 克，剩余可处理 ${summary.remainingGrams} 克`)
    for (const item of line.ledger.dispositions) {
      console.log(`    回执 ${item.receipts.join('/')}：批${item.lot} ${item.grams}克（${item.state}，来源 ${item.sources.join('+')}）`)
    }
    for (const item of line.ledger.disputed) {
      console.log(`    争议保留：回执 ${item.receipts.join('/')} 批${item.lot} ${item.grams}克（${item.state}）— ${reason(item.reason)}`)
    }
  }
}

const args = process.argv.slice(2)
const ticket = args[0]
if (!ticket) {
  console.error('用法：node harvest/cli.mjs <小票号> [--edition r2] [--json]')
  process.exit(2)
}
const editionArg = args.includes('--edition') ? args[args.indexOf('--edition') + 1] : undefined
const asJson = args.includes('--json')

const report = await buildTicketReport({
  ticket,
  edition: editionArg,
  sourceUrl: process.env.SOURCE_URL || 'http://127.0.0.1:8700',
  providerUrl: process.env.PROVIDER_URL || 'http://127.0.0.1:8701'
})
if (asJson) console.log(JSON.stringify(report, null, 2))
else printReport(report)
