
import express from 'express';

import { runBacktestV24 } from './backtest-v24.js';

const app = express();
app.disable('x-powered-by');
app.use(express.static('public'));

const symbols = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  USDCHF: 'USD/CHF',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  NZDUSD: 'NZD/USD',
  EURGBP: 'EUR/GBP',
  EURJPY: 'EUR/JPY',
  GBPJPY: 'GBP/JPY',
  XAUUSD: 'XAU/USD'
};

const intervals = {
  m1: '1min',
  m5: '5min',
  m15: '15min',
  m30: '30min',
  h1: '1h',
  h4: '4h',
  d1: '1day',
  w1: '1week'
};

const minutes = {
  m1: 1,
  m5: 5,
  m15: 15,
  m30: 30,
  h1: 60,
  h4: 240,
  d1: 1440,
  w1: 10080
};

const cache = new Map();
const CACHE_MS = 60000;

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    version: '2.3',
    source: 'Twelve Data',
    configured: Boolean(process.env.TWELVE_DATA_API_KEY),
    backtest: true
  });
});

function parseUTC(value) {
  if (typeof value !== 'string') return NaN;

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return NaN;
  }

  return Date.parse(value.replace(' ', 'T') + 'Z');
}

function normalizeCandles(values) {
  return values.map(v => ({
    time: v.datetime,
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close)
  }))
  .filter(v =>
    [v.open, v.high, v.low, v.close].every(Number.isFinite) &&
    v.high >= Math.max(v.open, v.close) &&
    v.low <= Math.min(v.open, v.close) &&
    v.high >= v.low
  )
  .sort((a, b) => a.time.localeCompare(b.time))
  .filter((v, i, arr) =>
    i === 0 || v.time !== arr[i - 1].time
  );
}

async function requestSeries(symbol, interval, apiKey, timezone, outputsize) {
  const url = new URL('https://api.twelvedata.com/time_series');

  url.search = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(outputsize),
    timezone,
    apikey: apiKey,
    format: 'JSON'
  }).toString();

  const response = await fetch(url, {
    signal: AbortSignal.timeout(18000)
  });

  const body = await response.json();

  if (!response.ok || body.status === 'error' || !Array.isArray(body.values)) {
    throw new Error(body.message || 'خطا در دریافت کندل‌ها');
  }

  return body;
}

function newYorkTime(utcTimestamp) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utcTimestamp))
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );

  return `${parts.year}-${parts.month}-${parts.day} ` +
    `${parts.hour}:${parts.minute}:${parts.second}`;
}

async function loadCandles(symbol, tf, outputsize = 200) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    const error = new Error('کلید Twelve Data تنظیم نشده است');
    error.status = 503;
    throw error;
  }

  const cacheKey = `${symbol}:${tf}:${outputsize}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.data, cached: true };
  }

  const primary = await requestSeries(
    symbols[symbol],
    intervals[tf],
    apiKey,
    'UTC',
    outputsize
  );

  const candles = normalizeCandles(primary.values);

  if (candles.length < 55) {
    throw new Error('تعداد کندل‌ها برای تحلیل کافی نیست');
  }

  const reportedTimezone = String(
    primary.meta?.timezone || ''
  ).trim();

  let timezoneConfirmed =
    /^(UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(reportedTimezone);

  let verification = timezoneConfirmed
    ? 'provider_metadata'
    : 'unverified';

  if (!timezoneConfirmed && minutes[tf] < 1440) {
    try {
      const comparison = await requestSeries(
        symbols[symbol],
        intervals[tf],
        apiKey,
        'America/New_York',
        5
      );

      const primaryLast = primary.values[0];
      const comparisonLast = comparison.values[0];

      if (primaryLast && comparisonLast) {
        const utcTimestamp = parseUTC(primaryLast.datetime);

        const sameBar =
          Number.isFinite(utcTimestamp) &&
          newYorkTime(utcTimestamp) === comparisonLast.datetime &&
          Number(primaryLast.open) === Number(comparisonLast.open) &&
          Number(primaryLast.high) === Number(comparisonLast.high) &&
          Number(primaryLast.low) === Number(comparisonLast.low) &&
          Number(primaryLast.close) === Number(comparisonLast.close);

        if (sameBar) {
          timezoneConfirmed = true;
          verification = 'independent_timezone_comparison';
        }
      }
    } catch (error) {
      console.warn('Timezone verification:', error.message);
    }
  }

  const now = Date.now();
  const intervalMs = minutes[tf] * 60000;

  const closedCandles = timezoneConfirmed
    ? candles.filter(c => {
        const timestamp = parseUTC(c.time);
        return Number.isFinite(timestamp) &&
          timestamp + intervalMs <= now;
      })
    : [];

  const lastClosed = closedCandles.at(-1);
  const lastTimestamp = lastClosed
    ? parseUTC(lastClosed.time)
    : NaN;

  const ageMinutes = Number.isFinite(lastTimestamp)
    ? (now - lastTimestamp) / 60000
    : null;

  const maximumAgeMinutes = Math.max(minutes[tf] * 3, 15);

  const fresh =
    timezoneConfirmed &&
    closedCandles.length >= 55 &&
    ageMinutes !== null &&
    ageMinutes >= minutes[tf] &&
    ageMinutes <= maximumAgeMinutes;

  const day = new Date().getUTCDay();
  const weekend = day === 0 || day === 6;

  const result = {
    symbol,
    tf,
    candles: timezoneConfirmed ? closedCandles : candles,
    receivedAt: new Date().toISOString(),
    source: 'Twelve Data',
    freshness: {
      timezoneRequested: 'UTC',
      timezoneReported: reportedTimezone || null,
      timezoneConfirmed,
      verification,
      lastCandleAgeMinutes: ageMinutes,
      maximumAgeMinutes,
      fresh,
      weekend,
      signalAllowed: fresh && !weekend
    },
    note: 'تحلیل آزمایشی؛ قیمت ممکن است با Pocket Option متفاوت باشد'
  };

  cache.set(cacheKey, {
    at: Date.now(),
    data: result
  });

  return result;
}

function emaSeries(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  let ema = sum / period;
  output[period - 1] = ema;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    output[i] = ema;
  }

  return output;
}

function rsiSeries(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    gains += Math.max(diff, 0);
    losses += Math.max(-diff, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  function calculate() {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  output[period] = calculate();

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    avgGain = (
      avgGain * (period - 1) + Math.max(diff, 0)
    ) / period;

    avgLoss = (
      avgLoss * (period - 1) + Math.max(-diff, 0)
    ) / period;

    output[i] = calculate();
  }

  return output;
}

function backtest(candles, tf) {
  const closes = candles.map(c => c.close);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const rsi14 = rsiSeries(closes, 14);

  const trades = [];
  const intervalMs = minutes[tf] * 60000;

  // تصمیم فقط با اطلاعات کندل i گرفته می‌شود.
  // ورود در بازشدن کندل بعدی و خروج در بسته‌شدن همان کندل است.
  for (let i = 21; i < candles.length - 1; i++) {
    const next = candles[i + 1];

    const currentTime = parseUTC(candles[i].time);
    const nextTime = parseUTC(next.time);

    // اگر بین کندل‌ها وقفه باشد، معامله حذف می‌شود.
    if (!Number.isFinite(currentTime) ||
        !Number.isFinite(nextTime) ||
        nextTime - currentTime !== intervalMs) {
      continue;
    }

    const fast = ema9[i];
    const slow = ema21[i];
    const rsi = rsi14[i];

    if (![fast, slow, rsi].every(Number.isFinite)) {
      continue;
    }

    let signal = 'WAIT';

    if (
      fast > slow &&
      closes[i] > fast &&
      rsi >= 52 &&
      rsi <= 68
    ) {
      signal = 'CALL';
    } else if (
      fast < slow &&
      closes[i] < fast &&
      rsi >= 32 &&
      rsi <= 48
    ) {
      signal = 'PUT';
    }

    if (signal === 'WAIT') continue;

    const entry = next.open;
    const exit = next.close;

    const result = entry === exit
      ? 'DRAW'
      : signal === 'CALL'
        ? (exit > entry ? 'WIN' : 'LOSS')
        : (exit < entry ? 'WIN' : 'LOSS');

    trades.push({
      signalTime: candles[i].time,
      entryTime: next.time,
      expiryMinutes: minutes[tf],
      signal,
      entry,
      exit,
      result,
      ema9: Number(fast.toFixed(6)),
      ema21: Number(slow.toFixed(6)),
      rsi14: Number(rsi.toFixed(2))
    });
  }

  const wins = trades.filter(t => t.result === 'WIN').length;
  const losses = trades.filter(t => t.result === 'LOSS').length;
  const draws = trades.filter(t => t.result === 'DRAW').length;
  const decided = wins + losses;

  return {
    strategy: 'EMA9_EMA21_RSI14_V1',
    method: 'next_candle_open_to_close',
    expiryMinutes: minutes[tf],
    testedCandles: candles.length,
    totalSignals: trades.length,
    wins,
    losses,
    draws,
    winRate: decided
      ? Number((wins / decided * 100).toFixed(2))
      : null,
    note: 'بک‌تست تاریخی و آزمایشی است. کارمزد، پرداخت بروکر، تأخیر اجرا و تفاوت قیمت Pocket Option لحاظ نشده‌اند.',
    trades: trades.slice(-100).reverse()
  };
}

function validateRequest(req, res) {
  const symbol = String(req.query.symbol || 'EURUSD').toUpperCase();
  const tf = String(req.query.tf || 'm5').toLowerCase();

  if (!symbols[symbol] || !intervals[tf]) {
    res.status(400).json({
      error: 'نماد یا تایم‌فریم نامعتبر است'
    });
    return null;
  }

  return { symbol, tf };
}

app.get('/api/candles', async (req, res) => {
  const params = validateRequest(req, res);
  if (!params) return;

  try {
    const data = await loadCandles(params.symbol, params.tf);
    res.json(data);
  } catch (error) {
    res.status(error.status || 502).json({
      error: String(error.message || error)
    });
  }
});

app.get('/api/backtest', async (req, res) => {
  const params = validateRequest(req, res);
  if (!params) return;

  try {
    const data = await loadCandles(
      params.symbol,
      params.tf,
      200
    );

    if (!data.freshness.timezoneConfirmed) {
      return res.status(409).json({
        error: 'منطقه زمانی کندل‌ها تأیید نشده؛ بک‌تست متوقف شد'
      });
    }

    if (data.candles.length < 55) {
      return res.status(409).json({
        error: 'کندل بسته‌شده کافی برای بک‌تست وجود ندارد'
      });
    }

    res.json({
      symbol: params.symbol,
      tf: params.tf,
      source: 'Twelve Data',
      receivedAt: data.receivedAt,
      backtest: backtest(data.candles, params.tf)
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: String(error.message || error)
    });
  }
});

const PORT = process.env.PORT || 8787;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PocketBot Pro V2.3 running on port ${PORT}`);
});
