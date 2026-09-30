# Đăng ký lớp Pickleball — Khóa 4 & 5

Trang đăng ký nội bộ: mỗi khóa 12 chỗ, mỗi số điện thoại chỉ đăng ký được 1 lần.
Khóa nào đủ người thì tự khóa. Cả hai khóa đều đủ thì người đăng ký vào danh sách chờ,
có người hủy là người chờ lâu nhất được xếp vào.

- `index.html`: trang đăng ký và tra cứu chỗ bằng SĐT. Người học không tự hủy được, chỉ admin mới xóa hoặc chuyển chỗ.
- `admin.html`: trang quản trị, gồm xem danh sách, chuyển khóa, xóa, sửa khóa (tên, số chỗ, lịch học), copy danh sách để dán Zalo, mở/đóng đăng ký, xuất CSV, đổi mật khẩu
- Realtime: có người đăng ký là sân và trang admin cập nhật ngay, không cần tải lại
- `supabase/schema.sql`: database và toàn bộ luật (chặn trùng, giới hạn 12, danh sách chờ)

Chưa cấu hình Supabase thì trang chạy **chế độ demo**, dữ liệu giả lưu trong trình duyệt
(admin demo: `admin` / `demo`).

## Cài đặt Supabase (khoảng 5 phút)

1. Vào https://supabase.com, đăng nhập bằng `vvnhan.work@gmail.com` → **New project**
   (Region: Singapore).
2. **SQL Editor → New query**, dán toàn bộ `supabase/schema.sql` → **Run**.
3. Chỉ có **1 tài khoản admin**, tên đăng nhập `admin` (phía Supabase là `admin@pickleball.local`,
   đã có sẵn trong bảng `admins`). Tạo user: **Authentication → Users → Add user → Create new user**,
   email `admin@pickleball.local`, tick *Auto Confirm User*. Đổi mật khẩu sau ở cuối trang admin.
4. **Authentication → Sign In / Providers**: tắt *Allow new users to sign up*.
5. Không có chức năng tự đăng ký hay tự hủy: chỉ admin xóa hoặc chuyển chỗ.
6. **Project Settings → API**: copy *Project URL* và *anon public key* vào `js/config.js`.

Anon key là khóa công khai, được phép nằm trong web. Bảng dữ liệu đã bật RLS và khóa hết;
người dùng chỉ gọi được các hàm `get_status`, `register`, `lookup`.

**Realtime:** mỗi thay đổi, database phát tín hiệu `changed` (không kèm dữ liệu) lên kênh công khai
`pickleball`, trang web nghe được thì tải lại trạng thái. Cần bật **Realtime Settings → Allow public access**
(mặc định đã bật). Nếu realtime không kết nối được, trang vẫn tự tải lại mỗi 15 giây.

## Tùy chỉnh

- Đổi tên, số chỗ, lịch học: nút **Sửa khóa** ở trang admin. Tăng số chỗ thì người chờ được xếp vào ngay; không giảm được dưới số người đang có.
- **Khóa 5 chỉ mở khi Khóa 4 đủ**: bật/tắt ở trang admin (mặc định tắt, tức người đăng ký tự chọn khóa).
- Đóng đăng ký: tắt công tắc *Mở đăng ký* ở trang admin.

## Chạy thử và test

```bash
npm install
npm run dev              # http://localhost:5173
npm test                 # test database (PGlite) + logic + backend demo
npm run test:coverage
```
