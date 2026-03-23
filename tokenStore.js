// src/tokenStore.js
// In-memory whitelist & signal log for monitored tokens

const EventEmitter = require('events');

class TokenStore extends EventEmitter {
  constructor() {
    super();
    // Map<address, TokenInfo>
    this.tokens = new Map();
    // Array of signal log entries
    this.signalLog = [];
  }

  /**
   * Add a token to the whitelist
   * @param {string} address
   * @param {string} symbol
   * @param {string} network
   */
  addToken(address, symbol, network = 'solana') {
    if (this.tokens.has(address)) {
      return this.tokens.get(address);
    }
    const token = {
      address,
      symbol,
      network,
      addedAt:       Date.now(),
      age:           0,      // minutes since added

      // Market data
      lp:            null,   // liquidity pool USD
      fdv:           null,   // fully diluted valuation USD
      price:         null,
      priceChange:   null,

      // Strategy state
      refPrice:      null,   // 收录时的参考价（买入条件基准）
      buyEntryPrice: null,   // 本次持仓买入价（止盈/止损基准）
      pnl:           0,      // 当前持仓浮动盈亏 %

      // Candle / RSI
      candles:       [],     // 5s candle objects
      closes:        [],     // close prices for RSI
      rsi:           null,
      prevRsi:       null,

      // Position flags
      positionOpen:  false,  // 是否当前持仓
      additionCount: 0,      // 累计买入次数
      sellCount:     0,      // 累计卖出次数

      active: true,
    };
    this.tokens.set(address, token);
    this.emit('tokenAdded', token);
    return token;
  }

  getToken(address) {
    return this.tokens.get(address);
  }

  getAllTokens() {
    return Array.from(this.tokens.values());
  }

  getActiveTokens() {
    return Array.from(this.tokens.values()).filter(t => t.active);
  }

  removeToken(address) {
    const token = this.tokens.get(address);
    if (token) {
      token.active = false;
      this.emit('tokenRemoved', token);
    }
  }

  /**
   * Update token market data
   */
  updateTokenData(address, data) {
    const token = this.tokens.get(address);
    if (!token) return;
    Object.assign(token, data);
    this.emit('tokenUpdated', token);
  }

  /**
   * Push a new 5s candle close price
   */
  pushClose(address, closePrice) {
    const token = this.tokens.get(address);
    if (!token || !token.active) return;
    token.closes.push(closePrice);
    // Keep last 200 closes
    if (token.closes.length > 200) {
      token.closes.shift();
    }
  }

  /**
   * Log a trading signal
   */
  logSignal(address, symbol, type, strategy, price) {
    const entry = {
      id:        Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      address,
      symbol,
      type,      // 'BUY' | 'SELL'
      strategy,
      price,
    };
    this.signalLog.unshift(entry);
    // Keep last 500 entries
    if (this.signalLog.length > 500) this.signalLog.pop();
    this.emit('signalLogged', entry);
    return entry;
  }

  getSignalLog(limit = 100) {
    return this.signalLog.slice(0, limit);
  }
}

module.exports = new TokenStore();
