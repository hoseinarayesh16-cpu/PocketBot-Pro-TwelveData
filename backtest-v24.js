
/*
 PocketBot Pro V2.4
 Historical backtest engine
 No automatic trading
*/

export function runBacktestV24(candles, options = {}) {
  const tfMinutes = options.tfMinutes ?? 5;
  const payout = options.payout ?? 0.80;
  const minADX = options.minADX ?? 20;
  const minATRPercent = options.minATRPercent ?? 0.015;
  const maxATRPercent = options.maxATRPercent ?? 0.30;

  if (!Array.isArray(candles) || candles.length < 100) {
    throw new Error('حداقل ۱۰۰ کندل لازم است');
  }

  const data = candles.map(c => ({
    ...c,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    timestamp: Date.parse(
      String(c.time).replace(' ', 'T') + 'Z'
    )
  }));

  if (data.some(c =>
    !Number.isFinite(c.timestamp) ||
    ![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
    c.high < Math.max(c.open, c.close) ||
    c.low > Math.min(c.open, c.close)
  )) {
    throw new Error('داده کندل نامعتبر است');
  }

  function ema(values, period) {
    const result = Array(values.length).fill(null);
    if (values.length < period) return result;

    let value = values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

    result[period - 1] = value;

    const k = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
      value = values[i] * k + value * (1 - k);
      result[i] = value;
    }

    return result;
  }

  function wilder(values, period) {
    const result = Array(values.length).fill(null);
    if (values.length < period) return result;

    let value = values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

    result[period - 1] = value;

    for (let i = period; i < values.length; i++) {
      value = (
        value * (period - 1) + values[i]
      ) / period;

      result[i] = value;
    }

    return result;
  }

  const closes = data.map(c => c.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);

  // RSI 14
  const rsi = Array(data.length).fill(null);
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    gain += Math.max(diff, 0);
    loss += Math.max(-diff, 0);
  }

  gain /= 14;
  loss /= 14;

  function rsiValue() {
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  }

  rsi[14] = rsiValue();

  for (let i = 15; i < data.length; i++) {
    const diff = closes[i] - closes[i - 1];

    gain = (gain * 13 + Math.max(diff, 0)) / 14;
    loss = (loss * 13 + Math.max(-diff, 0)) / 14;

    rsi[i] = rsiValue();
  }

  // True Range, directional movement
  const tr = Array(data.length).fill(0);
  const plusDM = Array(data.length).fill(0);
  const minusDM = Array(data.length).fill(0);

  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const prev = data[i - 1];

    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );

    const up = c.high - prev.high;
    const down = prev.low - c.low;

    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  const atr = wilder(tr.slice(1), 14);
  const smPlus = wilder(plusDM.slice(1), 14);
  const smMinus = wilder(minusDM.slice(1), 14);

  const atrFull = [null, ...atr];
  const dx = Array(data.length).fill(null);

  for (let i = 14; i < data.length; i++) {
    const a = atrFull[i];

    if (!a || !Number.isFinite(a)) continue;

    const plusDI = 100 * smPlus[i - 1] / a;
    const minusDI = 100 * smMinus[i - 1] / a;
    const total = plusDI + minusDI;

    dx[i] = total === 0
      ? 0
      : 100 * Math.abs(plusDI - minusDI) / total;
  }

  const adx = Array(data.length).fill(null);

  // ADX initial value from 14 valid DX values
  const validDX = [];

  for (let i = 14; i < data.length; i++) {
    if (dx[i] === null) continue;

    validDX.push({ index: i, value: dx[i] });

    if (validDX.length === 14) {
      const firstIndex = i;
      let value = validDX.reduce(
        (sum, item) => sum + item.value, 0
      ) / 14;

      adx[firstIndex] = value;

      for (let j = firstIndex + 1; j < data.length; j++) {
        if (dx[j] === null) continue;
        value = (value * 13 + dx[j]) / 14;
        adx[j] = value;
      }

      break;
    }
  }

  const trades = [];
  const expectedMs = tfMinutes * 60000;

  for (let i = 50; i < data.length - 1; i++) {
    const current = data[i];
    const next = data[i + 1];

    // Require uninterrupted candles.
    if (next.timestamp - current.timestamp !== expectedMs) {
      continue;
    }

    // Exclude weekend bars and suspiciously static bars.
    const day = new Date(current.timestamp).getUTCDay();
    const nextDay = new Date(next.timestamp).getUTCDay();

    if ([0, 6].includes(day) || [0, 6].includes(nextDay)) {
      continue;
    }

    const recent = data.slice(i - 5, i + 1);

    if (recent.some((c, j) =>
      j > 0 &&
      c.timestamp - recent[j - 1].timestamp !== expectedMs
    )) {
      continue;
    }

    if (recent.filter(c => c.high === c.low).length >= 2) {
      continue;
    }

    const atrValue = atrFull[i];
    const adxValue = adx[i];
    const rsiValueNow = rsi[i];

    if (
      ![atrValue, adxValue, rsiValueNow,
        ema9[i], ema21[i], ema50[i]]
        .every(Number.isFinite)
    ) {
      continue;
    }

    const atrPercent = atrValue / current.close * 100;

    if (
      atrPercent < minATRPercent ||
      atrPercent > maxATRPercent ||
      adxValue < minADX
    ) {
      continue;
    }

    // Avoid abnormally large signal candles.
    if (
      current.high - current.low > 2.5 * atrValue
    ) {
      continue;
    }

    let signal = null;

    if (
      ema9[i] > ema21[i] &&
      ema21[i] > ema50[i] &&
      current.close > ema9[i] &&
      rsiValueNow >= 53 &&
      rsiValueNow <= 65
    ) {
      signal = 'CALL';
    }

    if (
      ema9[i] < ema21[i] &&
      ema21[i] < ema50[i] &&
      current.close < ema9[i] &&
      rsiValueNow >= 35 &&
      rsiValueNow <= 47
    ) {
      signal = 'PUT';
    }

    if (!signal) continue;

    const entry = next.open;
    const exit = next.close;

    const result = entry === exit
      ? 'DRAW'
      : signal === 'CALL'
        ? (exit > entry ? 'WIN' : 'LOSS')
        : (exit < entry ? 'WIN' : 'LOSS');

    trades.push({
      signalTime: current.time,
      entryTime: next.time,
      signal,
      entry,
      exit,
      result,
      rsi: Number(rsiValueNow.toFixed(2)),
      adx: Number(adxValue.toFixed(2)),
      atrPercent: Number(atrPercent.toFixed(4))
    });
  }

  function stats(items) {
    const wins = items.filter(t => t.result === 'WIN').length;
    const losses = items.filter(t => t.result === 'LOSS').length;
    const draws = items.filter(t => t.result === 'DRAW').length;
    const decided = wins + losses;

    return {
      total: items.length,
      wins,
      losses,
      draws,
      winRate: decided
        ? Number((100 * wins / decided).toFixed(2))
        : null,
      // Assuming draws refund the stake.
      netUnits: Number((wins * payout - losses).toFixed(2))
    };
  }

  const split = Math.floor(data.length * 0.7);
  const training = trades.filter(t =>
    Date.parse(t.entryTime.replace(' ', 'T') + 'Z') <
    data[split].timestamp
  );
  const testing = trades.filter(t =>
    Date.parse(t.entryTime.replace(' ', 'T') + 'Z') >=
    data[split].timestamp
  );

  return {
    version: '2.4',
    strategy: 'EMA_RSI_ADX_ATR_FILTERED',
    expiryMinutes: tfMinutes,
    payout,
    minimumBreakEvenWinRate: Number(
      (100 / (1 + payout)).toFixed(2)
    ),
    all: stats(trades),
    training: stats(training),
    testing: stats(testing),
    call: stats(trades.filter(t => t.signal === 'CALL')),
    put: stats(trades.filter(t => t.signal === 'PUT')),
    trades: trades.slice(-100).reverse(),
    warnings: [
      'نتایج فقط روی داده تاریخی محاسبه شده‌اند.',
      'پارامترها از قبل تعیین شده‌اند؛ تقسیم زمانی به‌تنهایی اعتبارسنجی خارج از نمونه واقعی ایجاد نمی‌کند.',
      'پرداخت واقعی و قیمت Pocket Option ممکن است متفاوت باشد.',
      'معاملات مساوی با فرض بازگشت اصل مبلغ محاسبه شده‌اند.'
    ]
  };
}
