import express from 'express';
const app=express();
app.disable('x-powered-by');
app.use(express.static('public'));
const symbols={EURUSD:'EUR/USD',GBPUSD:'GBP/USD',USDJPY:'USD/JPY',USDCHF:'USD/CHF',AUDUSD:'AUD/USD',USDCAD:'USD/CAD',NZDUSD:'NZD/USD',EURGBP:'EUR/GBP',EURJPY:'EUR/JPY',GBPJPY:'GBP/JPY',XAUUSD:'XAU/USD'};
const intervals={m1:'1min',m5:'5min',m15:'15min',m30:'30min',h1:'1h',h4:'4h',d1:'1day',w1:'1week'};
const mins={m1:1,m5:5,m15:15,m30:30,h1:60,h4:240,d1:1440,w1:10080};
const cache=new Map();
app.get('/health',(_,res)=>res.json({ok:true,source:'Twelve Data',configured:!!process.env.TWELVE_DATA_API_KEY}));
app.get('/api/candles',async(req,res)=>{
 const symbol=String(req.query.symbol||'EURUSD').toUpperCase(),tf=String(req.query.tf||'m5').toLowerCase();
 if(!symbols[symbol]||!intervals[tf])return res.status(400).json({error:'نماد یا تایم‌فریم نامعتبر است'});
 const apiKey=process.env.TWELVE_DATA_API_KEY;
 if(!apiKey)return res.status(503).json({error:'کلید Twelve Data روی Render تنظیم نشده است'});
 const key=symbol+':'+tf,old=cache.get(key);
 if(old&&Date.now()-old.at<60000)return res.json({...old.data,cached:true});
 try{
  const url=new URL('https://api.twelvedata.com/time_series');
  url.search=new URLSearchParams({symbol:symbols[symbol],interval:intervals[tf],outputsize:'200',timezone:'UTC',apikey:apiKey,format:'JSON'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(18000)});
  const body=await response.json();
  if(!response.ok||body.status==='error'||!Array.isArray(body.values))throw Error(body.message||'پاسخ نامعتبر از Twelve Data');
  const candles=body.values.map(v=>({time:v.datetime,open:+v.open,high:+v.high,low:+v.low,close:+v.close}))
    .filter(v=>[v.open,v.high,v.low,v.close].every(Number.isFinite)&&v.high>=Math.max(v.open,v.close,v.low)&&v.low<=Math.min(v.open,v.close,v.high))
    .reverse();
  if(candles.length<55)throw Error('کندل کافی دریافت نشد');
  const zone=String(body.meta?.exchange_timezone||body.meta?.timezone||'');
  const zoneConfirmed=/^(UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(zone);
  const last=candles.at(-1);
  const stamp=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(last.time)?Date.parse(last.time.replace(' ','T')+'Z'):NaN;
  const ageMinutes=Number.isFinite(stamp)?(Date.now()-stamp)/60000:null;
  // No signal if the provider's timezone isn't explicitly confirmed as UTC.
  const weekend=[0,6].includes(new Date().getUTCDay());
  const maxAge=Math.max(3*mins[tf],15);
  const fresh=zoneConfirmed&&ageMinutes!==null&&ageMinutes>=mins[tf]&&ageMinutes<=maxAge;
  const freshness={timezoneRequested:'UTC',timezoneReported:zone||null,timezoneConfirmed:zoneConfirmed,lastCandleAgeMinutes:ageMinutes,maximumAgeMinutes:maxAge,fresh,weekend,signalAllowed:fresh&&!weekend};
  const result={symbol,tf,candles,receivedAt:new Date().toISOString(),source:'Twelve Data',freshness,note:'قیمت ممکن است با Pocket Option متفاوت باشد'};
  cache.set(key,{at:Date.now(),data:result});
  res.json(result);
 }catch(e){res.status(502).json({error:String(e.message||e)})}
});
app.listen(process.env.PORT||8787,'0.0.0.0',()=>console.log('PocketBot Pro v2 listening'));
