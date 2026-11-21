/* Каждые 2 минуты: берём у Wialon текущую скорость всех машин и, если она выше лимита,
   шлём SMS (не чаще одного раза за "cooldown" минут на машину). */
import { sendAll, sb, normPhones } from '../lib/notify.mjs';

export const config = { schedule: '*/2 * * * *' };

const HOST = () => process.env.WIALON_HOST || 'https://hst-api.wialon.com';
async function wcall(svc, params, sid){
  const url = HOST() + '/wialon/ajax.html?svc=' + svc + '&params=' + encodeURIComponent(JSON.stringify(params)) + (sid ? '&sid=' + sid : '');
  const r = await fetch(url);
  const j = await r.json();
  if(j && j.error) throw new Error('Wialon ' + svc + ' error ' + j.error);
  return j;
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

  const carsArr = await sb('GET', 'cars?select=unit_id,plate,name,r_spdlimit,hidden,r_skip&limit=1000').catch(() => []);
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
    const recent = await sb('GET', 'speed_alerts?select=unit_id&alert_time=gte.' + since + '&limit=1000').catch(() => []);
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
  } finally {
    try { await wcall('core/logout', {}, sid); } catch(e){}
  }
};
