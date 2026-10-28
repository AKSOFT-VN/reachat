// Trang quản trị ReaChat (JS thuần, gọi /api/admin/*). Token lưu sessionStorage (đóng tab = đăng xuất).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (t) => (t ? new Date(t).toLocaleString('vi-VN') : '—');
const num = (n) => Number(n || 0).toLocaleString('vi-VN');
const bytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
let token = sessionStorage.getItem('reachat.admin.token');
let me = sessionStorage.getItem('reachat.admin.user');

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error('Phiên đăng nhập hết hiệu lực'); }
  if (!res.ok) { const e = new Error(data.error || 'Lỗi ' + res.status); e.data = data; throw e; }
  return data;
}
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3000); }
function logout() { token = null; sessionStorage.clear(); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }

// ---- Đăng nhập (kể cả xác thực 2 bước) ----
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#lerr').textContent = '';
  try {
    const r = await api('/api/login', { method: 'POST', body: { username: $('#lu').value, password: $('#lp').value, ...($('#lo').value ? { otp: $('#lo').value } : {}) } });
    token = r.token;
    await api('/api/admin/stats');                       // kiểm tra quyền
    me = r.user.username;
    sessionStorage.setItem('reachat.admin.token', token); sessionStorage.setItem('reachat.admin.user', me);
    start();
  } catch (err) {
    if (err.data?.need2fa) { $('#lo').classList.remove('hidden'); $('#lo').focus(); }
    $('#lerr').textContent = err.message; token = null;
  }
});
$('#logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });

// ---- Tab ----
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
function show(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of ['dash', 'reports', 'users', 'gifs', 'mod', 'audit']) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  ({ dash: loadStats, reports: loadReports, users: loadUsers, gifs: loadGifs, mod: loadMod, audit: loadAudit })[tab]();
}

// ---- Tổng quan ----
async function loadStats() {
  const s = await api('/api/admin/stats');
  const tiles = [
    ['Người dùng', num(s.users), `+${num(s.newUsers24h)} trong 24 giờ`], ['Đang trực tuyến', num(s.online)],
    ['Tin nhắn', num(s.messages), `${num(s.messages24h)} trong 24 giờ`], ['Nhóm', num(s.groups)],
    ['Cuộc gọi 24 giờ', num(s.calls24h)], ['Tệp', num(s.files), bytes(s.fileBytes) + ' (đã mã hóa)'],
    ['Báo cáo chờ xử lý', num(s.reportsOpen), null, s.reportsOpen > 0], ['Tài khoản bị khóa', num(s.banned)],
    ['Lỗi ứng dụng 24 giờ', num(s.clientErrors24h || 0), s.alertEnabled ? 'cảnh báo: đã bật' : 'cảnh báo: CHƯA cấu hình', !s.alertEnabled || s.clientErrors24h > 50],
    ...(s.db ? [['CSDL (SQLite)', s.db.sizeMB + ' MB', num(s.db.queries) + ' truy vấn · ' + num(s.db.slow) + ' chậm (> ' + s.db.slowMs + ' ms)', s.db.slow > 0]] : []),
    ...(s.turn ? [['TURN tháng ' + s.turn.month, s.turn.usedGB + ' GB', 'hạn mức ' + s.turn.limitGB + ' GB (ước tính từ app)', s.turn.usedGB >= s.turn.limitGB * 0.8]] : []),
  ];
  $('#tiles').innerHTML = tiles.map(([l, v, sub, alert]) => `<div class="tile${alert ? ' alert' : ''}"><div class="v">${v}</div><div class="l">${l}${sub ? '<br>' + esc(sub) : ''}</div></div>`).join('');
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); days.push(d.toLocaleDateString('sv-SE')); }
  const by = Object.fromEntries(s.perDay.map((r) => [r.d, r.n]));
  const max = Math.max(1, ...days.map((d) => by[d] || 0));
  $('#chart').innerHTML = days.map((d) => `<div class="bar" title="${d}: ${by[d] || 0} tin"><b>${by[d] || ''}</b><i style="height:${((by[d] || 0) / max) * 100}%"></i><span>${d.slice(8)}/${d.slice(5, 7)}</span></div>`).join('');
  const errs = await api('/api/admin/errors');
  let box = document.getElementById('errbox');
  if (!box) { box = document.createElement('div'); box.id = 'errbox'; $('#chart').after(box); }
  box.innerHTML = '<h3>Cảnh báo gần đây</h3>' + ((s.alerts || []).length ? '<ul>' + s.alerts.map((a) => `<li><span class="muted small">${fmt(a.at)}</span> ${esc(a.text)}</li>`).join('') + '</ul>' : '<p class="muted small">Không có.</p>')
    + '<h3>Truy vấn CSDL chậm gần đây</h3>' + ((s.db?.recentSlow || []).length ? '<table class="errs"><tr><th>ms</th><th>Câu lệnh</th><th>Lúc</th></tr>' + s.db.recentSlow.map((q) => `<tr><td>${q.ms}</td><td><code>${esc(q.sql)}</code></td><td>${fmt(q.at)}</td></tr>`).join('') + '</table>' : '<p class="muted small">Không có.</p>')
    + '<h3>Lỗi ứng dụng hay gặp (7 ngày)</h3>' + (errs.top.length ? '<table class="errs"><tr><th>Số lần</th><th>Lỗi</th><th>Bản</th><th>Gần nhất</th></tr>' + errs.top.map((e) => `<tr><td>${e.n}</td><td>${esc(e.message)}</td><td>${esc(e.version || '')}</td><td>${fmt(e.lastAt)}</td></tr>`).join('') + '</table>' : '<p class="muted small">Không có lỗi nào.</p>');
  $('#openBadge').textContent = s.reportsOpen; $('#openBadge').classList.toggle('hidden', !s.reportsOpen);
}

// ---- Báo cáo ----
$('#rstatus').addEventListener('change', loadReports);
$('#rreload').addEventListener('click', loadReports);
async function loadReports() {
  const { reports } = await api('/api/admin/reports?status=' + $('#rstatus').value);
  $('#reports').innerHTML = reports.length ? reports.map((r) => `
    <div class="report" data-id="${r.id}">
      <div class="head"><span class="tag ${esc(r.reason)}">${esc(r.reasonLabel)}</span>
        <b>@${esc(r.target?.username)}</b>${r.targetBanned ? ' <span class="tag">đã khóa</span>' : ''}
        <span class="muted small">bị @${esc(r.reporter)} báo cáo · ${fmt(r.createdAt)}</span>
        ${r.status !== 'open' ? `<span class="tag ok">${r.status === 'resolved' ? 'Đã xử lý' : 'Đã bỏ qua'}${r.handledBy ? ' bởi @' + esc(r.handledBy) : ''}</span>` : ''}</div>
      ${r.note ? `<div><span class="muted small">Ghi chú:</span> ${esc(r.note)}</div>` : ''}
      ${r.content != null ? `<div class="quote">${esc(r.content)}</div><div class="muted small">↑ Nội dung do người báo cáo tự gửi kèm (tin gốc mã hóa đầu-cuối).</div>`
        : '<div class="muted small">Không kèm nội dung — chỉ xem được thông tin tài khoản.</div>'}
      ${r.message ? `<div class="muted small">Tin ${esc(r.message.type)} lúc ${fmt(r.message.createdAt)}${r.message.recalled ? ' · đã gỡ/thu hồi' : ''}</div>` : ''}
      ${r.handledNote ? `<div class="muted small">Xử lý: ${esc(r.handledNote)}</div>` : ''}
      <div class="actions">
        ${r.status === 'open' ? `<button class="primary" data-act="resolve">Đã xử lý</button><button class="ghost" data-act="dismiss">Bỏ qua</button>` : `<button class="ghost" data-act="reopen">Mở lại</button>`}
        ${r.message && !r.message.recalled ? `<button class="danger" data-act="remove" data-msg="${esc(r.message.id)}">Gỡ tin</button>` : ''}
        ${r.target && !r.targetBanned ? `<button class="danger" data-act="ban" data-user="${esc(r.target.id)}" data-name="${esc(r.target.username)}">Khóa tài khoản</button>` : ''}
      </div>
    </div>`).join('') : '<div class="muted">Không có báo cáo.</div>';
}
$('#reports').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.report').dataset.id;
  try {
    if (b.dataset.act === 'resolve' || b.dataset.act === 'dismiss' || b.dataset.act === 'reopen') {
      const note = b.dataset.act === 'reopen' ? '' : prompt('Ghi chú xử lý (tuỳ chọn):') ?? '';
      await api('/api/admin/reports/' + id, { method: 'POST', body: { status: { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open' }[b.dataset.act], note } });
    } else if (b.dataset.act === 'remove') {
      if (!confirm('Gỡ tin này khỏi máy chủ và mọi thiết bị?')) return;
      await api('/api/admin/messages/' + b.dataset.msg + '/remove', { method: 'POST' });
      toast('Đã gỡ tin');
    } else if (b.dataset.act === 'ban') {
      const reason = prompt(`Lý do khóa @${b.dataset.name}:`); if (reason == null) return;
      await api('/api/admin/users/' + b.dataset.user + '/ban', { method: 'POST', body: { banned: true, reason } });
      toast('Đã khóa @' + b.dataset.name);
    }
    loadReports(); loadStats();
  } catch (err) { toast('⚠️ ' + err.message); }
});

// ---- Người dùng ----
$('#ureload').addEventListener('click', loadUsers);
$('#uq').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUsers(); });
async function loadUsers() {
  const { users } = await api('/api/admin/users?q=' + encodeURIComponent($('#uq').value));
  $('#users').innerHTML = users.map((u) => `<tr>
    <td><b>@${esc(u.username)}</b>${u.online ? '<span class="dot" title="đang trực tuyến"></span>' : ''}<br><span class="muted small">${esc(u.displayName)}${u.role === 'admin' ? ' · quản trị' : ''}${u.totp ? ' · 2 bước' : ''}</span></td>
    <td class="small">${fmt(u.createdAt)}</td>
    <td>${u.banned ? `<span class="tag scam">Đã khóa</span><br><span class="muted small">${esc(u.banReason)}</span>` : '<span class="tag ok">Hoạt động</span>'}</td>
    <td>${u.reports || ''}</td>
    <td class="actions">${u.username === me ? '<span class="muted small">(bạn)</span>' : `
      ${u.banned ? `<button class="ghost" data-uact="unban" data-id="${esc(u.id)}">Mở khóa</button>` : `<button class="danger" data-uact="ban" data-id="${esc(u.id)}" data-name="${esc(u.username)}">Khóa</button>`}
      <button class="ghost" data-uact="${u.role === 'admin' ? 'unadmin' : 'admin'}" data-id="${esc(u.id)}">${u.role === 'admin' ? 'Gỡ quản trị' : 'Cấp quản trị'}</button>`}</td>
  </tr>`).join('');
}
$('#users').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-uact]'); if (!b) return;
  try {
    const id = b.dataset.id, act = b.dataset.uact;
    if (act === 'ban') { const reason = prompt(`Lý do khóa @${b.dataset.name}:`); if (reason == null) return; await api(`/api/admin/users/${id}/ban`, { method: 'POST', body: { banned: true, reason } }); }
    if (act === 'unban') await api(`/api/admin/users/${id}/ban`, { method: 'POST', body: { banned: false } });
    if (act === 'admin' || act === 'unadmin') await api(`/api/admin/users/${id}/role`, { method: 'POST', body: { role: act === 'admin' ? 'admin' : null } });
    loadUsers();
  } catch (err) { toast('⚠️ ' + err.message); }
});

function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#meName').textContent = '@' + me;
  show('dash');
}
if (token) api('/api/admin/stats').then(start).catch(logout); else logout();

// ---- Kho GIF ----
const gifUrls = new Map();   // id -> blob URL (ảnh tải kèm token)
async function gifThumb(id) {
  if (gifUrls.has(id)) return gifUrls.get(id);
  const r = await fetch('/api/admin/gifs/' + id + '/file', { headers: { Authorization: 'Bearer ' + token } });
  const u = r.ok ? URL.createObjectURL(await r.blob()) : '';
  gifUrls.set(id, u); return u;
}
async function loadGifs() {
  const kind = $('#gkind').value;
  const { total, items } = await api('/api/admin/gifs?kind=' + kind + '&q=' + encodeURIComponent($('#gq').value || ''));
  $('#gcount').textContent = num(total) + (kind === 'sticker' ? ' sticker' : ' GIF') + ' trong kho' + ($('#gq').value ? ' · ' + num(items.length) + ' khớp' : '');
  $('#gifs').innerHTML = items.length ? items.map((g) => `<div class="gif-card" data-id="${g.id}">
      <div class="gif-img"><img alt=""></div>
      ${g.kind === 'sticker' ? `<input class="gp" value="${esc(g.pack)}" placeholder="Gói">` : ''}
      <input class="gt" value="${esc(g.title)}" placeholder="Tên">
      <input class="gg" value="${esc(g.tags)}" placeholder="Từ khóa, cách nhau dấu phẩy">
      <div class="gif-foot"><span class="muted small">${bytes(g.size)} · ${num(g.uses)} lượt gửi</span>
        <button class="ghost gsave">Lưu</button><button class="ghost danger gdel">Xóa</button></div>
    </div>`).join('') : '<p class="muted">Kho chưa có GIF nào khớp.</p>';
  for (const card of document.querySelectorAll('.gif-card')) gifThumb(card.dataset.id).then((u) => { card.querySelector('img').src = u; });
}
let gqT; $('#gq').addEventListener('input', () => { clearTimeout(gqT); gqT = setTimeout(loadGifs, 300); });
$('#gifs').addEventListener('click', async (e) => {
  const card = e.target.closest('.gif-card'); if (!card) return;
  try {
    if (e.target.classList.contains('gsave')) {
      await api('/api/admin/gifs/' + card.dataset.id, { method: 'POST', body: { title: card.querySelector('.gt').value, tags: card.querySelector('.gg').value, ...(card.querySelector('.gp') ? { pack: card.querySelector('.gp').value } : {}) } });
      toast('Đã lưu');
    } else if (e.target.classList.contains('gdel')) {
      if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Bấm lần nữa để xóa'; return; }
      await api('/api/admin/gifs/' + card.dataset.id, { method: 'DELETE' });
      card.remove(); toast('Đã xóa GIF');
    }
  } catch (err) { toast(err.message); }
});
const fileB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
$('#gfiles').addEventListener('change', async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  let ok = 0, dup = 0, bad = [];
  for (const [i, f] of files.entries()) {
    $('#gprog').textContent = `Đang tải lên ${i + 1}/${files.length}: ${f.name}`;
    try {
      const r = await api('/api/admin/gifs', { method: 'POST', body: { dataB64: await fileB64(f), title: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), tags: $('#gtags').value, kind: $('#gkind').value, pack: $('#gpack').value } });
      r.duplicate ? dup++ : ok++;
    } catch (err) { bad.push(f.name + ': ' + err.message); }
  }
  $('#gprog').textContent = `Xong: thêm ${ok}${dup ? ', ' + dup + ' trùng (đã có)' : ''}${bad.length ? ', lỗi ' + bad.length + ' — ' + bad.join('; ') : ''}`;
  loadGifs();
});

$('#gkind').addEventListener('change', () => { $('#gpack').classList.toggle('hidden', $('#gkind').value !== 'sticker'); loadGifs(); });

// ---- Kiểm duyệt ----
async function loadMod() { const m = await api('/api/admin/moderation'); $('#mwords').value = m.blockedWords || ''; $('#mdomains').value = m.blockedDomains || ''; $('#mmsg').textContent = ''; }
$('#msave').addEventListener('click', async () => {
  try { await api('/api/admin/moderation', { method: 'POST', body: { blockedWords: $('#mwords').value, blockedDomains: $('#mdomains').value } }); $('#mmsg').textContent = '✓ Đã lưu — áp dụng ngay'; }
  catch (e) { $('#mmsg').textContent = e.message; }
});
// ---- Nhật ký quản trị ----
async function loadAudit() {
  const { items } = await api('/api/admin/audit');
  $('#audit').innerHTML = items.length ? items.map((a) => `<tr><td>${fmt(a.at)}</td><td>@${esc(a.admin || '?')}</td><td>${esc(a.action)}</td><td>${esc(a.target || '')}</td><td class="muted small">${esc(a.detail || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">Chưa có thao tác nào.</td></tr>';
}
$('#areload').addEventListener('click', loadAudit);
