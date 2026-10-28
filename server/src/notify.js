// Gửi mã xác minh qua email / SMS — không phụ thuộc nhà cung cấp cụ thể.
// Email: SMTP_URL (vd. smtps://user:matkhau@smtp.gmail.com:465) + MAIL_FROM.
// SMS:   cổng HTTP chung — SMS_HTTP_URL có thể chứa {to} {text}; SMS_HTTP_METHOD (GET|POST, mặc định POST),
//        SMS_HTTP_BODY (mẫu thân yêu cầu, vd. {"Phone":"{to}","Content":"{text}","ApiKey":"..."}),
//        SMS_HTTP_HEADERS (JSON, vd. {"Content-Type":"application/json","Authorization":"Basic ..."}).
//        Hợp với eSMS / SpeedSMS / Twilio / cổng nội bộ.
// Chưa cấu hình -> kênh đó coi như KHÔNG có (ẩn khỏi giao diện); NOTIFY_LOG=1 -> in mã ra log (thử nghiệm).
import nodemailer from 'nodemailer';

const LOG = process.env.NOTIFY_LOG === '1';
let mailer = null;
const getMailer = () => (mailer ||= nodemailer.createTransport(process.env.SMTP_URL));

export const channels = () => ({ email: !!process.env.SMTP_URL || LOG, sms: !!process.env.SMS_HTTP_URL || LOG });

export async function sendEmail(to, subject, text) {
  if (!process.env.SMTP_URL) {
    if (LOG) { console.log(`[notify] email -> ${to}: ${subject} | ${text}`); return; }
    throw Object.assign(new Error('Máy chủ chưa cấu hình gửi email'), { status: 503 });
  }
  await getMailer().sendMail({ from: process.env.MAIL_FROM || 'ReaChat <no-reply@localhost>', to, subject, text });
}

const fill = (tpl, vars, enc) => String(tpl).replace(/\{(to|text)\}/g, (_, k) => enc(vars[k]));
export async function sendSms(to, text) {
  const url = process.env.SMS_HTTP_URL;
  if (!url) {
    if (LOG) { console.log(`[notify] sms -> ${to}: ${text}`); return; }
    throw Object.assign(new Error('Máy chủ chưa cấu hình gửi SMS'), { status: 503 });
  }
  const vars = { to, text };
  let headers = {};
  try { headers = JSON.parse(process.env.SMS_HTTP_HEADERS || '{}'); } catch {}
  const method = (process.env.SMS_HTTP_METHOD || 'POST').toUpperCase();
  const tpl = process.env.SMS_HTTP_BODY;
  const json = /json/i.test(headers['Content-Type'] || headers['content-type'] || '');
  const body = method === 'GET' ? undefined
    : tpl ? fill(tpl, vars, (v) => (json ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(v)))
    : JSON.stringify(vars);
  if (method !== 'GET' && !tpl && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const r = await fetch(fill(url, vars, encodeURIComponent), { method, headers, body, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error('Cổng SMS báo lỗi ' + r.status), { status: 502 });
}
