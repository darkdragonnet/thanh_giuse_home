# Feature Specification: Student Face Registration & Onboarding

**Feature Branch**: `001-student-face-registration`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Đặc tả luồng đăng ký hình ảnh học sinh tích hợp HANET Cloud (1.200 học sinh) trên hạ tầng VPS 3GB RAM"

---

## I. Tổng quan Hành trình Người dùng (User Journey)

Hành trình đăng ký hình ảnh khuôn mặt được thiết kế theo mô hình **Mobile-First**, tối ưu hóa trải nghiệm trực quan cho học sinh/phụ huynh và giáo viên chủ nhiệm, đồng thời bảo vệ máy chủ hạn chế tài nguyên:

1. **Khám phá & Xác định danh tính**:
   - Người dùng truy cập liên kết đăng ký trên điện thoại hoặc máy tính.
   - Hệ thống kiểm tra tức thì chốt chặn hoạt động toàn trường và trạng thái khóa của lớp.
   - Người dùng duyệt theo Khối -> Lớp -> Danh sách học sinh và chọn đúng hồ sơ của mình.
2. **Thu thập & Chuẩn hóa ảnh tại Máy khách (Client-Side)**:
   - Giao diện hướng dẫn trực quan tiêu chuẩn ảnh chân dung: chụp thẳng góc, đủ sáng, không đeo kính râm hay khẩu trang.
   - Người dùng chụp trực tiếp từ camera hoặc tải ảnh có sẵn từ thư viện ảnh thiết bị.
   - Trình duyệt tự động tiền xử lý và nén ảnh bằng HTML5 Canvas nhằm giảm kích thước xuống mức mục tiêu trước khi gửi dữ liệu qua mạng.
   - Người dùng xem trước (Preview) ảnh đã chuẩn hóa và xác nhận gửi.
3. **Tiếp nhận & Cấp biên nhận Bất đồng bộ**:
   - Hệ thống kiểm tra hạn mức gửi yêu cầu (hoặc áp dụng quyền miễn trừ nếu do giáo viên phụ trách lớp thực hiện).
   - Hệ thống thực hiện cập nhật khóa điều kiện nguyên tử chuyển trạng thái sang chờ xử lý và đưa tác vụ vào hàng đợi ngầm.
   - Người dùng nhận ngay biên nhận tiếp nhận hồ sơ thành công trong thời gian dưới 1,5 giây.
4. **Theo dõi Tiến trình Đồng bộ & Vị trí Hàng đợi**:
   - Trình duyệt giữ nguyên màn hình trạng thái hoặc cho phép người dùng đóng trang và tra cứu lại sau bằng cùng đường liên kết.
   - Giao diện hiển thị trực quan thông báo hồ sơ đã vào hàng đợi xử lý nền, giải thích rõ nhịp độ đồng bộ (1 request/phút, toàn trường ~20 giờ cho 1.200 em), cùng vị trí số thứ tự còn lại trong hàng đợi.
   - Trạng thái `pending` KHÔNG hết hạn, được duy trì liên tục cho đến khi tác vụ nền hoàn tất hoặc có kết quả từ hệ thống.

---

## Clarifications

### Session 2026-10-21
- Q: Khi hồ sơ học sinh chuyển sang trạng thái rà soát thủ công (`manual_review`), cơ chế nào sẽ mở lại quyền nộp ảnh? → A: Bắt buộc do Quản trị viên (Admin) xem xét và mở khóa lại trên trang quản trị; học sinh không được tự nộp lại khi đang ở trạng thái này.
- Q: Về ngưỡng dung lượng ảnh khi gửi lên hệ thống, giá trị chốt chặn kỹ thuật cuối cùng được chọn là bao nhiêu? → A: Dưới 1 MB là trần chặn cứng tiếp nhận kỹ thuật; phía máy khách duy trì mục tiêu nén Canvas < 800 KB theo Principle V.
- Q: Thời gian tối đa cho trạng thái chờ xử lý (`pending`) trước khi hệ thống xác định hết hạn phiên xử lý là bao lâu? → A: Quyết định cuối: Trạng thái `pending` KHÔNG HẾT HẠN. Do nhịp đồng bộ sang HANET Cloud được điều tiết ở mức 1 request/phút (cần khoảng ~20 giờ cho 1.200 em toàn trường), hồ sơ được lưu an toàn trong hàng đợi nền; người nộp được thông báo rõ và có thể quay lại cùng đường link bất kỳ lúc nào để theo dõi vị trí hàng đợi và kết quả.
- Q: Cơ chế giới hạn tần suất gửi yêu cầu (Rate Limit) đối với học sinh nên được tính toán dựa trên tiêu chí nào? → A: Tính theo từng mã học sinh (tối đa 3 lần nộp trong vòng 15 phút cho một học sinh) để tránh chặn nhầm nhiều người dùng chung mạng Wi-Fi/NAT; đi kèm quyền miễn trừ của giáo viên khi có mã lớp.
- Q: Trong giai đoạn onboarding ban đầu (1.200 học sinh), người nộp có bắt buộc phải nhập mã xác thực/mã dự phòng không? → A: Không cần mã xác thực ở đợt 1 (chỉ cần chọn tên trong danh sách lớp và xác nhận tên chuẩn tiếng Việt hợp lệ); sau khi hoàn tất 1.200 học sinh, hệ thống sẽ khóa toàn bộ liên kết công khai và kích hoạt mã xác thực chống spam cho các đợt cập nhật tiếp theo.

---

## II. User Scenarios & Testing *(mandatory)*

### User Story 1 - Học sinh tự nộp ảnh qua điện thoại (Priority: P1)

Học sinh hoặc phụ huynh truy cập vào liên kết đăng ký, chọn tên của mình trong danh sách lớp, chụp hoặc chọn ảnh khuôn mặt, xem trước và nộp thành công mà không làm nghẽn máy chủ.

**Why this priority**: Đây là luồng nghiệp vụ cốt lõi của chiến dịch onboarding 1.200 học sinh (MVP bắt buộc).

**Independent Test**: Có thể kiểm thử độc lập bằng cách dùng điện thoại truy cập, chọn một học sinh có trạng thái chưa đăng ký, tải lên ảnh chân dung và nhận được thông báo tiếp nhận thành công trong vòng 1,5 giây.

**Acceptance Scenarios**:

1. **Given** học sinh đang ở trạng thái chưa nộp ảnh (`empty`) hoặc nộp lỗi trước đó (`error`), lớp học chưa bị khóa và cổng đăng ký toàn trường đang mở.  
   **When** học sinh tải lên một ảnh chân dung hợp lệ và nhấn "Xác nhận & Nộp ảnh".  
   **Then** trình duyệt nén ảnh xuống dung lượng mục tiêu < 800 KB (chặn cứng < 1 MB), gửi lên máy chủ, nhận được phản hồi tiếp nhận thành công và trạng thái học sinh chuyển sang chờ xử lý (`pending`).
2. **Given** một học sinh đã được nộp ảnh thành công trước đó (`success`) hoặc đang trong hàng đợi chờ xử lý (`pending`).  
   **When** người dùng bấm vào tên học sinh này trên danh sách lớp.  
   **Then** giao diện hiển thị thông báo hồ sơ đã được tiếp nhận/hoàn tất và không cho phép nộp đè ảnh mới.

---

### User Story 2 - Giáo viên chủ nhiệm hỗ trợ chụp hàng loạt tại lớp (Priority: P2)

Giáo viên chủ nhiệm sử dụng mã xác thực của lớp mình để chụp ảnh liên tục cho từng học sinh trong lớp trong một buổi học mà không bị hệ thống chặn vì gửi yêu cầu dồn dập từ cùng một thiết bị/IP.

**Why this priority**: Trong thực tế chiến dịch, nhiều học sinh tiểu học hoặc trường hợp không có điện thoại thông minh sẽ được giáo viên chủ nhiệm chụp và nộp trực tiếp tại lớp.

**Independent Test**: Kích hoạt cơ chế xác thực giáo viên và gửi liên tục 30 ảnh cho 30 học sinh trong vòng 10 phút trên cùng 1 địa chỉ IP mà không gặp lỗi vượt hạn ngạch gửi yêu cầu.

**Acceptance Scenarios**:

1. **Given** giáo viên mở liên kết lớp kèm thông tin xác thực quyền giáo viên phụ trách hợp lệ.  
   **When** giáo viên chụp và nộp ảnh liên tục cho nhiều học sinh trong thời gian ngắn.  
   **Then** hệ thống nhận diện quyền giáo viên, miễn trừ cơ chế giới hạn tần suất thông thường và tiếp nhận tất cả các hồ sơ hợp lệ.
2. **Given** thông tin xác thực giáo viên không hợp lệ hoặc thiếu.  
   **When** cùng một thiết bị/IP gửi quá tần suất cho phép (vượt quá 5 yêu cầu trong 5 phút).  
   **Then** hệ thống từ chối yêu cầu tiếp theo và yêu cầu người dùng chờ trước khi thử lại.

---

### User Story 3 - Theo dõi tiến trình đồng bộ & vị trí hàng đợi (Priority: P2)

Sau khi nộp ảnh, học sinh có thể theo dõi trực tiếp vị trí của mình trong hàng đợi qua cơ chế thăm dò (short polling 3 giây), hoặc yên tâm đóng trình duyệt và quay lại sau bằng chính đường liên kết đó mà không sợ bị hủy phiên (`pending` không hết hạn).

**Why this priority**: Tạo sự an tâm cho người dùng, minh bạch thời gian đồng bộ nền (~20 giờ toàn trường với nhịp 1 req/phút), loại bỏ thao tác tải lại trang (F5) liên tục gây tải cho máy chủ.

**Independent Test**: Nộp một ảnh, quan sát giao diện hiển thị thông báo đã tiếp nhận vào hàng đợi, vị trí hàng đợi, chu kỳ thăm dò 3 giây; tắt trình duyệt và mở lại bằng cùng liên kết sau vài giờ để xác nhận trạng thái vẫn được duy trì an toàn.

**Acceptance Scenarios**:

1. **Given** học sinh vừa nộp ảnh thành công và đang ở trạng thái chờ xử lý (`pending`).  
   **When** người dùng giữ nguyên màn hình xác nhận hoặc mở lại liên kết sau đó.  
   **Then** giao diện hiển thị rõ thông báo ảnh đã được xếp vào hàng đợi nền (nhịp đồng bộ 1 request/phút, ước tính toàn trường ~20 giờ), hiển thị vị trí số thứ tự còn lại trong hàng đợi và tự động thăm dò (Short Polling) định kỳ mỗi 3 giây nếu màn hình đang mở.
2. **Given** tác vụ xử lý ngầm đã hoàn thành đồng bộ với đám mây.  
   **When** lần thăm dò kế tiếp nhận được trạng thái hoàn tất (`success`).  
   **Then** giao diện dừng thăm dò và chuyển sang màn hình thông báo hoàn thành đăng ký thành công.
3. **Given** tác vụ ở trạng thái `pending` kéo dài qua nhiều giờ trong hàng đợi nền.  
   **When** người dùng truy cập lại liên kết đăng ký ban đầu.  
   **Then** hệ thống vẫn duy trì trạng thái `pending` an toàn, hiển thị vị trí hàng đợi đã được cập nhật giảm dần, không tự động hết hạn phiên hay hủy hồ sơ.

---

### User Story 4 - Chặn xung đột nộp trùng (Race Condition) (Priority: P1)

Ngăn chặn triệt để tình trạng hai người cùng gửi ảnh cho một học sinh tại một thời điểm hoặc người dùng nhấn nút nộp nhiều lần liên tiếp.

**Why this priority**: Bảo toàn tính toàn vẹn dữ liệu, tránh tạo nhiều tác vụ trùng lặp trong hàng đợi và tiêu hao dung lượng xử lý của Worker.

**Independent Test**: Gửi hai yêu cầu nộp ảnh đồng thời cho cùng một mã định danh học sinh; chỉ một yêu cầu được chấp nhận, yêu cầu thứ hai bị từ chối với trạng thái xung đột.

**Acceptance Scenarios**:

1. **Given** học sinh A đang ở trạng thái chưa nộp ảnh (`empty`).  
   **When** có hai yêu cầu nộp ảnh gửi lên đồng thời cho học sinh A.  
   **Then** chỉ yêu cầu đầu tiên được chuyển sang trạng thái `pending` và tiếp nhận; yêu cầu thứ hai bị từ chối với thông báo hồ sơ đang được xử lý.

---

### Edge Cases

- **Chốt chặn khẩn cấp toàn trường (Emergency Kill-Switch)**: Khi quản trị viên tắt tiếp nhận toàn hệ thống, mọi giao diện đăng ký lập tức khóa và hiển thị thông báo bảo trì, từ chối mọi yêu cầu gửi ảnh mới.
- **Lớp học đã khóa**: Khi giáo viên hoặc quản trị viên đã khóa lớp (`is_locked = true`), học sinh thuộc lớp đó chỉ có thể xem danh sách trạng thái, không thể nộp ảnh mới.
- **Hồ sơ cần rà soát thủ công (`manual_review`)**: Khi hồ sơ bị lỗi kỹ thuật nhiều lần và chuyển sang rà soát thủ công, học sinh không được tự nộp lại. Bắt buộc Quản trị viên (Admin) phải xem xét trên trang quản trị và chủ động mở khóa (chuyển về trạng thái cho phép nộp) thì học sinh mới có thể tiếp tục.
- **Mất kết nối mạng khi đang gửi ảnh**: Giao diện giữ nguyên ảnh đã nén trong bộ nhớ tạm của trình duyệt, hiển thị thông báo mất kết nối và nút "Thử lại", không bắt người dùng chụp lại.

---

## III. Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (Client Compression)**: Trình duyệt máy khách **PHẢI** tự động tiền xử lý và nén ảnh (bằng Canvas API) về cạnh dài tối đa 1920px với chất lượng JPEG 0.85, đảm bảo dung lượng gửi đi đạt **mục tiêu < 800 KB** (theo Principle V) và **ngưỡng chặn kỹ thuật tối đa tuyệt đối là < 1 MB**.
- **FR-002 (Payload Guard)**: Cổng tiếp nhận (Reverse Proxy) **PHẢI** từ chối bất kỳ gói tin tải lên nào có kích thước vượt quá trần kỹ thuật cho phép (5 MB).
- **FR-003 (Asynchronous Receipt)**: Máy chủ API **PHẢI** phản hồi kết quả tiếp nhận hồ sơ bất đồng bộ (trạng thái `pending`) trong thời gian **dưới 1.500 ms**, không bắt máy khách chờ quá trình xử lý ảnh và đồng bộ đám mây.
- **FR-004 (Atomic Conditional State Transition & Role Separation)**: Cổng đăng ký công khai của học sinh/phụ huynh **CHỈ ĐƯỢC PHÉP TIẾP NHẬN** nộp ảnh khi hồ sơ học sinh đang ở trạng thái chưa nộp (`empty`) hoặc nộp lỗi trước đó (`error`). Việc chuyển trạng thái từ rà soát thủ công (`manual_review`) để cho phép học sinh nộp lại **BẮT BUỘC LÀ HÀNH ĐỘNG CỦA QUẢN TRỊ VIÊN (ADMIN)** trên giao diện quản trị (Admin can thiệp chuyển về `empty` hoặc `error`). Hệ thống **PHẢI** áp dụng cơ chế cập nhật trạng thái có điều kiện nguyên tử (Atomic Conditional Update), từ chối ngay với mã lỗi xung đột (Conflict) nếu học sinh đang ở trạng thái `pending`, `success` hoặc `manual_review` khi nộp qua cổng công khai.
- **FR-005 (Short Polling Interval)**: Giao diện học sinh **PHẢI** sử dụng cơ chế thăm dò định kỳ ngắn (Short Polling) với chu kỳ cố định **3 giây/lần** (theo Principle V) để cập nhật tiến độ khi người dùng mở trang, không sử dụng kết nối liên tục WebSockets nhằm tiết kiệm bộ nhớ máy chủ.
- **FR-006 (Queue Position Feedback)**: Trong các phản hồi thăm dò khi hồ sơ còn ở trạng thái `pending`, hệ thống **PHẢI** cung cấp thông tin số thứ tự vị trí còn lại trong hàng đợi để hiển thị minh bạch cho người dùng.
- **FR-007 (Paced Background Sync & Non-expiring Pending)**: Hệ thống **PHẢI** điều tiết nhịp đồng bộ ảnh sang HANET Cloud theo tham số cấu hình hệ thống (mặc định: **1 request/phút**, tương ứng quy mô 1.200 học sinh toàn trường cần khoảng **~20 giờ** xử lý nền). Trạng thái chờ xử lý (`pending`) **KHÔNG HẾT HẠN**, duy trì liên tục và cho phép người dùng tra cứu lại kết quả bất kỳ lúc nào bằng cùng đường liên kết; thông báo tiếp nhận sau khi nộp và màn hình trạng thái **PHẢI** thể hiện rõ thời gian xử lý nền và vị trí hàng đợi tương ứng.
- **FR-008 (Rate Limiting & Teacher Authorization)**: Hệ thống **PHẢI** áp dụng cơ chế giới hạn tần suất gửi yêu cầu theo từng mã học sinh (tối đa 3 lần nộp trong 15 phút cho một học sinh) để chống nộp dồn dập mà không làm gián đoạn các học sinh khác dùng chung địa chỉ mạng. Đồng thời, hệ thống **PHẢI** hỗ trợ cơ chế xác thực quyền giáo viên phụ trách lớp (thông qua mã định danh bảo mật của lớp) để **miễn trừ toàn bộ giới hạn tần suất**, hỗ trợ giáo viên chụp ảnh và nộp liên tục cho cả lớp.
- **FR-009 (Emergency Safeguards & Locks)**: Hệ thống **PHẢI** từ chối tiếp nhận đăng ký khi chốt chặn khẩn cấp toàn trường bị ngắt hoặc khi lớp học tương ứng bị gắn cờ đã khóa.
- **FR-010 (Identity Selection & Lifecycle Phase Transition)**: Trong chiến dịch onboarding ban đầu (1.200 học sinh), hệ thống **KHÔNG BẮT BUỘC** người nộp phải nhập mã xác thực/mã dự phòng, cho phép chọn tên trong danh sách lớp kèm cơ chế kiểm tra tính hợp lệ của họ tên theo chuẩn định dạng tên tiếng Việt (tránh nhập chuỗi ký tự vô nghĩa). Sau khi hoàn tất chỉ tiêu chiến dịch, hệ thống **PHẢI** hỗ trợ cơ chế khóa toàn bộ các liên kết đăng ký công khai và bắt buộc xác thực qua mã dự phòng cho bất kỳ đợt cập nhật hoặc bổ sung nào sau đó để chống spam.
- **FR-011 (Infrastructure IP Ceiling Rate Guard - Write Endpoints Only)**: Tầng hạ tầng (Reverse Proxy/Middleware) **PHẢI** áp dụng trần giới hạn tần suất theo địa chỉ IP ở mức **60 request/phút/IP**, và trần này **CHỈ ÁP DỤNG CHO CÁC ENDPOINT GHI (WRITE)** bao gồm: nộp ảnh chân dung (`POST /api/students/:id/photo`) và xác thực mã PIN giáo viên. Toàn bộ các endpoint đọc (**READ**) bao gồm: thăm dò trạng thái (`GET /api/students/:id/status` với chu kỳ polling 3 giây/lần = 20 request/phút/học sinh), danh sách lớp học và danh sách học sinh **TUYỆT ĐỐI KHÔNG TÍNH VÀO TRẦN NÀY**, nhằm đảm bảo kịch bản 30–40 học sinh trong cùng một lớp học (dùng chung một địa chỉ IP/NAT/Wi-Fi trường học) vừa nộp ảnh vừa duy trì thăm dò trạng thái mà không bao giờ bị nghẽn hay chặn nhầm.

---

### Key Entities

- **Class (Lớp học)**: Đại diện cho đơn vị lớp học của học sinh.
  - *Thuộc tính chính*: Mã lớp, tên lớp, khối học, trạng thái khóa tiếp nhận (`is_locked`), mã bảo mật phân quyền giáo viên phụ trách.
- **Student (Học sinh)**: Đại diện cho cá nhân người học cần thu nhận khuôn mặt.
  - *Thuộc tính chính*: Mã định danh duy nhất chuẩn hóa (định dạng 9 ký tự bất biến `alias_id`), họ tên, lớp liên kết, trạng thái hồ sơ (`empty`, `pending`, `success`, `error`, `manual_review`), mã định danh khuôn mặt trên hệ thống đám mây (`person_id`), liên kết ảnh chân dung sau chuẩn hóa.
- **SystemSetting (Cấu hình hệ thống)**: Tham số điều khiển toàn cục.
  - *Thuộc tính chính*: Khóa cấu hình, cờ kích hoạt đăng ký toàn trường (`registration_enabled`), tham số điều tiết nhịp đồng bộ đám mây (`hanet_sync_rate_limit`, mặc định: 1 request/phút).
- **ActivityLog (Nhật ký hoạt động)**: Lưu vết phục vụ giám sát và kiểm tra.
  - *Thuộc tính chính*: Mã học sinh liên quan, loại hành động (nộp ảnh, đổi trạng thái, miễn trừ hạn ngạch), thời điểm thực hiện, nguồn gốc yêu cầu.

---

## IV. Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Tốc độ phản hồi)**: 95% yêu cầu nộp ảnh nhận được biên nhận tiếp nhận thành công (`pending`) trong thời gian **dưới 1.500 ms**.
- **SC-002 (Bảo toàn kích thước nén)**: 100% ảnh gửi lên từ máy khách có dung lượng **dưới 1 MB**, trong đó ít nhất 90% đạt **mục tiêu < 800 KB**.
- **SC-003 (Độ tin cậy chống xung đột)**: Tỷ lệ xảy ra lỗi dữ liệu trùng lặp hoặc nhiều tác vụ song song cho cùng 1 học sinh là **0%** nhờ cơ chế khóa trạng thái nguyên tử.
- **SC-004 (Chu kỳ thăm dò & Duy trì trạng thái nền)**: Giao diện thực hiện thăm dò đúng nhịp độ **3 giây/lần** khi người dùng mở trang, phản ánh chính xác vị trí hàng đợi và duy trì trạng thái `pending` an toàn không giới hạn thời gian cho đến khi Worker hoàn tất đồng bộ với nhịp độ 1 request/phút.
- **SC-005 (Hoàn thành chỉ tiêu onboarding)**: Hệ thống hỗ trợ hoàn tất thu nhận ảnh thành công cho toàn bộ **1.200 học sinh** trong chiến dịch cao điểm mà không gây sự cố quá tải bộ nhớ trên máy chủ 3GB RAM.

---

## V. Assumptions

- Học sinh hoặc phụ huynh sử dụng thiết bị di động hoặc máy tính có trình duyệt hiện đại hỗ trợ HTML5 Canvas và Camera API / File Upload API.
- Giáo viên chủ nhiệm được nhà trường phổ biến trước mã định danh bảo mật của lớp để thực hiện chụp ảnh tập trung cho học sinh khi cần.
- Quá trình phân tích nhận diện khuôn mặt chuyên sâu và đồng bộ sang thiết bị điểm danh do hệ thống đám mây đối tác xử lý thông qua hàng đợi tuần tự ngầm.
