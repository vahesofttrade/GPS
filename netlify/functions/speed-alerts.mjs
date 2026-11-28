/* Отправка уведомлений: SMS через Twilio / любой HTTP-шлюз, .
   Что включено — определяется переменными окружения Netlify. */
export async function sendAll(phones, text){
  const results = [];
  const provider = (process.env.SMS_PROVIDER || 'twilio').toLowerCase();

  for(const to of phones){
    try {
      if(provider === 'twilio'){
        const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN;
        if(!sid || !tok) throw new Error('нет TWILIO_SID / TWILIO_TOKEN');
        const body = new URLSearchParams({ To: to, Body: text });
        if(process.env.TWILIO_FROM) body.set('From', process.env.TWILIO_FROM);
        else if(process.env.TWILIO_MSG_SERVICE) body.set('MessagingServiceSid', process.env.TWILIO_MSG_SERVICE);
        else throw new Error('нет TWILIO_FROM');
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method:'POST',
          headers:{ Authorization:'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') },
          body
        });
        if(!r.ok) throw new Error('Twilio ' + r.status + ': ' + (await r.text()).slice(0,200));
        results.push(to + ': ok');
      } else if(provider === 'textbee'){
        /* TextBee: SMS отправляется с вашего Android-телефона с установленным приложением textbee */
        const key = process.env.TEXTBEE_API_KEY;
        if(!key) throw new Error('нет TEXTBEE_API_KEY');
        const payload = { recipients: [to], message: text };
        if(process.env.TEXTBEE_DEVICE_ID) payload.deviceId = process.env.TEXTBEE_DEVICE_ID;
        const r = await fetch((process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1') + '/gateway/send-sms', {
          method:'POST', headers:{ 'x-api-key': key, 'Content-Type':'application/json' }, body: JSON.stringify(payload)
        });
        if(!r.ok) throw new Error('TextBee ' + r.status + ': ' + (await r.text()).slice(0,200));
        results.push(to + ': ok');
      } else if(provider === 'webhook'){
        /* универсальный шлюз местного оператора: POST JSON {to, text} на SMS_WEBHOOK_URL.
           Шаблон тела можно поменять через SMS_WEBHOOK_BODY, где {to} и {text} подставятся. */
        const url = process.env.SMS_WEBHOOK_URL;
        if(!url) throw new Error('нет SMS_WEBHOOK_URL');
        const tpl = process.env.SMS_WEBHOOK_BODY;
        const body = tpl
          ? tpl.replace('{to}', JSON.stringify(to).slice(1,-1)).replace('{text}', JSON.stringify(text).slice(1,-1))
          : JSON.stringify({ to, text });
        const headers = { 'Content-Type': process.env.SMS_WEBHOOK_CONTENT_TYPE || 'application/json' };
        if(process.env.SMS_WEBHOOK_AUTH) headers.Authorization = process.env.SMS_WEBHOOK_AUTH;
        const r = await fetch(url, { method:'POST', headers, body });
        if(!r.ok) throw new Error('webhook ' + r.status + ': ' + (await r.text()).slice(0,200));
        results.push(to + ': ok');
      } else if(provider === 'none'){
        results.push(to + ': SMS отключены (SMS_PROVIDER=none)');
      } else {
        throw new Error('неизвестный SMS_PROVIDER: ' + provider);
      }
    } catch(e){ results.push(to + ': ОШИБКА ' + e.message); }
  }

  return results;
}

const SB_URL = () => process.env.SUPABASE_URL || 'https://chwedslmzuekjjxsdlqv.supabase.co';
const SB_KEY = () => process.env.SUPABASE_KEY || 'sb_publishable_DomiPemi0w2qxjMiK7kvyQ_c-y20Eoc';
export async function sb(method, path, body, prefer){
  const r = await fetch(SB_URL() + '/rest/v1/' + path, {
    method,
    headers:{ apikey: SB_KEY(), Authorization:'Bearer ' + SB_KEY(), 'Content-Type':'application/json', Prefer: prefer || 'return=representation' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  if(!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0,200));
  return t ? JSON.parse(t) : [];
}
export function normPhones(s){
  /* приводит номера к +374XXXXXXXX: понимает 093767123, 93767123, 37493767123, +374 93 767123, 0037493767123 */
  return String(s || '').split(/[,;]+/).map(x => x.replace(/[^\d+]/g,'')).filter(Boolean).map(x => {
    if(x.startsWith('+')) return x;
    if(x.startsWith('00')) return '+' + x.slice(2);
    if(x.startsWith('374')) return '+' + x;
    if(x.startsWith('0') && x.length === 9) return '+374' + x.slice(1);
    if(x.length === 8) return '+374' + x;
    return '+' + x;
  });
}

/* ---- функция ---- */
/* Каждые 2 минуты: берём у Wialon текущую скорость всех машин и, если она выше лимита,
   шлём SMS (не чаще одного раза за "cooldown" минут на машину). */

export const config = { schedule: '*/2 * * * *' };

const HOST = () => process.env.WIALON_HOST || 'https://hst-api.wialon.com';
async function wcall(svc, params, sid){
  const url = HOST() + '/wialon/ajax.html?svc=' + svc + '&params=' + encodeURIComponent(JSON.stringify(params)) + (sid ? '&sid=' + sid : '');
  const r = await fetch(url);
  const j = await r.json();
  if(j && j.error) throw new Error('Wialon ' + svc + ' error ' + j.error);
  return j;
}
function distM(lat1, lon1, lat2, lon2){
  const R = 6371000, r = x => x*Math.PI/180;
  const a = Math.sin(r(lat2-lat1)/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(r(lon2-lon1)/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
const hm = ts => new Date(ts*1000).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Yerevan' });

export default async () => {
  const token = process.env.WIALON_TOKEN;
  if(!token){ console.error('WIALON_TOKEN не задан'); return; }

  const st = (await sb('GET', 'alert_settings?id=eq.1'))[0];
  if(!st || !st.enabled){ console.log('уведомления выключены'); return; }
  const mgrPhones = st.notify_manager === false ? [] : normPhones(st.phones);
  const toDriver = st.notify_driver !== false;
  if(!mgrPhones.length && !toDriver){ console.log('нет получателей'); return; }

  /* текущие водители: назначение, действующее сегодня (по времени Еревана) */
  const today = new Date(Date.now() + 4*3600*1000).toISOString().slice(0,10);
  let drivers = {}, asg = [];
  if(toDriver){
    try {
      (await sb('GET', 'drivers?select=*&limit=1000')).forEach(d => drivers[d.id] = d);
      asg = await sb('GET', 'assignments?select=*&date_from=lte.' + today + '&order=date_from.desc&limit=2000');
    } catch(e){ console.error('водители недоступны:', e.message); }
  }
  const driverOf = unitId => {
    const a = asg.find(x => x.unit_id === unitId && (!x.date_to || x.date_to >= today));
    return a ? drivers[a.driver_id] : null;
  };

  const carsArr = await sb('GET', 'cars?select=unit_id,plate,name,r_spdlimit,hidden,r_skip,home_lat,home_lon,home_radius&limit=1000').catch(() => []);
  const cars = {}; carsArr.forEach(c => cars[c.unit_id] = c);

  const login = await wcall('token/login', { token });
  const sid = login.eid;
  try {
    const res = await wcall('core/search_items', {
      spec:{ itemsType:'avl_unit', propName:'sys_name', propValueMask:'*', sortType:'sys_name' },
      force:1, flags: 1 | 1024, from:0, to:0
    }, sid);
    const now = Math.floor(Date.now()/1000);
    const since = new Date(Date.now() - (st.cooldown_min || 30)*60000).toISOString();
    const recent = await sb('GET', 'speed_alerts?select=unit_id&speed=not.is.null&alert_time=gte.' + since + '&limit=1000').catch(() => []);
    const cooling = new Set(recent.map(r => r.unit_id));
    const tol = +st.tolerance || 0;
    let sent = 0;

    for(const u of (res.items || [])){
      const c = cars[u.id] || {};
      if(c.hidden || c.r_skip) continue;
      const p = u.pos;
      if(!p || now - p.t > 600) continue;            // данные старше 10 минут — игнорируем
      const limit = c.r_spdlimit != null && c.r_spdlimit !== '' ? +c.r_spdlimit : +st.spd_limit || 90;
      if(p.s <= limit + tol) continue;
      if(cooling.has(u.id)) continue;

      const label = (c.plate ? c.plate + ' ' : '') + (c.name || u.nm);
      const drv = toDriver ? driverOf(u.id) : null;
      const drvPhones = drv ? normPhones(drv.phone) : [];
      const sp = Math.round(p.s);
      const results = [];
      if(drvPhones.length){
        const t = `Вы превысили скорость: ${sp} км/ч (лимит ${limit}), ${hm(p.t)}, ${label}. Соблюдайте скоростной режим.`;
        (await sendAll(drvPhones, t)).forEach(r => results.push('водитель ' + r));
      } else if(toDriver){
        results.push(drv ? 'у водителя ' + drv.name + ' нет телефона' : 'на машину не назначен водитель');
      }
      if(mgrPhones.length){
        const t = `Превышение: ${label}${drv ? ' (' + drv.name + ')' : ''} — ${sp} км/ч (лимит ${limit}), ${hm(p.t)}. https://maps.google.com/?q=${p.y},${p.x}`;
        (await sendAll(mgrPhones, t)).forEach(r => results.push('руководитель ' + r));
      }
      await sb('POST', 'speed_alerts', [{ unit_id:u.id, name:label + (drv ? ' · ' + drv.name : ''), speed:sp, spd_limit:limit, lat:p.y, lon:p.x, result:results.join(' | ').slice(0,500) }]);
      cooling.add(u.id); sent++;
    }
    console.log('проверено', (res.items||[]).length, 'машин, отправлено', sent);

    /* ---------- заезд в зону дома в рабочее время ---------- */
    if(st.home_enabled !== false){
      try {
        const wf = (st.work_from || '09:00'), wt = (st.work_to || '18:00');
        const toMin = t => { const [h,m] = String(t).split(':'); return (+h)*60 + (+m||0); };
        const ye = new Date(Date.now() + 4*3600*1000);           // время Еревана (UTC+4)
        const nowMin = ye.getUTCHours()*60 + ye.getUTCMinutes();
        const dow = ye.getUTCDay();                                // 0 = вс, 6 = сб
        const workTime = nowMin >= toMin(wf) && nowMin <= toMin(wt) && !(st.work_weekdays !== false && (dow === 0 || dow === 6));

        const stateRows = await sb('GET', 'home_state?select=*&limit=2000');   // если таблицы нет — уйдём в catch, без спама
        const state = {}; stateRows.forEach(r => state[r.unit_id] = r.inside);
        const homeSince = new Date(Date.now() - (st.cooldown_min || 30)*60000).toISOString();
        const homeRecent = await sb('GET', 'speed_alerts?select=unit_id&speed=is.null&alert_time=gte.' + homeSince + '&limit=1000');
        const homeCool = new Set(homeRecent.map(r => r.unit_id));
        const changes = []; let hsent = 0;

        for(const u of (res.items || [])){
          const c = cars[u.id] || {};
          if(c.hidden || c.home_lat == null || c.home_lon == null) continue;
          const p = u.pos;
          if(!p || now - p.t > 600) continue;
          const inside = distM(p.y, p.x, +c.home_lat, +c.home_lon) <= (+c.home_radius || 150);
          const prev = state[u.id];
          if(prev === undefined || prev !== inside) changes.push({ unit_id:u.id, inside, changed_at:new Date().toISOString() });
          if(prev === false && inside && workTime && !homeCool.has(u.id)){
            const label = (c.plate ? c.plate + ' ' : '') + (c.name || u.nm);
            const drv = toDriver ? driverOf(u.id) : null;
            const drvPhones = drv ? normPhones(drv.phone) : [];
            const results = [];
            if(drvPhones.length){
              const t = `Вы заехали в зону дома в рабочее время (${hm(p.t)}), ${label}. Рабочее время ${wf}–${wt}.`;
              (await sendAll(drvPhones, t)).forEach(r => results.push('водитель ' + r));
            } else if(toDriver){
              results.push(drv ? 'у водителя ' + drv.name + ' нет телефона' : 'на машину не назначен водитель');
            }
            if(mgrPhones.length){
              const t = `Дом в рабочее время: ${label}${drv ? ' (' + drv.name + ')' : ''} заехал в зону дома в ${hm(p.t)} (раб. время ${wf}–${wt}). https://maps.google.com/?q=${p.y},${p.x}`;
              (await sendAll(mgrPhones, t)).forEach(r => results.push('руководитель ' + r));
            }
            await sb('POST', 'speed_alerts', [{ unit_id:u.id, name:label + (drv ? ' · ' + drv.name : ''), speed:null, spd_limit:null, lat:p.y, lon:p.x, result:results.join(' | ').slice(0,500) }]);
            homeCool.add(u.id); hsent++;
          }
        }
        if(changes.length) await sb('POST', 'home_state?on_conflict=unit_id', changes, 'resolution=merge-duplicates,return=minimal');
        console.log('дом: изменений', changes.length, 'уведомлений', hsent, 'рабочее время', workTime);
      } catch(e){ console.error('проверка дома пропущена:', e.message); }
    }
  } finally {
    try { await wcall('core/logout', {}, sid); } catch(e){}
  }
};
