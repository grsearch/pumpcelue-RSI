// src/tokenMonitor.js
// 代币生命周期管理：加入白名单、元数据刷新、年龄追踪、到期退出
//
// 新策略下不再立即发 BUY；
// 仅记录 refPrice（代币首次 REST 拉到的价格）供策略比较用。

const tokenStore    = require('./tokenStore');
const birdeyeWs     = require('./birdeyeWs');
const { getTokenOverview, getOHLCV } = require('./birdeyeRest');
const { evaluateStrategy }           = require('./strategy');
const webhookSender = require('./webhookSender');
const config        = require('./config');

const MAX_AGE_MS = config.monitor.tokenMaxAgeMinutes * 60 * 1000;

/**
 * 收到扫描服务器 webhook 时调用
 */
async function onTokenReceived({ address, symbol, network }) {
  console.log(`[Monitor] New token: ${symbol} (${address})`);

  // 加入内存白名单
  const token = tokenStore.addToken(address, symbol, network);

  // 1) 拉取初始元数据，将当前价格记为 refPrice（策略参考价）
  await refreshMetadata(address);
  const tok = tokenStore.getToken(address);
  if (tok && tok.price) {
    tok.refPrice = tok.price;
    console.log(`[Monitor] Ref price recorded: $${tok.price} for ${symbol}`);
  } else {
    console.log(`[Monitor] No price available yet for ${symbol}, refPrice will be set on first WS trade`);
  }

  // 2) 用历史 1m K 线预热 RSI（新币可能无数据，属正常）
  await seedHistoricalCloses(address);

  // 3) 订阅成交流，开始实时聚合 5s K 线
  birdeyeWs.subscribe(address);

  // 4) 启动年龄计时器
  startAgeTicker(address);
}

/**
 * 从 BirdEye REST 刷新元数据（LP / FDV / 价格）
 */
async function refreshMetadata(address) {
  const overview = await getTokenOverview(address);
  if (overview) {
    tokenStore.updateTokenData(address, {
      lp:          overview.lp,
      fdv:         overview.fdv,
      price:       overview.price,
      priceChange: overview.priceChange,
    });
  }
}

/**
 * 预热 RSI 历史数据
 *
 * BirdEye REST 最小粒度为 1m，不提供 5s 历史。
 * 对新币（< RSI_PERIOD+2 根 1m bar）RSI 无法立即计算，
 * 等 WS 推入足够的 5s 成交后自动启动——正常行为，约 45s 后就绪。
 */
async function seedHistoricalCloses(address) {
  const candles = await getOHLCV(address, 50);
  const token   = tokenStore.getToken(address);
  if (!token) return;

  if (candles && candles.length > 0) {
    const closes = candles
      .map(c => c.c ?? c.close ?? null)
      .filter(v => v !== null && v > 0);

    if (closes.length > 0) {
      token.closes = closes;
      console.log(
        `[Monitor] Seeded ${closes.length} x 1m closes for ${token.symbol} ` +
        `(RSI needs ${config.rsi.period + 2} min)`
      );
      return;
    }
  }
  console.log(`[Monitor] No history for ${token.symbol} — RSI warms up from live trades`);
}

/**
 * 每秒检查代币年龄，到期则发 SELL 并移出白名单
 */
function startAgeTicker(address) {
  let lastMetaRefresh = Date.now();

  const interval = setInterval(async () => {
    const token = tokenStore.getToken(address);
    if (!token || !token.active) {
      clearInterval(interval);
      return;
    }

    const now   = Date.now();
    const ageMs = now - token.addedAt;
    token.age   = Math.floor(ageMs / 60000);

    // 每 30s 刷新一次元数据
    if (now - lastMetaRefresh >= 30000) {
      lastMetaRefresh = now;
      await refreshMetadata(address);
    }

    // 到期处理
    if (ageMs >= MAX_AGE_MS) {
      console.log(`[Monitor] Expired: ${token.symbol} (${token.age}m)`);
      clearInterval(interval);
      if (token.positionOpen) {
        await webhookSender.sendSell(address, token.symbol, 'AGE_EXPIRE', token.price);
        token.positionOpen = false;
      }
      birdeyeWs.unsubscribe(address);
      tokenStore.removeToken(address);
      console.log(`[Monitor] Removed: ${token.symbol}`);
    }
  }, 1000);
}

/**
 * 每根 5s K 线封口时执行策略
 */
tokenStore.on('newCandle', async ({ address, candle, token }) => {
  if (!token.active) return;

  // 若 REST 未能拿到 refPrice，用第一根 K 线的 open 兜底
  if (!token.refPrice && candle.open > 0) {
    token.refPrice = candle.open;
    console.log(`[Monitor] refPrice set from first candle open: $${candle.open} for ${token.symbol}`);
  }

  try {
    await evaluateStrategy(address);
  } catch (err) {
    console.error(`[Monitor] Strategy error for ${token.symbol}:`, err.message);
  }
});

module.exports = { onTokenReceived, refreshMetadata };
