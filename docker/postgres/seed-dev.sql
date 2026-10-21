-- ==============================================================================
-- DỮ LIỆU SEED MẪU DÀNH RIÊNG CHO MÔI TRƯỜNG PHÁT TRIỂN / DEV TESTING
-- CẢNH BÁO: TUYỆT ĐỐI KHÔNG CHẠY FILE NÀY LÊN DATABASE SẢN XUẤT (PRODUCTION)
-- ==============================================================================

-- Khởi tạo 2 Lớp học mẫu
INSERT INTO classes (code, name, teacher_name, token, is_locked) VALUES
    ('10A1', 'Lớp 10A1 - Chuyên Toán', 'Thầy Nguyễn Văn An', 'PIN_10A1_SECRET_789', FALSE),
    ('10A2', 'Lớp 10A2 - Chuyên Lý', 'Cô Trần Thị Bình', 'PIN_10A2_SECRET_456', FALSE)
ON CONFLICT (code) DO NOTHING;

-- Khởi tạo 5 Học sinh mẫu (Trạng thái ban đầu: 'empty')
INSERT INTO students (class_id, name, qr_token, alias_id, status) VALUES
    (1, 'Nguyễn Hoàng Long', 'qr_10a1_001_a7b2', 'STU_10A1_001_A7B2C', 'empty'),
    (1, 'Trần Minh Quân', 'qr_10a1_002_d4e5', 'STU_10A1_002_D4E5F', 'empty'),
    (1, 'Lê Thị Thu Thảo', 'qr_10a1_003_g8h9', 'STU_10A1_003_G8H9J', 'empty'),
    (2, 'Phạm Đức Trọng', 'qr_10a2_001_k1l2', 'STU_10A2_001_K1L2M', 'empty'),
    (2, 'Vũ Mai Phương', 'qr_10a2_002_n3p4', 'STU_10A2_002_N3P4Q', 'empty')
ON CONFLICT (qr_token) DO NOTHING;

SELECT setval('classes_id_seq', COALESCE((SELECT MAX(id) FROM classes), 1));
SELECT setval('students_id_seq', COALESCE((SELECT MAX(id) FROM students), 1));
