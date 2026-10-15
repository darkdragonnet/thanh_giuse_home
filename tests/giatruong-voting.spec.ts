import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8090';
const ADMIN_TOKEN = 'admin_secret_giatruong_2026';

describe('Hệ Thống Bỏ Phiếu Ban Đại Diện Gia Trưởng (End-to-End Suite)', () => {
  let candidates: Array<{ id: number; name: string; is_incumbent: boolean }> = [];
  let trialSessionId: string = '';
  let realSessionId: string = '';
  const testPhone = '0988776655';

  before(async () => {
    // Đảm bảo cổng có thể cấu hình được
    const configRes = await fetch(`${BASE_URL}/giatruong/api/config`);
    assert.equal(configRes.status, 200);
  });

  it('1. GET /config trả về cấu hình hệ thống và server_time', async () => {
    const res = await fetch(`${BASE_URL}/giatruong/api/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.voting_status);
    assert.equal(typeof data.real_duration_minutes, 'number');
    assert.equal(typeof data.trial_duration_minutes, 'number');
    assert.ok(data.server_time);
  });

  it('2. GET /candidates trả về danh sách 10 ứng viên ban đầu', async () => {
    const res = await fetch(`${BASE_URL}/giatruong/api/candidates`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.data));
    assert.ok(data.data.length >= 10);
    candidates = data.data;
  });

  it('3. Chặn tạo phiên khi cổng đóng (voting_status = closed)', async () => {
    // Đặt cổng đóng
    await fetch(`${BASE_URL}/giatruong/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ voting_status: 'closed' }),
    });

    const res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voter_name: 'Nguyễn Văn Test',
        voter_phone: testPhone,
        is_trial: true,
      }),
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.success, false);
  });

  it('4. Admin chuyển trạng thái sang trial_only và tạo phiên Bầu Thử thành công', async () => {
    const setRes = await fetch(`${BASE_URL}/giatruong/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ voting_status: 'trial_only' }),
    });
    assert.equal(setRes.status, 200);

    const res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voter_name: 'Giuse Thử Nghiệm',
        voter_phone: testPhone,
        is_trial: true,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.session_id);
    assert.equal(data.duration_seconds, 240); // 4 phút
    trialSessionId = data.session_id;
  });

  it('5. Khôi phục phiên dở dang qua GET /session/active khi mất localStorage', async () => {
    const res = await fetch(`${BASE_URL}/giatruong/api/session/active?phone=${testPhone}&is_trial=true`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.active, true);
    assert.equal(data.session_id, trialSessionId);
  });

  it('6. Nộp phiếu Bầu Thử hợp lệ kèm 1 ứng viên mới On-the-fly', async () => {
    const picks = [
      { id: candidates[0].id },
      { id: candidates[1].id },
      { id: candidates[2].id },
      { id: candidates[3].id },
      { id: candidates[4].id },
      { id: candidates[5].id },
      { id: candidates[6].id },
      { name: 'Giuse Ứng Viên Mới Tự Nhập', isNew: true },
    ];

    const res = await fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: trialSessionId,
        selected_candidates: picks,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.is_trial, true);
  });

  it('7. Chống Double-Submit: Gửi lại cùng session_id bị từ chối với 409', async () => {
    const picks = candidates.slice(0, 8).map((c) => ({ id: c.id }));
    const res = await fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: trialSessionId,
        selected_candidates: picks,
      }),
    });
    assert.equal(res.status, 409);
  });

  it('8. Chống Race Condition khi 2 cử tri cùng thêm 1 ứng viên mới (Upsert an toàn)', async () => {
    // Tạo 2 session thử mới
    const s1Res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_name: 'Cử tri 1', voter_phone: '0911000111', is_trial: true }),
    });
    const s1 = await s1Res.json();

    const s2Res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_name: 'Cử tri 2', voter_phone: '0911000222', is_trial: true }),
    });
    const s2 = await s2Res.json();

    const sameCandidate = { name: 'Phaolô Trùng Tên Cùng Giây', isNew: true };
    const makePicks = (cand: any) => [
      { id: candidates[0].id },
      { id: candidates[1].id },
      { id: candidates[2].id },
      { id: candidates[3].id },
      { id: candidates[4].id },
      { id: candidates[5].id },
      { id: candidates[6].id },
      cand,
    ];

    // Gửi đồng thời cùng lúc 2 request nộp phiếu
    const [r1, r2] = await Promise.all([
      fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: s1.session_id, selected_candidates: makePicks(sameCandidate) }),
      }),
      fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: s2.session_id, selected_candidates: makePicks(sameCandidate) }),
      }),
    ]);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  });

  it('9. Chuyển sang real_only: Bầu thật thành công và chặn trùng SĐT', async () => {
    await fetch(`${BASE_URL}/giatruong/api/admin/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ voting_status: 'real_only' }),
    });

    const realPhone = '093' + Math.floor(1000000 + Math.random() * 9000000);

    // Bắt đầu phiên bầu thật
    const startRes = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_name: 'Cử Tri Chính Thức', voter_phone: realPhone, is_trial: false }),
    });
    assert.equal(startRes.status, 200);
    const startData = await startRes.json();
    assert.ok(startData.duration_seconds <= 480 && startData.duration_seconds > 0);
    realSessionId = startData.session_id;

    // Nộp phiếu thật
    const picks = candidates.slice(0, 8).map((c) => ({ id: c.id }));
    const submitRes = await fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: realSessionId, selected_candidates: picks }),
    });
    assert.equal(submitRes.status, 200);
    const submitData = await submitRes.json();
    assert.equal(submitData.is_trial, false);

    // Cố tình bắt đầu bầu thật lần 2 với cùng SĐT -> Bị chặn 409
    const secondStartRes = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_name: 'Cử Tri Lần 2', voter_phone: realPhone, is_trial: false }),
    });
    assert.equal(secondStartRes.status, 409);
    const secondData = await secondStartRes.json();
    assert.match(secondData.message, /đã hoàn thành lượt bầu/);
  });

  it('10. Kiểm tra kết quả Real-time Leaderboard & Reset Bầu Thử', async () => {
    // Xem kết quả Admin
    const res = await fetch(`${BASE_URL}/giatruong/api/admin/results`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.total_real_votes >= 1);
    assert.ok(data.total_trial_votes >= 1);
    assert.ok(Array.isArray(data.real_ranking));
    assert.ok(Array.isArray(data.trial_ranking));

    // Reset lượt bầu thử
    const resetRes = await fetch(`${BASE_URL}/giatruong/api/admin/reset-trial`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    assert.equal(resetRes.status, 200);

    // Kiểm tra lại: tổng số phiếu thử phải về 0, phiếu thật giữ nguyên
    const verifyRes = await fetch(`${BASE_URL}/giatruong/api/admin/results`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.total_trial_votes, 0);
    assert.ok(verifyData.total_real_votes >= 1);
  });

  it('11. Unified Identity Key: Chỉ nhập Tên (không có SĐT) bắt đầu phiên thành công', async () => {
    const res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voter_name: 'Antôn Cử Tri Không Điện Thoại',
        is_trial: false,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.session_id);
  });

  it('12. Unified Identity Key: Chỉ nhập SĐT (không có Tên) bắt đầu phiên thành công', async () => {
    const res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voter_phone: '0977889900',
        is_trial: false,
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.session_id);
  });

  it('13. POST /draft-pick: Đồng bộ lượt chọn nháp vào Redis ZSET và snapshot TTL', async () => {
    const nameVoter = 'Phêrô Đồng Bộ Nháp';
    const startRes = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_name: nameVoter, is_trial: false }),
    });
    const { session_id } = await startRes.json();

    // Gửi draft picks gồm 3 ứng viên có sẵn + 1 ứng viên mới tự nhập
    const draftRes = await fetch(`${BASE_URL}/giatruong/api/draft-pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session_id,
        candidate_ids: [candidates[0].id, candidates[1].id, candidates[2].id, 'Ông Hàng Xóm Tự Gõ'],
      }),
    });
    assert.equal(draftRes.status, 200);
    const draftData = await draftRes.json();
    assert.equal(draftData.success, true);

    // Khôi phục qua session/active kèm draft_candidates
    const activeRes = await fetch(`${BASE_URL}/giatruong/api/session/active?name=${encodeURIComponent(nameVoter)}&is_trial=false`);
    const activeData = await activeRes.json();
    assert.equal(activeData.success, true);
    assert.equal(activeData.active, true);
    assert.ok(Array.isArray(activeData.draft_candidates));
    assert.equal(activeData.draft_candidates.length, 4);
  });

  it('14. GET /live-status: Trực tiếp tiến độ non-blocking & Secret Ballot ẩn danh nhân tố mới', async () => {
    const res = await fetch(`${BASE_URL}/giatruong/api/live-status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(typeof data.active_drafting_count === 'number');
    assert.ok(data.active_drafting_count >= 1);
    assert.ok(typeof data.total_submitted_votes === 'number');
    assert.ok(typeof data.custom_candidates_draft_count === 'number');
    // Secret Ballot: Ứng viên tự gõ được gom vào custom_candidates_draft_count
    assert.ok(data.custom_candidates_draft_count >= 1);
    assert.ok(Array.isArray(data.top_estimated));
    assert.ok(data.top_estimated.length <= 10);
    // Tuyệt đối không để lộ tên 'Ông Hàng Xóm Tự Gõ' trong danh sách ứng viên công khai
    const leaked = data.top_estimated.some((c: any) => c.name === 'Ông Hàng Xóm Tự Gõ');
    assert.equal(leaked, false, 'Vi phạm Secret Ballot: Lộ tên ứng viên tự gõ khi chưa chốt sổ!');
  });

  it('15. Chống đếm trùng: Submit phiếu thành công sẽ dọn dẹp Redis draft và active count', async () => {
    // Tạo session mới để test dọn dẹp
    const voterPhone = '094' + Math.floor(1000000 + Math.random() * 9000000);
    const startRes = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_phone: voterPhone, is_trial: false }),
    });
    const { session_id } = await startRes.json();

    // Gửi draft
    await fetch(`${BASE_URL}/giatruong/api/draft-pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session_id,
        candidate_ids: candidates.slice(0, 8).map((c) => c.id),
      }),
    });

    const statusBefore = await (await fetch(`${BASE_URL}/giatruong/api/live-status`)).json();
    const countBefore = statusBefore.active_drafting_count;

    // Nộp phiếu chính thức
    const picks = candidates.slice(0, 8).map((c) => ({ id: c.id }));
    const submitRes = await fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session_id, selected_candidates: picks }),
    });
    assert.equal(submitRes.status, 200);

    // Kiểm tra lại live-status: session đã được dọn khỏi ZSET
    const statusAfter = await (await fetch(`${BASE_URL}/giatruong/api/live-status`)).json();
    assert.equal(statusAfter.active_drafting_count, countBefore - 1);
  });

  it('16. Milestone & Top 10 Broadcast: live-status trả về tối đa 10 ứng viên dẫn đầu', async () => {
    const liveRes = await fetch(`${BASE_URL}/giatruong/api/live-status?limit=10`);
    const liveData = await liveRes.json();
    assert.equal(liveRes.status, 200);
    assert.equal(liveData.success, true);
    assert.ok(liveData.top_estimated.length <= 10);
    assert.ok(typeof liveData.total_submitted_votes === 'number');
  });

  it('17. Admin ấn định giờ bắt đầu: Chặn cử tri vào bầu và giữ ở phòng chờ', async () => {
    // Admin lên lịch hẹn sau 3 phút
    const schedRes = await fetch(`${BASE_URL}/giatruong/api/admin/schedule-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ delay_minutes: 3, notes: 'Hẹn giờ test 17' }),
    });
    assert.equal(schedRes.status, 200);
    const schedData = await schedRes.json();
    assert.equal(schedData.success, true);
    assert.equal(schedData.round.status, 'scheduled');

    // GET /config hiển thị round status = scheduled và còn thời gian đếm ngược
    const configRes = await fetch(`${BASE_URL}/giatruong/api/config`);
    const cfg = await configRes.json();
    assert.equal(cfg.success, true);
    assert.equal(cfg.voting_status, 'real_only');
    assert.equal(cfg.current_round.status, 'scheduled');
    assert.ok(cfg.current_round.remaining_seconds_to_start > 0);

    // Cử tri cố gắng start session trước giờ G bị từ chối 403
    const startRes = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_phone: '0933112233', is_trial: false }),
    });
    assert.equal(startRes.status, 403);
    const startData = await startRes.json();
    assert.equal(startData.success, false);
    assert.match(startData.message, /chưa bắt đầu|phòng chờ/);
  });

  it('18. Admin Reschedule: Hoãn giờ (+2 phút) và Kích hoạt ngay (start_now)', async () => {
    // Hoãn thêm 2 phút
    const delayRes = await fetch(`${BASE_URL}/giatruong/api/admin/reschedule-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ action: 'delay', add_minutes: 2 }),
    });
    assert.equal(delayRes.status, 200);

    // Kích hoạt ngay lập tức
    const startNowRes = await fetch(`${BASE_URL}/giatruong/api/admin/reschedule-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ action: 'start_now' }),
    });
    assert.equal(startNowRes.status, 200);
    const startNowData = await startNowRes.json();
    assert.equal(startNowData.success, true);
    assert.equal(startNowData.round.status, 'in_progress');

    // Kiểm tra config đã chuyển sang in_progress
    const cfg = await (await fetch(`${BASE_URL}/giatruong/api/config`)).json();
    assert.equal(cfg.current_round.status, 'in_progress');
    assert.ok(cfg.current_round.remaining_seconds_to_end > 0);
  });

  it('19. Synchronized Window: Cử tri vào trễ nhận đúng thời gian còn lại của đợt bầu', async () => {
    const lateVoterPhone = '0922445566';
    const res = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_name: 'Cử Tri Vào Trễ', voter_phone: lateVoterPhone, is_trial: false }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    // duration_seconds phải bằng remaining_seconds của round hiện tại (<= 480)
    assert.ok(data.duration_seconds <= 480);
    assert.ok(data.duration_seconds > 0);

    // Nộp phiếu cử tri vào trễ
    const picks = candidates.slice(0, 8).map((c) => ({ id: c.id }));
    const submitRes = await fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: data.session_id, selected_candidates: picks }),
    });
    assert.equal(submitRes.status, 200);
  });

  it('20. Khởi Động Đợt Mới (New Round): Reset phiếu về 0 & Cử tri đợt 1 được bầu lại ở đợt 2', async () => {
    // Lấy số phiếu đợt hiện tại (ít nhất có 1 phiếu từ test 19)
    const prevRes = await (await fetch(`${BASE_URL}/giatruong/api/admin/results?token=${ADMIN_TOKEN}`)).json();
    assert.ok(prevRes.total_real_votes >= 1);

    // Admin tạo Đợt Bầu Cử Mới
    const newRoundRes = await fetch(`${BASE_URL}/giatruong/api/admin/new-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        title: 'Bầu Cử Ban Điều Hành - Đợt Mới Test 20',
        duration_minutes: 8,
        delay_minutes: 0, // Bắt đầu ngay
        notes: 'Reset phiếu về 0 để kiểm tra đợt mới',
      }),
    });
    assert.equal(newRoundRes.status, 200);
    const newRoundData = await newRoundRes.json();
    assert.equal(newRoundData.success, true);
    assert.ok(newRoundData.round.round_number >= 2);
    assert.equal(newRoundData.round.status, 'in_progress');

    // Sau khi mở Đợt mới, kết quả real_votes phải RESET VỀ 0
    const resetRes = await (await fetch(`${BASE_URL}/giatruong/api/admin/results?token=${ADMIN_TOKEN}`)).json();
    assert.equal(resetRes.total_real_votes, 0);

    // Cử tri đợt 1 (0922445566 từ test 19) ĐƯỢC PHÉP tham gia bầu ở Đợt 2!
    const reVoteStart = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_phone: '0922445566', is_trial: false }),
    });
    assert.equal(reVoteStart.status, 200);
    const reVoteData = await reVoteStart.json();
    assert.equal(reVoteData.success, true);
    assert.ok(reVoteData.session_id);

    // Nộp phiếu thành công ở Đợt 2
    const picks = candidates.slice(0, 8).map((c) => ({ id: c.id }));
    const submitReVote = await fetch(`${BASE_URL}/giatruong/api/submit-vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: reVoteData.session_id, selected_candidates: picks }),
    });
    assert.equal(submitReVote.status, 200);

    // Kết quả Đợt 2 giờ là 1 phiếu
    const afterReVote = await (await fetch(`${BASE_URL}/giatruong/api/admin/results?token=${ADMIN_TOKEN}`)).json();
    assert.equal(afterReVote.total_real_votes, 1);
  });

  it('21. Per-Round Idempotency: Trong cùng Đợt 2, cử tri không được nộp lần 2 (1 người 1 phiếu)', async () => {
    // Cố gắng tạo session lần nữa bằng cùng SĐT trong Đợt 2
    const dupRes = await fetch(`${BASE_URL}/giatruong/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter_phone: '0922445566', is_trial: false }),
    });
    assert.equal(dupRes.status, 409);
    const dupData = await dupRes.json();
    assert.equal(dupData.success, false);
    assert.match(dupData.message, /đã hoàn thành lượt bầu|1 người 1 phiếu/);
  });

  it('22. Election Rounds History: Tra cứu toàn bộ các đợt và xem bảng điểm đợt cũ', async () => {
    // Lấy danh sách rounds
    const roundsRes = await fetch(`${BASE_URL}/giatruong/api/admin/rounds`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    assert.equal(roundsRes.status, 200);
    const roundsData = await roundsRes.json();
    assert.equal(roundsData.success, true);
    assert.ok(Array.isArray(roundsData.rounds));
    assert.ok(roundsData.rounds.length >= 2);

    // Lấy kết quả chi tiết của đợt 1
    const round1 = roundsData.rounds.find((r: any) => r.round_number === 1);
    assert.ok(round1);

    const r1ResultRes = await fetch(`${BASE_URL}/giatruong/api/admin/rounds/${round1.id}/results`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    assert.equal(r1ResultRes.status, 200);
    const r1Result = await r1ResultRes.json();
    assert.equal(r1Result.success, true);
    assert.equal(r1Result.round.round_number, 1);
    assert.ok(typeof r1Result.total_votes === 'number');
    assert.ok(Array.isArray(r1Result.ranking));
  });
});
