/* Тестовое сообщение на сохранённые номера: вызывается кнопкой в приложении. */
import { sendAll, sb, normPhones } from '../lib/notify.mjs';
export default async () => {
  try {
    const st = (await sb('GET', 'alert_settings?id=eq.1'))[0];
    const phones = normPhones(st && st.phones);
    if(!phones.length) return Response.json({ ok:false, error:'нет номеров в настройках' });
    const results = await sendAll(phones, 'Тест: уведомления о превышении скорости ТП Мониторинг работают.');
    return Response.json({ ok:true, results });
  } catch(e){ return Response.json({ ok:false, error:e.message }); }
};
