# Đăng ký lớp Pickleball — Khóa 4 & 5

Trang đăng ký nội bộ: mỗi khóa 12 chỗ, mỗi số điện thoại chỉ đăng ký được 1 lần.
Khóa nào đủ người thì tự khóa. Cả hai khóa đều đủ thì người đăng ký vào danh sách chờ,
có người hủy là người chờ lâu nhất được xếp vào.

- `index.html`: trang đăng ký và tra cứu chỗ bằng SĐT. Người học không tự hủy được, chỉ admin mới xóa hoặc chuyển chỗ.
- `admin.html`: trang quản trị, gồm xem danh sách, chuyển khóa, xóa, mở/đóng đăng ký, xuất CSV, cấp quyền admin cho người khác
- `supabase/schema.sql`: database và toàn bộ luật (chặn trùng, giới hạn 12, danh sách chờ)

Chưa cấu hình Supabase thì trang chạy **chế độ demo**, dữ liệu giả lưu trong trình duyệt
(admin demo: `admin@demo.vn` / `demo`).

## Cài đặt Supabase (khoảng 5 phút)

1. Vào https://supabase.com, đăng nhập bằng `vvnhan.work@gmail.com` → **New project**
   (Region: Singapore).
2. **SQL Editor → New query**, dán toàn bộ `supabase/schema.sql` → **Run**.
3. Admin đầu tiên: **Authentication → Users → Add user → Create new user**
   (email + mật khẩu, tick *Auto Confirm User*), rồi chạy trong SQL Editor:
   ```sql
   insert into public.admins (email) values ('vvnhan.work@gmail.com');
   ```
4. **Authentication → URL Configuration**: đặt *Site URL* là
   `https://pickleball-dangky.vercel.app/admin.html`, để link xác nhận email mở đúng trang.
5. Thêm admin khác: vào trang admin → **Người quản trị** → nhập email.
   Người đó mở `admin.html` → **Tạo mật khẩu** → bấm link trong email → đăng nhập.
   Người tự tạo tài khoản mà không được cấp quyền thì không làm được gì.
6. **Project Settings → API**: copy *Project URL* và *anon public key* vào `js/config.js`.

Anon key là khóa công khai, được phép nằm trong web. Bảng dữ liệu đã bật RLS và khóa hết;
người dùng chỉ gọi được các hàm `get_status`, `register`, `lookup`, `cancel`.

## Tùy chỉnh

- Đổi tên, số chỗ, lịch học: sửa bảng `courses` trong Supabase → Table Editor.
- **Khóa 5 chỉ mở khi Khóa 4 đủ**: bật/tắt ở trang admin (mặc định tắt, tức người đăng ký tự chọn khóa).
- Đóng đăng ký: tắt công tắc *Mở đăng ký* ở trang admin.

## Chạy thử và test

```bash
npm install
npm run dev              # http://localhost:5173
npm test                 # test database (PGlite) + logic + backend demo
npm run test:coverage
```
