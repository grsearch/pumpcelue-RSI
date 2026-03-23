// src/birdeyeWs.js
// BirdEye WebSocket — 订阅成交流 (SUBSCRIBE_TXS)
//
// 修复要点（对比旧版）：
//   1. WS URL 加上链路径：wss://public-api.birdeye.so/socket/solana
//   2. 订阅消息加 queryType:"simple" 和 txsType:"swap"
//   3. 价格取 data.tokenPrice（SIMPLE 模式专有字段，最准确）
//      fallback: data.from.nearestPrice
//   4. 成交额取 data.volumeUSD
//   5. 时间戳取 data.blockUnixTime
//
// 聚合逻辑与旧版完全一致（5s 窗口对齐、空窗补填）。

const WebSocket = require('ws');
const config     = require('./config');
const tokenStore = require('./tokenStore');

const CANDLE_SEC = config.monitor.candleIntervalSeconds; // 5

class BirdeyeWsManager {
  constructor() {
    this.ws             = null;
    this.connected      = false;
    this.reconnectDelay = 3000;
    this.subscriptions  = new Set();
    this.pingInterval   = null;
  }

  // ─── Public ──────────────────────────────────────────────────────

  connect() {
    console.log('[BirdEye WS] Connecting...');
    // ✅ 修复1：URL 必须包含 /solana，API Key 作为 query param
    const url = `${config.birdeye.wsUrl}/solana?x-api-key=${config.birdeye.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[BirdEye WS] Connected');
      this.connected = true;

      // 重连时清空所有未封口窗口，防止脏数据
      for (const addr of this.subscriptions) {
        const token = tokenStore.getToken(addr);
        if (token) token._candleWindow = null;
      }

      // 重新订阅所有代币
      for (const addr of this.subscriptions) {
        this._sendSubscribe(addr);
      }

      // 保活 ping（每 20s）
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20000);
    });

    this.ws.on('message', (data) => {
      this._handleMessage(data);
    });

    this.ws.on('close', (code) => {
      console.log(`[BirdEye WS] Disconnected (code=${code}), reconnecting in 3s...`);
      this.connected = false;
      clearInterval(this.pingInterval);
      this.pingInterval = null;
      this.ws.removeAllListeners();
      this.ws = null;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.ws.on('error', (err) => {
      console.error('[BirdEye WS] Error:', err.message);
    });
  }

  subscribe(address) {
    this.subscriptions.add(address);
    if (this.connected) {
      this._sendSubscribe(address);
    }
  }

  unsubscribe(address) {
    this.subscriptions.delete(address);
    const token = tokenStore.getToken(address);
    if (token) token._candleWindow = null;

    if (this.connected && this.ws) {
      try {
        this.ws.send(JSON.stringify({
          type: 'UNSUBSCRIBE_TXS',
          data: { queryType: 'simple', address },
        }));
        console.log(`[BirdEye WS] Unsubscribed: ${address}`);
      } catch (_) {}
    }
  }

  // ─── Private ─────────────────────────────────────────────────────

  _sendSubscribe(address) {
    try {
      // ✅ 修复2：加 queryType:"simple" 和 txsType:"swap"
      this.ws.send(JSON.stringify({
        type: 'SUBSCRIBE_TXS',
        data: {
          queryType: 'simple',
          address,
          txsType:   'swap',
        },
      }));
      console.log(`[BirdEye WS] Subscribed: ${address}`);
    } catch (e) {
      console.error('[BirdEye WS] Subscribe error:', e.message);
    }
  }

  _handleMessage(raw) {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'CONNECTED') {
        console.log('[BirdEye WS] Server confirmed connection');
        return;
      }

      if (msg.type !== 'TXS_DATA' || !msg.data) return;

      const d = msg.data;

      // ✅ 修复3：SIMPLE 模式 tokenAddress 才是被监控的代币地址
      const address = d.tokenAddress ?? d.address;
      if (!address) return;

      const token = tokenStore.getToken(address);
      if (!token || !token.active) return;

      // ✅ 修复4：价格字段优先级
      //   tokenPrice  — SIMPLE 模式专有，被订阅代币的 USD 现价，最准确
      //   from.price / from.nearestPrice — fallback
      const price =
        parseFloat(d.tokenPrice)        ||
        parseFloat(d.from?.price)        ||
        parseFloat(d.from?.nearestPrice) ||
        0;

      const volume = parseFloat(d.volumeUSD ?? 0);
      const ts     = parseInt(d.blockUnixTime ?? Math.floor(Date.now() / 1000));

      if (!price || price <= 0 || !ts) return;

      tokenStore.updateTokenData(address, { price });
      this._accumulateTrade(address, price, volume, ts);

    } catch (_) {}
  }

  /**
   * 将一笔成交聚合进时间对齐的 5s K 线窗口
   */
  _accumulateTrade(address, price, volume, ts) {
    const token = tokenStore.getToken(address);
    if (!token) return;

    const windowStart = Math.floor(ts / CANDLE_SEC) * CANDLE_SEC;

    if (!token._candleWindow) {
      token._candleWindow = _newWindow(windowStart, price, volume);
      return;
    }

    const w = token._candleWindow;

    if (windowStart === w.windowStart) {
      if (price > w.high) w.high = price;
      if (price < w.low)  w.low  = price;
      w.close   = price;
      w.volume += volume;
      w.trades++;
      return;
    }

    if (windowStart > w.windowStart) {
      if (w.trades > 0) {
        const candle = {
          time:   w.windowStart,
          open:   w.open,
          high:   w.high,
          low:    w.low,
          close:  w.close,
          volume: w.volume,
          trades: w.trades,
        };
        token.candles.push(candle);
        if (token.candles.length > 500) token.candles.shift();

        tokenStore.pushClose(address, candle.close);
        tokenStore.emit('newCandle', { address, candle, token });

        console.log(
          `[Candle] ${token.symbol} | t=${candle.time} | ` +
          `O=${candle.open.toFixed(8)} H=${candle.high.toFixed(8)} ` +
          `L=${candle.low.toFixed(8)} C=${candle.close.toFixed(8)} | ` +
          `vol=$${candle.volume.toFixed(2)} txs=${candle.trades}`
        );
      }

      // 补填无成交空窗口
      let fillStart = w.windowStart + CANDLE_SEC;
      while (fillStart < windowStart) {
        token.candles.push({
          time: fillStart, open: w.close, high: w.close,
          low: w.close,    close: w.close, volume: 0, trades: 0, isFill: true,
        });
        if (token.candles.length > 500) token.candles.shift();
        tokenStore.pushClose(address, w.close);
        fillStart += CANDLE_SEC;
      }

      token._candleWindow = _newWindow(windowStart, price, volume);
    }
    // 迟到成交（属于已封口窗口）：丢弃
  }
}

function _newWindow(windowStart, price, volume) {
  return {
    windowStart,
    open:   price,
    high:   price,
    low:    price,
    close:  price,
    volume: volume || 0,
    trades: 1,
  };
}

module.exports = new BirdeyeWsManager();
