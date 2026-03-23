// src/strategy.js
// 策略：
//
// ── 买入条件（同时满足）────────────────────────────────────────────
//   1. RSI(7) 上穿 30
//   2. 当前价格 ≤ 入场参考价 × (1 - 20%)
//      （入场参考价 = 代币被收录时 REST 拉取到的首个价格）
//
// ── 卖出条件（持仓时，任一触发）──────────────────────────────────
//   1. 止盈：当前价格 ≥ 买入均价 × (1 + 150%)
//   2. 止损：当前价格 ≤ 买入均价 × (1 - 30%)
//
// 整个监控周期（30分钟）内只允许买入一次（additionCount === 0 才触发）。
// 买入后记录成交价作为仓位基准价（buyEntryPrice），用于止盈/止损计算。

const { RSI }       = require('technicalindicators');
const config        = require('./config');
const tokenStore    = require('./tokenStore');
const webhookSender = require('./webhookSender');

const RSI_PERIOD   = config.rsi.period; // 默认 7，保留可配置

// 策略参数（可在 .env 覆盖，这里以 config 为主，fallback 硬编码）
const BUY_RSI_CROSS      = config.rsi.buyCross;           // 30  RSI 上穿阈值
const BUY_DROP_PCT       = config.rsi.buyDropPct  ?? 20;  // 20% 价格较参考价跌幅阈值
const SELL_TP_PCT        = config.rsi.sellTpPct   ?? 150; // 150% 止盈
const SELL_SL_PCT        = config.rsi.sellSlPct   ?? 30;  // 30%  止损

/**
 * 计算 RSI，数据不足时返回 null
 */
function calcRSI(closes) {
  if (closes.length < RSI_PERIOD + 1) return null;
  const values = RSI.calculate({ values: closes, period: RSI_PERIOD });
  if (!values || values.length === 0) return null;
  return values[values.length - 1];
}

/**
 * 每根 5s K 线封口后调用，执行策略判断
 */
async function evaluateStrategy(address) {
  const token = tokenStore.getToken(address);
  if (!token || !token.active) return;

  const closes = token.closes;
  // 需要 period+2 根才能判断交叉（当前值 + 前一值）
  if (closes.length < RSI_PERIOD + 2) return;

  const rsi     = calcRSI(closes);
  if (rsi === null) return;

  const prevRsi = token.rsi; // 上一根 K 线的 RSI
  token.prevRsi = prevRsi;
  token.rsi     = rsi;

  const price = token.price || closes[closes.length - 1];
  if (!price || price <= 0) return;

  // ── 持仓中：检查止盈 / 止损 ─────────────────────────────────────
  if (token.positionOpen && token.buyEntryPrice) {
    const pnlPct = ((price - token.buyEntryPrice) / token.buyEntryPrice) * 100;
    token.pnl    = parseFloat(pnlPct.toFixed(2));

    // 止盈：+150%
    if (pnlPct >= SELL_TP_PCT) {
      console.log(
        `[Strategy] SELL (TP +${pnlPct.toFixed(1)}%): ` +
        `${token.symbol} entry=$${token.buyEntryPrice} now=$${price}`
      );
      await webhookSender.sendSell(
        address, token.symbol,
        `TAKE_PROFIT_+${SELL_TP_PCT}%`,
        price
      );
      _resetPosition(token);
      return;
    }

    // 止损：-30%
    if (pnlPct <= -SELL_SL_PCT) {
      console.log(
        `[Strategy] SELL (SL ${pnlPct.toFixed(1)}%): ` +
        `${token.symbol} entry=$${token.buyEntryPrice} now=$${price}`
      );
      await webhookSender.sendSell(
        address, token.symbol,
        `STOP_LOSS_-${SELL_SL_PCT}%`,
        price
      );
      _resetPosition(token);
      return;
    }
  }

  // ── 空仓：检查买入条件 ───────────────────────────────────────────
  // 整个监控周期内只允许买入一次
  if (!token.positionOpen && token.additionCount === 0) {
    // 条件 1：RSI 上穿 30
    const rsiCrossUp =
      prevRsi !== null &&
      prevRsi < BUY_RSI_CROSS &&
      rsi     >= BUY_RSI_CROSS;

    if (!rsiCrossUp) return;

    // 条件 2：价格较入场参考价下跌 ≥ 20%
    const refPrice = token.refPrice; // 代币收录时记录的参考价
    if (!refPrice || refPrice <= 0) {
      console.log(
        `[Strategy] RSI cross↑${BUY_RSI_CROSS} but no refPrice yet for ${token.symbol}, skip`
      );
      return;
    }

    const dropPct = ((refPrice - price) / refPrice) * 100; // 正值 = 已下跌
    if (dropPct < BUY_DROP_PCT) {
      console.log(
        `[Strategy] RSI cross↑${BUY_RSI_CROSS} but drop=${dropPct.toFixed(1)}% < ${BUY_DROP_PCT}% for ${token.symbol}, skip`
      );
      return;
    }

    // 两条件同时满足 → 买入
    if (!token.active) return; // 异步期间可能已到期
    console.log(
      `[Strategy] BUY (RSI↑${BUY_RSI_CROSS} + drop ${dropPct.toFixed(1)}%): ` +
      `${token.symbol} ref=$${refPrice} now=$${price} RSI=${rsi.toFixed(2)}`
    );
    await webhookSender.sendBuy(
      address, token.symbol,
      `RSI_CROSS_UP_${BUY_RSI_CROSS}_DROP_${BUY_DROP_PCT}PCT`,
      price
    );
    token.positionOpen    = true;
    token.buyEntryPrice   = price;
    token.pnl             = 0;
    token.additionCount++;
  }
}

// ─── Helper ──────────────────────────────────────────────────────

function _resetPosition(token) {
  token.positionOpen  = false;
  token.buyEntryPrice = null;
  token.pnl           = 0;
  token.sellCount++;
}

module.exports = { calcRSI, evaluateStrategy };
