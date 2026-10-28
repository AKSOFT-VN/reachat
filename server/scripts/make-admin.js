// Cấp / gỡ quyền quản trị: npm run make-admin -- <username> [--remove]
import { getUserByUsername } from '../src/db.js';
import { setRole } from '../src/admin.js';

const [name, flag] = process.argv.slice(2);
if (!name) { console.log('Dùng: npm run make-admin -- <username> [--remove]'); process.exit(1); }
const u = getUserByUsername(name.toLowerCase());
if (!u) { console.log('Không tìm thấy tài khoản', name); process.exit(1); }
setRole(u.id, flag === '--remove' ? null : 'admin');
console.log(flag === '--remove' ? `Đã gỡ quyền quản trị của @${u.username}` : `@${u.username} giờ là quản trị viên — đăng nhập tại <máy chủ>/admin`);
