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

## Điều 3: Dữ liệu là vàng & Phải nguyên tử
* Mọi thao tác cập nhật trạng thái học sinh phải là **Atomic Conditional Update** (`WHERE status IN ('empty', 'error', 'manual_review') RETURNING ...`) để loại bỏ Race Condition.
* Mọi thao tác ghi nhận vào hàng đợi và cập nhật kết quả phải mang tính **Idempotent** (ID công việc duy nhất theo `alias_id`).
* Dữ liệu sao lưu phải định kỳ kiểm tra khả năng phục hồi thực tế.

## Điều 4: HANET là external dependency có rủi ro cao
* Mọi lệnh gọi API ra ngoài phải có timeout (`AbortSignal.timeout(120000)`), retry có backoff và cơ chế ngắt mạch (*Circuit Breaker*).
* Token truy cập HANET phải được tự động gia hạn trước khi hết hạn (chống lỗi `-103`).
* Phải luôn có mock server để kiểm thử hồi quy mà không tiêu tốn hạn ngạch thật của đối tác.

## Điều 5: Người dùng cuối là học sinh & Giáo viên
* Giao diện học sinh phải ưu tiên thiết bị di động (Mobile-First), tải nhanh dưới 2s trên kết nối 4G.
* Tuyệt đối không để người dùng thấy lỗi HTTP 500 thô; mọi lỗi phải được chuyển hóa thành chỉ dẫn thân thiện.
* Cơ chế Polling phải có phản hồi vị trí hàng đợi (*Queue Position Feedback*) rõ ràng để học sinh an tâm chờ đợi.
