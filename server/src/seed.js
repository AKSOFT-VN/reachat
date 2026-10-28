// Tạo nhanh 2 tài khoản demo để thử: nam / binh (mật khẩu: 123456)
import { register } from './auth.js';

const run = async () => {
  for (const username of ['nam', 'binh']) {
    try {
      await register({ username, password: '123456', displayName: username.toUpperCase() });
      console.log('Đã tạo', username);
    } catch (e) {
      console.log(username, '->', e.message);
    }
  }
  process.exit(0);
};
run();
