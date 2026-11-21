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
export async function sb(method, path, body){
  const r = await fetch(SB_URL() + '/rest/v1/' + path, {
    method,
    headers:{ apikey: SB_KEY(), Authorization:'Bearer ' + SB_KEY(), 'Content-Type':'application/json', Prefer:'return=representation' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  if(!r.ok) throw new Error('Supabase ' + r.status + ': ' + t.slice(0,200));
  return t ? JSON.parse(t) : [];
}
export function normPhones(s){
  return String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean)
    .map(x => x.startsWith('+') ? x : (x.startsWith('00') ? '+' + x.slice(2) : '+' + x));
}

