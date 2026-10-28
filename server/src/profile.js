// Hồ sơ đầy đủ: giới thiệu bản thân, sinh nhật (hiện theo lựa chọn: ẩn / ngày-tháng / đủ năm), ảnh bìa.
// Ảnh bìa nặng nên KHÔNG nằm trong publicUser (danh sách thành viên/danh bạ) — chỉ trả khi mở hồ sơ.
import db, { publicUser, getUserByUsername, isBlocked, areFriends } from './db.js';
import { assertClean } from './moderation.js';

const err = (status, message) => Object.assign(new Error(message), { status });
const bday = (u, self) => {
  if (!u.birthday) return null;
  if (self || u.show_birthday === 2) return u.birthday;
  if (u.show_birthday === 1) return '--' + u.birthday.slice(5);        // "--MM-DD": chỉ ngày/tháng
  return null;
};

export function profileOf(me, username) {
  const u = getUserByUsername(username);
  if (!u || (u.banned && u.id !== me.id)) return null;
  const self = u.id === me.id;
  if (!self && isBlocked(u.id, me.id)) return { ...publicUser(u), lastSeen: null, blocked: true };
  return {
    ...publicUser(u), bio: u.bio || '', birthday: bday(u, self), cover: u.cover || null,
    ...(self ? { showBirthday: u.show_birthday } : { friend: areFriends(me.id, u.id) }),
  };
}

export function updateProfileExtra(userId, { bio, birthday, showBirthday, cover }) {
  if (bio != null) assertClean(bio, 'Giới thiệu');
  if (bio != null) db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(String(bio).slice(0, 200), userId);
  if (birthday !== undefined) {
    const b = birthday ? String(birthday) : null;
    if (b && (!/^\d{4}-\d{2}-\d{2}$/.test(b) || isNaN(Date.parse(b)) || b > new Date().toISOString().slice(0, 10))) throw err(400, 'Ngày sinh không hợp lệ');
    db.prepare('UPDATE users SET birthday = ? WHERE id = ?').run(b, userId);
  }
  if (showBirthday != null) db.prepare('UPDATE users SET show_birthday = ? WHERE id = ?').run([0, 1, 2].includes(+showBirthday) ? +showBirthday : 1, userId);
  if (cover !== undefined) {
    const c = cover ? String(cover) : null;
    if (c && (!/^data:image\/(png|jpe?g|webp);base64,/.test(c) || c.length > 600_000)) throw err(400, 'Ảnh bìa không hợp lệ hoặc quá lớn');
    db.prepare('UPDATE users SET cover = ? WHERE id = ?').run(c, userId);
  }
}

// Bạn bè có sinh nhật hôm nay (giờ Việt Nam), chỉ người cho hiện sinh nhật.
export function birthdaysToday(userId) {
  const md = new Date(Date.now() + 7 * 3600_000).toISOString().slice(5, 10);
  return db.prepare(`SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.owner_id = ? AND u.banned = 0 AND u.show_birthday > 0 AND substr(u.birthday, 6, 5) = ?`).all(userId, md).map(publicUser);
}
