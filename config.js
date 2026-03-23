// src/config.js
require('dotenv').config();

module.exports = {
  birdeye: {
    apiKey:  process.env.BIRDEYE_API_KEY || '',
    wsUrl:   'wss://public-api.birdeye.so/socket',
    restUrl: 'https://public-api.birdeye.so',
  },
  helius: {
    apiKey:  process.env.HELIUS_API_KEY || '',
    rpcUrl:  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`,
  },
  server: {
    port: parseInt(process.env.PORT) || 3003,
  },
  tradeBot: {
    buyUrl:  `http://${process.env.TRADE_BOT_HOST || 'localhost'}:${process.env.TRADE_BOT_PORT || 3002}/webhook/new-token`,
    sellUrl: `http://${process.env.TRADE_BOT_HOST || 'localhost'}:${process.env.TRADE_BOT_PORT || 3002}/force-sell`,
  },
  monitor: {
    tokenMaxAgeMinutes:    parseInt(process.env.TOKEN_MAX_AGE_MINUTES)    || 30,
    candleIntervalSeconds: parseInt(process.env.CANDLE_INTERVAL_SECONDS)  || 5,
  },
  rsi: {
    period:      parseInt(process.env.RSI_PERIOD)     || 7,
    buyCross:    parseFloat(process.env.RSI_BUY_CROSS) || 30,  // RSI 上穿阈值
    buyDropPct:  parseFloat(process.env.BUY_DROP_PCT)  || 20,  // 价格跌幅条件 (%)
    sellTpPct:   parseFloat(process.env.SELL_TP_PCT)   || 150, // 止盈百分比 (%)
    sellSlPct:   parseFloat(process.env.SELL_SL_PCT)   || 30,  // 止损百分比 (%)
  },
};
