import { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

export function removeVietnameseTones(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function computeIdentityKey(voter_name?: string, voter_phone?: string): {
  cleanName: string;
  cleanPhone: string;
  identityKey: string;
  voterNameForDb: string;
  voterPhoneForDb: string;
  isValid: boolean;
} {
  const rawName = (voter_name || '').trim();
  const rawPhone = (voter_phone || '').trim().replace(/\D/g, '');
  const cleanName = removeVietnameseTones(rawName);
  const cleanPhone = rawPhone;

  const hasValidName = rawName.length >= 2;
  const hasValidPhone = cleanPhone.length >= 9 && cleanPhone.length <= 12;

  if (!hasValidName && !hasValidPhone) {
    return { cleanName, cleanPhone, identityKey: '', voterNameForDb: '', voterPhoneForDb: '', isValid: false };
  }

  // Khóa định danh ưu tiên SĐT nếu có, hoặc dùng Name nếu không nhập SĐT
  const identityKey = hasValidPhone ? `phone:${cleanPhone}` : `name:${cleanName}`;
  const voterNameForDb = hasValidName ? rawName : `Cử tri ${cleanPhone}`;
  const voterPhoneForDb = hasValidPhone ? cleanPhone : `name:${cleanName}`;

  return {
    cleanName,
    cleanPhone,
    identityKey,
    voterNameForDb,
    voterPhoneForDb,
    isValid: true,
  };
}

export const giatruongRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = fastify.pg as Pool;
  const redis = (fastify as any).redis as Redis | undefined;

  // =========================================================================
  // 1. GET /config: Lấy cấu hình trạng thái 1 nút & thời gian đếm ngược
  // =========================================================================
  fastify.get('/config', async (_request, reply) => {
    try {
      const res = await pool.query('SELECT key, value FROM giatruong.settings');
      const cfg: Record<string, string> = {};
      res.rows.forEach((r) => {
        cfg[r.key] = r.value;
      });

      return reply.send({
        success: true,
        voting_status: cfg.voting_status || 'closed', // 'trial_only' | 'real_only' | 'closed'
        real_duration_minutes: parseInt(cfg.real_duration_minutes || '8', 10),
        trial_duration_minutes: parseInt(cfg.trial_duration_minutes || '4', 10),
        max_picks: parseInt(cfg.max_picks || '8', 10),
        server_time: new Date().toISOString(),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /config ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 2. GET /candidates: Lấy danh sách ứng viên hợp lệ
  // =========================================================================
  fastify.get('/candidates', async (_request, reply) => {
    try {
      const res = await pool.query(
        'SELECT id, name, clean_name, is_incumbent, display_order FROM giatruong.candidates WHERE is_active = TRUE ORDER BY display_order ASC NULLS LAST, is_incumbent DESC, id ASC'
      );
      return reply.send({
        success: true,
        data: res.rows,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /candidates ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 3. POST /session/start: Bắt đầu phiên bỏ phiếu (Unified Identity Key)
  // =========================================================================
  fastify.post<{
    Body: {
      voter_name?: string;
      voter_phone?: string;
      is_trial: boolean;
    };
  }>('/session/start', async (request, reply) => {
    try {
      const { voter_name, voter_phone, is_trial } = request.body || {};

      const identity = computeIdentityKey(voter_name, voter_phone);
      if (!identity.isValid) {
        return reply.status(400).send({
          success: false,
          message: 'Vui lòng nhập Họ và tên (tối thiểu 2 ký tự) HOẶC Số điện thoại (9-12 chữ số) hợp lệ.',
        });
      }

      // 1. Kiểm tra trạng thái cổng từ settings
      const settingsRes = await pool.query('SELECT key, value FROM giatruong.settings');
      const cfg: Record<string, string> = {};
      settingsRes.rows.forEach((r) => {
        cfg[r.key] = r.value;
      });

      const currentStatus = cfg.voting_status || 'closed';
      if (currentStatus === 'closed') {
        return reply.status(403).send({ success: false, message: 'Cổng bình chọn hiện đang đóng. Vui lòng chờ Ban Tổ Chức mở cổng.' });
      }
      if (currentStatus === 'trial_only' && !is_trial) {
        return reply.status(400).send({ success: false, message: 'Hiện tại hệ thống chỉ mở phiên BÌNH CHỌN THỬ NGHIỆM.' });
      }
      if (currentStatus === 'real_only' && is_trial) {
        return reply.status(400).send({ success: false, message: 'Hệ thống đang mở phiên BẦU CỬ CHÍNH THỨC, không thể bầu thử.' });
      }

      // 2. Nếu là Bầu Thật: Kiểm tra xem định danh này đã có phiếu bầu thành công chưa
      if (!is_trial) {
        const phoneParam = identity.cleanPhone || '';
        const nameParam = identity.cleanName ? `name:${identity.cleanName}` : '';

        const existingVote = await pool.query(
          `SELECT id, submitted_at FROM giatruong.votes
           WHERE is_trial = FALSE AND (
             ($1 <> '' AND voter_phone = $1) OR
             ($2 <> '' AND voter_phone = $2)
           )`,
          [phoneParam, nameParam]
        );
        if (existingVote.rows.length > 0) {
          return reply.status(409).send({
            success: false,
            message: 'Thông tin cử tri này đã hoàn thành lượt bầu chính thức và không thể tham gia thêm (1 người 1 phiếu).',
          });
        }

        // Kiểm tra xem có phiên thật nào đang dở dang (chưa hết giờ) không
        const activeSess = await pool.query(
          `SELECT id, expires_at, EXTRACT(EPOCH FROM (expires_at - NOW()))::int as remaining_seconds
           FROM giatruong.voting_sessions
           WHERE is_trial = FALSE AND status = 'in_progress' AND expires_at > NOW() AND (
             ($1 <> '' AND voter_phone = $1) OR
             ($2 <> '' AND voter_phone = $2)
           )
           ORDER BY started_at DESC LIMIT 1`,
          [phoneParam, nameParam]
        );
        if (activeSess.rows.length > 0) {
          const sess = activeSess.rows[0];
          return reply.send({
            success: true,
            session_id: sess.id,
            duration_seconds: Math.max(0, sess.remaining_seconds),
            expires_at: sess.expires_at,
            server_time: new Date().toISOString(),
            is_resumed: true,
          });
        }
      }

      // 3. Tính toán thời lượng phiên
      const durationMin = is_trial
        ? parseInt(cfg.trial_duration_minutes || '4', 10)
        : parseInt(cfg.real_duration_minutes || '8', 10);
      const durationSeconds = durationMin * 60;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + durationSeconds * 1000);

      // 4. Tạo phiên mới trong Database
      const sessionRes = await pool.query(
        `INSERT INTO giatruong.voting_sessions (voter_name, voter_phone, is_trial, started_at, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, 'in_progress')
         RETURNING id`,
        [identity.voterNameForDb, identity.voterPhoneForDb, is_trial, now, expiresAt]
      );

      const sessionId = sessionRes.rows[0].id;

      return reply.send({
        success: true,
        session_id: sessionId,
        duration_seconds: durationSeconds,
        expires_at: expiresAt.toISOString(),
        server_time: now.toISOString(),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /session/start ERROR]');
      return reply.status(500).send({ success: false, message: 'Lỗi máy chủ khi khởi tạo phiên bầu cử.' });
    }
  });

  // =========================================================================
  // 4. GET /session/active: Nhận diện & khôi phục phiên dở dang (SĐT hoặc Tên)
  // =========================================================================
  fastify.get<{
    Querystring: {
      phone?: string;
      name?: string;
      is_trial?: string;
    };
  }>('/session/active', async (request, reply) => {
    try {
      const phoneParam = (request.query.phone || '').trim().replace(/\D/g, '');
      const rawName = (request.query.name || '').trim();
      const cleanName = removeVietnameseTones(rawName);
      const nameParam = cleanName.length >= 2 ? `name:${cleanName}` : '';
      const isTrial = request.query.is_trial === 'true';

      if (!phoneParam && !nameParam) {
        return reply.send({ success: true, active: false });
      }

      const activeRes = await pool.query(
        `SELECT id, voter_name, voter_phone, is_trial, started_at, expires_at,
                EXTRACT(EPOCH FROM (expires_at - NOW()))::int as remaining_seconds
         FROM giatruong.voting_sessions
         WHERE is_trial = $1 AND status = 'in_progress' AND expires_at > NOW() AND (
           ($2 <> '' AND voter_phone = $2) OR
           ($3 <> '' AND voter_phone = $3)
         )
         ORDER BY started_at DESC LIMIT 1`,
        [isTrial, phoneParam, nameParam]
      );

      if (activeRes.rows.length === 0) {
        return reply.send({ success: true, active: false });
      }

      const sess = activeRes.rows[0];

      // Đọc draft candidates từ Redis nếu có để khôi phục tức thì
      let draftCandidates: Array<number | string> = [];
      if (redis) {
        try {
          const rawDraft = await redis.get(`giatruong:draft:${sess.id}`);
          if (rawDraft) {
            draftCandidates = JSON.parse(rawDraft);
          }
        } catch {
          // Ignore parse error
        }
      }

      return reply.send({
        success: true,
        active: true,
        session_id: sess.id,
        voter_name: sess.voter_name,
        voter_phone: sess.voter_phone,
        is_trial: sess.is_trial,
        expires_at: sess.expires_at,
        remaining_seconds: Math.max(0, sess.remaining_seconds),
        draft_candidates: draftCandidates,
        server_time: new Date().toISOString(),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /session/active ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 5. POST /draft-pick: Đồng bộ lượt chọn nháp (Sliding Window Redis ZSET)
  // =========================================================================
  fastify.post<{
    Body: {
      session_id: string;
      candidate_ids: Array<number | string>;
    };
  }>('/draft-pick', async (request, reply) => {
    try {
      const { session_id, candidate_ids } = request.body || {};
      if (!session_id || typeof session_id !== 'string' || !Array.isArray(candidate_ids)) {
        return reply.status(400).send({ success: false, message: 'Dữ liệu chọn nháp không hợp lệ.' });
      }

      if (redis) {
        const now = Date.now();
        const pipeline = redis.pipeline();

        // Đưa session vào ZSET với score là timestamp hiện tại
        pipeline.zadd('giatruong:active_sessions', now, session_id);

        // Lưu snapshot danh sách ứng viên mà cử tri đang chọn với TTL 10 phút (600s)
        pipeline.setex(`giatruong:draft:${session_id}`, 600, JSON.stringify(candidate_ids));

        await pipeline.exec();
      }

      return reply.send({ success: true });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /draft-pick ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 6. GET /live-status: Trực tiếp tiến độ 8 phút (Non-blocking, Secret Ballot)
  // =========================================================================
  fastify.get('/live-status', async (_request, reply) => {
    try {
      const now = Date.now();
      const tenMinutesAgo = now - 10 * 60 * 1000;

      let activeDraftingCount = 0;
      const draftTallyMap: Record<number, number> = {};
      let customDraftCount = 0;

      if (redis) {
        // Dọn dẹp session cũ quá 10 phút và đếm O(1)
        await redis.zremrangebyscore('giatruong:active_sessions', 0, tenMinutesAgo);
        activeDraftingCount = await redis.zcard('giatruong:active_sessions');

        // Lấy danh sách session ID còn hoạt động
        const activeIds = await redis.zrange('giatruong:active_sessions', 0, -1);
        if (activeIds.length > 0) {
          const keys = activeIds.map((id: string) => `giatruong:draft:${id}`);
          const draftResults = await redis.mget(...keys);

          for (const rawDraft of draftResults) {
            if (!rawDraft) continue;
            try {
              const picks: Array<number | string> = JSON.parse(rawDraft);
              if (Array.isArray(picks)) {
                for (const p of picks) {
                  if (typeof p === 'number' && Number.isInteger(p)) {
                    draftTallyMap[p] = (draftTallyMap[p] || 0) + 1;
                  } else if (p) {
                    // Cử tri tự nhập nhân tố mới -> gom vào Secret Ballot count
                    customDraftCount++;
                  }
                }
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      }

      // Lấy tổng số phiếu Bầu Thật đã hoàn tất
      const submittedRes = await pool.query(
        'SELECT COUNT(*) as total_submitted FROM giatruong.votes WHERE is_trial = FALSE'
      );
      const totalSubmittedVotes = parseInt(submittedRes.rows[0]?.total_submitted || '0', 10);

      // Thống kê phiếu bầu thật đã nộp chính thức cho từng ứng viên
      const officialTallyRes = await pool.query(`
        SELECT c.id, c.name, c.is_incumbent, COUNT(vd.id) as official_votes
        FROM giatruong.candidates c
        LEFT JOIN giatruong.vote_details vd ON c.id = vd.candidate_id
        LEFT JOIN giatruong.votes v ON vd.vote_id = v.id AND v.is_trial = FALSE
        WHERE c.is_active = TRUE
        GROUP BY c.id, c.name, c.is_incumbent
      `);

      // Kết hợp Phiếu Chính Thức + Phiếu Nháp đang chọn
      const combinedCandidates = officialTallyRes.rows.map((r) => {
        const candId = parseInt(r.id, 10);
        const officialVotes = parseInt(r.official_votes || '0', 10);
        const draftVotes = draftTallyMap[candId] || 0;
        const totalEstimated = officialVotes + draftVotes;

        return {
          id: candId,
          name: r.name,
          is_incumbent: Boolean(r.is_incumbent),
          official_votes: officialVotes,
          draft_votes: draftVotes,
          total_estimated: totalEstimated,
        };
      });

      // Sắp xếp giảm dần theo tổng ước tính (kết hợp)
      combinedCandidates.sort((a, b) => {
        if (b.total_estimated !== a.total_estimated) {
          return b.total_estimated - a.total_estimated;
        }
        if (b.is_incumbent !== a.is_incumbent) {
          return (b.is_incumbent ? 1 : 0) - (a.is_incumbent ? 1 : 0);
        }
        return a.id - b.id;
      });

      const topEstimated = combinedCandidates.slice(0, 8);

      return reply.send({
        success: true,
        active_drafting_count: activeDraftingCount,
        total_submitted_votes: totalSubmittedVotes,
        custom_candidates_draft_count: customDraftCount,
        top_estimated: topEstimated,
        server_time: new Date().toISOString(),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /live-status ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 5. POST /submit-vote: Nộp phiếu bầu cử với Connection Leak Guard & Upsert
  // =========================================================================
  fastify.post<{
    Body: {
      session_id: string;
      selected_candidates: Array<{
        id?: number | null;
        name?: string;
        isNew?: boolean;
      }>;
    };
  }>('/submit-vote', async (request, reply) => {
    const { session_id, selected_candidates } = request.body || {};

    if (!session_id) {
      return reply.status(400).send({ success: false, message: 'Thiếu mã định danh phiên bầu cử (session_id).' });
    }

    if (!Array.isArray(selected_candidates) || selected_candidates.length !== 8) {
      return reply.status(400).send({
        success: false,
        message: `Phiếu bầu không hợp lệ. Bắt buộc phải chọn đủ 8 vị trí (hiện có: ${selected_candidates?.length || 0}).`,
      });
    }

    // 1. Kiểm tra session hợp lệ và Hard Timeout
    const sessRes = await pool.query(
      'SELECT id, voter_phone, is_trial, expires_at, status FROM giatruong.voting_sessions WHERE id = $1',
      [session_id]
    );

    if (sessRes.rows.length === 0) {
      return reply.status(404).send({ success: false, message: 'Phiên bầu cử không tồn tại.' });
    }

    const session = sessRes.rows[0];
    if (session.status !== 'in_progress') {
      return reply.status(409).send({
        success: false,
        message: session.status === 'completed'
          ? 'Phiếu bầu này đã được nộp trước đó.'
          : 'Phiên bầu cử đã hết thời gian quy định.',
      });
    }

    // Hard Timeout: Cho phép grace period 15 giây
    const nowMs = Date.now();
    const expiresMs = new Date(session.expires_at).getTime();
    if (nowMs > expiresMs + 15000) {
      await pool.query("UPDATE giatruong.voting_sessions SET status = 'expired' WHERE id = $1", [session_id]);
      return reply.status(408).send({
        success: false,
        message: 'Đã hết thời gian nộp phiếu quy định (vượt quá thời gian máy chủ cho phép).',
      });
    }

    // 2. Chạy Transaction với Connection Leak Guard
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Khóa phiên với SELECT ... FOR UPDATE chống double submit
      const lockRes = await client.query(
        'SELECT status FROM giatruong.voting_sessions WHERE id = $1 FOR UPDATE',
        [session_id]
      );
      if (lockRes.rows[0].status !== 'in_progress') {
        await client.query('ROLLBACK');
        return reply.status(409).send({ success: false, message: 'Phiên bầu cử đã hoàn tất hoặc hết hạn.' });
      }

      // Xử lý từng ứng viên (Hỗ trợ Upsert ứng viên mới on-the-fly)
      const resolvedCandidates: Array<{ candidateId: number | null; customName: string | null; isNew: boolean }> = [];

      for (const item of selected_candidates) {
        if (item.isNew || !item.id) {
          const rawName = (item.name || '').trim();
          const cleanName = removeVietnameseTones(rawName);

          if (!rawName) {
            throw new Error('Tên ứng viên tự nhập không được để trống.');
          }

          // Upsert an toàn bằng PostgreSQL ON CONFLICT
          const upsertRes = await client.query(
            `INSERT INTO giatruong.candidates (name, clean_name, is_incumbent, is_active)
             VALUES ($1, $2, FALSE, TRUE)
             ON CONFLICT (clean_name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [rawName, cleanName]
          );
          resolvedCandidates.push({
            candidateId: upsertRes.rows[0].id,
            customName: rawName,
            isNew: true,
          });
        } else {
          resolvedCandidates.push({
            candidateId: item.id,
            customName: null,
            isNew: false,
          });
        }
      }

      // Ghi nhận phiếu vào bảng giatruong.votes
      const voteRes = await client.query(
        `INSERT INTO giatruong.votes (session_id, voter_phone, is_trial, submitted_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id`,
        [session_id, session.voter_phone, session.is_trial]
      );
      const voteId = voteRes.rows[0].id;

      // Ghi 8 dòng chi tiết vào giatruong.vote_details
      for (const cand of resolvedCandidates) {
        await client.query(
          `INSERT INTO giatruong.vote_details (vote_id, candidate_id, custom_candidate_name, is_new)
           VALUES ($1, $2, $3, $4)`,
          [voteId, cand.candidateId, cand.customName, cand.isNew]
        );
      }

      // Cập nhật trạng thái phiên
      await client.query(
        "UPDATE giatruong.voting_sessions SET status = 'completed', submitted_at = NOW() WHERE id = $1",
        [session_id]
      );

      await client.query('COMMIT');

      // Chống đếm trùng: Xóa ngay session khỏi Redis active draft sau khi đã submit thành công
      if (redis) {
        try {
          const pipeline = redis.pipeline();
          pipeline.zrem('giatruong:active_sessions', session_id);
          pipeline.del(`giatruong:draft:${session_id}`);
          await pipeline.exec();
        } catch (rErr) {
          fastify.log.warn(rErr, '[REDIS DRAFT CLEANUP WARN]');
        }
      }

      return reply.send({
        success: true,
        message: session.is_trial
          ? 'Ghi nhận lượt BÌNH CHỌN THỬ thành công!'
          : 'Ghi nhận PHIẾU BẦU CHÍNH THỨC thành công!',
        is_trial: session.is_trial,
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      fastify.log.error(err, '[GIATRUONG /submit-vote TRANSACTION ERROR]');
      return reply.status(500).send({
        success: false,
        message: 'Lỗi ghi nhận phiếu bầu: ' + (err.message || 'Lỗi cơ sở dữ liệu.'),
      });
    } finally {
      client.release(); // Giải phóng kết nối về pool bảo đảm không leak
    }
  });

  // =========================================================================
  // 6. GET /admin/results: Bảng tổng kết kết quả phiếu bầu (Real-time)
  // =========================================================================
  fastify.get<{
    Querystring: {
      token?: string;
    };
  }>('/admin/results', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const queryToken = request.query.token;
      const token = headerToken || queryToken;

      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!token || token !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      // Thống kê tổng số phiếu
      const countRes = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE is_trial = FALSE) as total_real_votes,
          COUNT(*) FILTER (WHERE is_trial = TRUE) as total_trial_votes
        FROM giatruong.votes
      `);
      const { total_real_votes, total_trial_votes } = countRes.rows[0];

      // Thống kê danh sách ứng viên Bầu Thật
      const realRankRes = await pool.query(`
        SELECT 
          c.id, c.name, c.is_incumbent,
          COUNT(vd.id) as vote_count
        FROM giatruong.candidates c
        LEFT JOIN giatruong.vote_details vd ON c.id = vd.candidate_id
        LEFT JOIN giatruong.votes v ON vd.vote_id = v.id AND v.is_trial = FALSE
        WHERE c.is_active = TRUE
        GROUP BY c.id, c.name, c.is_incumbent
        ORDER BY vote_count DESC, c.is_incumbent DESC, c.id ASC
      `);

      // Thống kê danh sách ứng viên Bầu Thử
      const trialRankRes = await pool.query(`
        SELECT 
          c.id, c.name, c.is_incumbent,
          COUNT(vd.id) as vote_count
        FROM giatruong.candidates c
        LEFT JOIN giatruong.vote_details vd ON c.id = vd.candidate_id
        LEFT JOIN giatruong.votes v ON vd.vote_id = v.id AND v.is_trial = TRUE
        WHERE c.is_active = TRUE
        GROUP BY c.id, c.name, c.is_incumbent
        ORDER BY vote_count DESC, c.is_incumbent DESC, c.id ASC
      `);

      return reply.send({
        success: true,
        total_real_votes: parseInt(total_real_votes || '0', 10),
        total_trial_votes: parseInt(total_trial_votes || '0', 10),
        real_ranking: realRankRes.rows.map((r) => ({
          ...r,
          vote_count: parseInt(r.vote_count || '0', 10),
        })),
        trial_ranking: trialRankRes.rows.map((r) => ({
          ...r,
          vote_count: parseInt(r.vote_count || '0', 10),
        })),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/results ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 7. POST /admin/settings: Cập nhật trạng thái cổng & thời lượng
  // =========================================================================
  fastify.post<{
    Body: {
      voting_status?: 'trial_only' | 'real_only' | 'closed';
      real_duration_minutes?: number;
      trial_duration_minutes?: number;
      admin_secret_token?: string;
    };
  }>('/admin/settings', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!headerToken || headerToken !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      const { voting_status, real_duration_minutes, trial_duration_minutes, admin_secret_token } = request.body || {};

      if (voting_status && ['trial_only', 'real_only', 'closed'].includes(voting_status)) {
        await pool.query(
          "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('voting_status', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [voting_status]
        );
      }
      if (real_duration_minutes && real_duration_minutes > 0) {
        await pool.query(
          "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('real_duration_minutes', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [String(real_duration_minutes)]
        );
      }
      if (trial_duration_minutes && trial_duration_minutes > 0) {
        await pool.query(
          "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('trial_duration_minutes', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [String(trial_duration_minutes)]
        );
      }
      if (admin_secret_token && admin_secret_token.trim().length >= 6) {
        await pool.query(
          "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('admin_secret_token', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
          [admin_secret_token.trim()]
        );
      }

      return reply.send({ success: true, message: 'Cập nhật cấu hình thành công.' });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/settings ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 8. POST /admin/reset-trial: Reset chỉ các lượt bầu thử (cho phép thử lại nhiều lần)
  // =========================================================================
  fastify.post('/admin/reset-trial', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!headerToken || headerToken !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      await pool.query('DELETE FROM giatruong.votes WHERE is_trial = TRUE');
      await pool.query("DELETE FROM giatruong.voting_sessions WHERE is_trial = TRUE");

      return reply.send({ success: true, message: 'Đã đặt lại toàn bộ kết quả bầu thử nghiệm.' });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/reset-trial ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });
};
