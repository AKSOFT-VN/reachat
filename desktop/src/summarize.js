// Tóm tắt hội thoại NGAY TRÊN MÁY (trích xuất, không gọi AI bên ngoài) -> giữ riêng tư E2E.
import { fold } from './safety.js';

// Từ dừng tiếng Việt (đã bỏ dấu) + từ đệm chat.
const STOP = new Set(('va la cua co khong ko k thi nhe nha a ah oi o e em anh chi ban minh toi tao may no ho chung ta '
  + 'duoc bi cho voi tu den trong ngoai tren duoi nay kia do day vay roi chua da dang se cung con nua lam lai ra vao '
  + 'mot hai ba cac nhung nhieu it rat qua lam hay hoac nhung neu khi vi nen de thi ok oke uh um ha hi hihi haha vang '
  + 'da duoc dc j gi sao the nao gio dau ai thu luc nay hom ngay gio di nhe nhi ha the thoi chi thay biet muon can phai '
  + 'cai con nguoi viec nao vs tks thanks cam on').split(' '));

const TIME_RE = /\b(\d{1,2}h(\d{2})?|\d{1,2}:\d{2}|thu [2-7]|thu (hai|ba|tu|nam|sau|bay)|chu nhat|ngay mai|sang mai|toi nay|chieu nay|trua nay|hom nay|cuoi tuan|tuan sau|\d{1,2}\/\d{1,2})\b/;
const URGENT_RE = /\b(gap|khan|quan trong|deadline|han chot|ngay lap tuc|asap|urgent|truoc \d)\b/;
const QUESTION_RE = /\?|\b(khong|ko|chua|sao|the nao|bao gio|o dau|ai|may gio|duoc khong|nhe khong)\s*\??$/;

const words = (t) => fold(t).replace(/https?:\/\/\S+/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));

// msgs: [{ body, senderUsername, type, createdAt }] (đã giải mã). me: username của mình.
export function summarize(msgs, me) {
  const items = msgs.filter((m) => m && !m.recalled && (m.type === 'text' || m.type === 'poll' || m.type === 'system') && m.body);
  const texts = items.filter((m) => m.type === 'text');
  const people = {};
  for (const m of texts) people[m.senderUsername || '?'] = (people[m.senderUsername || '?'] || 0) + 1;

  const freq = {};
  for (const m of texts) for (const w of new Set(words(m.body))) freq[w] = (freq[w] || 0) + 1;

  // Từ khóa: tiếng Việt theo âm tiết -> ưu tiên CỤM 2 TỪ ("dự án", "báo cáo"), giữ dấu gốc để hiển thị.
  const bi = {}, display = {};
  for (const m of texts) {
    const toks = String(m.body).normalize('NFC').toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean)
      .map((o) => ({ o, f: fold(o) }));
    const seen = new Set();
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i], b = toks[i + 1];
      if (STOP.has(a.f) || STOP.has(b.f) || a.f.length < 2 || b.f.length < 2 || /^\d+$/.test(a.f + b.f)) continue;
      const k = a.f + ' ' + b.f;
      if (seen.has(k)) continue; seen.add(k);
      bi[k] = (bi[k] || 0) + 1; display[k] = a.o + ' ' + b.o;
    }
  }
  const covered = new Set();
  const biKw = Object.entries(bi).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k]) => { k.split(' ').forEach((w) => covered.add(w)); return display[k]; });
  const uniDisplay = {};
  for (const m of texts) for (const o of String(m.body).normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) if (o) uniDisplay[fold(o)] ||= o;
  const uniKw = Object.entries(freq).filter(([w, n]) => n >= 2 && !covered.has(w)).sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, 8 - biKw.length)).map(([w]) => uniDisplay[w] || w);
  const keywords = [...biKw, ...uniKw];

  const meRe = me ? new RegExp('@' + me + '\\b', 'i') : null;
  const scored = texts.map((m) => {
    const f = fold(m.body);
    const ws = words(m.body);
    let s = ws.reduce((a, w) => a + (freq[w] > 1 ? Math.log2(freq[w] + 1) : 0), 0) / Math.sqrt(ws.length + 1);
    const flags = [];
    if (meRe?.test(m.body)) { s += 4; flags.push('mention'); }
    if (TIME_RE.test(f)) { s += 1.5; flags.push('time'); }
    if (URGENT_RE.test(f)) { s += 2; flags.push('urgent'); }
    if (QUESTION_RE.test(f.trim()) && m.senderUsername !== me) { s += 1; flags.push('question'); }
    if (ws.length < 2) s -= 2;                                   // "ok", "uh" ... không quan trọng
    return { m, s, flags };
  });

  const highlights = [...scored].filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4)
    .sort((a, b) => a.m.createdAt - b.m.createdAt).map((x) => ({ who: x.m.senderUsername, text: x.m.body, flags: x.flags }));
  const pick = (flag) => scored.filter((x) => x.flags.includes(flag)).map((x) => ({ who: x.m.senderUsername, text: x.m.body }));

  return {
    total: items.length,
    people: Object.entries(people).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    keywords,
    highlights,
    mentions: pick('mention'),
    questions: pick('question').slice(-5),
    times: pick('time').slice(-5),
    urgent: pick('urgent').slice(-5),
    polls: items.filter((m) => m.type === 'poll').length,
    events: items.filter((m) => m.type === 'system').map((m) => m.body).slice(-5),
    span: items.length ? [items[0].createdAt, items[items.length - 1].createdAt] : null,
  };
}
