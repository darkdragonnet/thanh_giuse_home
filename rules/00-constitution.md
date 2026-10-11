# HIẾN PHÁP DỰ ÁN — KHÔNG ĐƯỢC VI PHẠM

## Điều 1: Tài nguyên là hữu hạn
* VPS có **3.0 GB RAM**. Mọi quyết định thiết kế và lập trình phải xuất phát từ giới hạn này.
* Tuyệt đối **KHÔNG** thêm service mới nếu không chứng minh được mức tiêu thụ RAM < 100MB.
* Tuyệt đối **KHÔNG** dùng ORM nặng (như Prisma binary engine) hoặc framework cồng kềnh.
* Tuyệt đối **KHÔNG** chạy `npm install`, `docker build`, hay `pg_dump` trực tiếp trên VPS production vào giờ hoạt động.

## Điều 2: Worker là tài nguyên khan hiếm
* Worker Concurrency = **1**. Đây là hằng số bất biến nhằm đảm bảo giải nén và xử lý ảnh tuần tự bằng Sharp mà không làm sập máy chủ.
* Mọi job phải có timeout tối đa **120s**.
* Mọi lỗi phải được phân loại rõ ràng: Có thể thử lại (*Retryable*) vs Lỗi vĩnh viễn cần xử lý thủ công (*Manual Review*).

## Điều 3: Dữ Liệu Là Vàng & Phải Nguyên Tử (Atomic Data Integrity)

1. **Nguồn Chân Lý Duy Nhất (Single Source of Truth)**:
   - Cơ sở dữ liệu PostgreSQL trên VPS là nơi lưu trữ trạng thái phê duyệt cuối cùng (`status = 'success'`), liên kết lớp (`class_id`), mã PIN và nhật ký kiểm toán.
   - Máy trạm cục bộ chỉ là bản sao phục vụ đối soát/offline cache. Mọi cập nhật từ VPS luôn có quyền ưu tiên ghi đè tuyệt đối.

2. **Quy Tắc Định Danh Cố Định (Fixed-Width 9 Ký Tự)**:
   - Mọi định danh học sinh (`alias_id`) và mã dự phòng (`backup_code`) bắt buộc tuân thủ chuẩn chuỗi có độ dài cố định **đúng 9 ký tự** theo công thức:
     $$\text{Độ dài} = \text{Tiền tố (4 ký tự)} + \text{Dấu gạch dưới (\_)} + \text{Hậu tố (4 ký tự)} = 9\text{ ký tự}$$
   - Biểu thức chính quy kiểm thực bắt buộc: `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`.
   - Với các mã lớp hoặc đối tượng có độ dài gốc ngắn hơn 4 ký tự (ví dụ: `GLV`, `LM`), bắt buộc áp dụng thuật toán đệm mã (Padded Prefix) như `GLV0`, `LM01` để bảo đảm độ dài bất biến luôn bằng 9.

3. **Bảo Toàn Hậu Tố Học Sinh (Student Suffix Invariant)**:
   - Hậu tố 4 ký tự (`student_suffix`) đại diện cho mã định danh độc bản duy nhất của học sinh trong suốt niên khóa.
   - Khi học sinh chuyển lớp hoặc đổi phòng ban:
     - Hệ thống **chỉ được phép thay đổi 4 ký tự tiền tố lớp**.
     - **Bảo toàn 100% hậu tố 4 ký tự gốc** để triệt tiêu mọi nguy cơ xung đột số thứ tự (STT) hoặc va chạm khóa nội bộ giữa các lớp.

4. **Nguyên Tử & Idempotent (Atomic Conditional Update & Idempotency)**:
   - Mọi thao tác cập nhật trạng thái học sinh phải là **Atomic Conditional Update** (`WHERE status IN ('empty', 'error', 'manual_review') RETURNING ...`) để loại bỏ Race Condition.
   - Mọi thao tác ghi nhận vào hàng đợi và cập nhật kết quả phải mang tính **Idempotent** (ID công việc duy nhất theo `alias_id`).
   - Dữ liệu sao lưu phải định kỳ kiểm tra khả năng phục hồi thực tế.

---

## Điều 4: Ràng Buộc Phụ Thuộc HANET Cloud (HANET Dependency & Safeguards)

1. **Chốt Chặn Độ Dài Trần (Cloud Ceiling Guard)**:
   - Nghiêm cấm đẩy lên HANET Cloud bất kỳ `aliasID` nào có độ dài khác chuẩn 9 ký tự (đặc biệt là các chuỗi vượt quá 9 ký tự).
   - Tầng Worker trước khi gửi lệnh gọi API `POST /person/register` hoặc `POST /person/updateAliasID` phải kích hoạt validation chặn ngay lập tức nếu chuỗi không khớp biểu thức regex `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$`.

2. **Cô Lập Seed Data Cũ (Legacy Data Quarantine)**:
   - Tất cả các bản ghi khởi tạo ban đầu theo định dạng seed cũ (ví dụ: `STU_10A1_001_A7B2C` - 17 ký tự) phải bị đưa vào danh sách cô lập an toàn với trạng thái `LEGACY_FORMAT_QUARANTINED`.
   - **Nghiêm cấm Quản trị viên (Admin) tự ý can thiệp, chỉnh sửa hoặc xóa thủ công** các bản ghi này trên giao diện Dashboard.
   - Các bản ghi này chỉ được phép xử lý thông qua kịch bản migration và chuyển đổi dữ liệu chính thức có cơ chế Dry-run phê duyệt trước.

3. **Bảo Toàn Phòng Ban Khi Đổi Alias (Department Lock)**:
   - Mọi thao tác cập nhật alias trên HANET Cloud bắt buộc phải tuân thủ quy trình 2 bước nguyên tử:
     1. Gọi `POST /person/updateAliasID` cập nhật mã mới.
     2. Nghỉ `delay(120ms)` để kiểm soát rate limit.
     3. Gọi `POST /department/add-person` để khóa lại `departmentID` ngay lập tức, ngăn chặn triệt để hành vi tự động văng về phòng ban mặc định (ID 0) của HANET.

4. **Sự Cố Token & Ngắt Mạch (Token Expire & Circuit Breaker)**:
   - Mọi lệnh gọi API ra ngoài phải có timeout (`AbortSignal.timeout(120000)`), retry có backoff và cơ chế ngắt mạch (*Circuit Breaker*).
   - **TUYỆT ĐỐI KHÔNG auto-refresh token:** Khi phát hiện mã lỗi `-103` (`ACCESS_TOKEN_EXPIRE`), hệ thống coi đây là sự cố hệ thống nghiêm trọng (*Critical Incident*). Lập tức kích hoạt chế độ bảo trì toàn hệ thống (*Kill Switch*: Redis `setting:kill_switch="true"` và Postgres `registration_enabled='false'`), tạm dừng worker/queue, ghi log `SYSTEM_TOKEN_EXPIRED` và gửi cảnh báo khẩn cấp tới Admin Dashboard. Admin cập nhật `HANET_ACCESS_TOKEN` mới trong `.env` trên VPS và khởi động lại dịch vụ qua lệnh: `docker compose restart api-server queue-worker`.
   - Phải luôn có mock server để kiểm thử hồi quy mà không tiêu tốn hạn ngạch thật của đối tác.

## Điều 5: Người dùng cuối là học sinh & Giáo viên
* Giao diện học sinh phải ưu tiên thiết bị di động (Mobile-First), tải nhanh dưới 2s trên kết nối 4G.
* Tuyệt đối không để người dùng thấy lỗi HTTP 500 thô; mọi lỗi phải được chuyển hóa thành chỉ dẫn thân thiện.
* Cơ chế Polling phải có phản hồi vị trí hàng đợi (*Queue Position Feedback*) rõ ràng để học sinh an tâm chờ đợi.
