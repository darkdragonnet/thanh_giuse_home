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

export async function getCurrentElectionRound(pool: Pool): Promise<{
  id: number;
  round_number: number;
  title: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduled_start_at: string | null;
  started_at: string | null;
  expires_at: string | null;
  duration_minutes: number;
  total_votes: number;
} | null> {
  const settingRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'current_round_id'");
  const roundId = settingRes.rows[0]?.value ? parseInt(settingRes.rows[0].value, 10) : null;

  let roundRes;
  if (roundId) {
    roundRes = await pool.query('SELECT * FROM giatruong.election_rounds WHERE id = $1', [roundId]);
  }
  if (!roundRes || roundRes.rows.length === 0) {
    roundRes = await pool.query('SELECT * FROM giatruong.election_rounds ORDER BY id DESC LIMIT 1');
  }

  if (roundRes.rows.length === 0) return null;
  const round = roundRes.rows[0];

  const now = new Date();
  // Tự động kích hoạt sang 'in_progress' nếu là 'scheduled' và đã đến giờ G
  if (round.status === 'scheduled' && round.scheduled_start_at && new Date(round.scheduled_start_at) <= now) {
    const durationMin = round.duration_minutes || 8;
    const expiresAt = new Date(new Date(round.scheduled_start_at).getTime() + durationMin * 60 * 1000);
    await pool.query(
      "UPDATE giatruong.election_rounds SET status = 'in_progress', started_at = COALESCE(started_at, $1), expires_at = $2 WHERE id = $3",
      [round.scheduled_start_at, expiresAt, round.id]
    );
    round.status = 'in_progress';
    round.started_at = round.scheduled_start_at;
    round.expires_at = expiresAt;
  }

  // Tự động chốt 'completed' nếu đã qua expires_at
  if (round.status === 'in_progress' && round.expires_at && new Date(round.expires_at) < now) {
    await pool.query(
      "UPDATE giatruong.election_rounds SET status = 'completed' WHERE id = $1",
      [round.id]
    );
    round.status = 'completed';
  }

  return round;
}

export async function computeLiveStatus(
  pool: Pool,
  redis: Redis | undefined,
  limit: number = 10,
  targetRoundId?: number | null
): Promise<{
  roundId: number | null;
  activeDraftingCount: number;
  totalSubmittedVotes: number;
  customDraftCount: number;
  topEstimated: Array<{
    id: number;
    name: string;
    is_incumbent: boolean;
    official_votes: number;
    draft_votes: number;
    total_estimated: number;
  }>;
}> {
  const currentRound = targetRoundId ? null : await getCurrentElectionRound(pool);
  const roundId = targetRoundId || currentRound?.id || 1;

  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;

  let activeDraftingCount = 0;
  const draftTallyMap: Record<number, number> = {};
  let customDraftCount = 0;

  const redisActiveKey = `giatruong:round:${roundId}:active_sessions`;
  const redisDraftPrefix = `giatruong:round:${roundId}:draft:`;

  if (redis) {
    // Dọn dẹp session cũ quá 10 phút và đếm O(1) theo round
    await redis.zremrangebyscore(redisActiveKey, 0, tenMinutesAgo);
    activeDraftingCount = await redis.zcard(redisActiveKey);

    // Lấy danh sách session ID còn hoạt động
    const activeIds = await redis.zrange(redisActiveKey, 0, -1);
    if (activeIds.length > 0) {
      const keys = activeIds.map((id: string) => `${redisDraftPrefix}${id}`);
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

  // Lấy tổng số phiếu Bầu Thật đã hoàn tất trong round này
  const submittedRes = await pool.query(
    'SELECT COUNT(*) as total_submitted FROM giatruong.votes WHERE round_id = $1 AND is_trial = FALSE',
    [roundId]
  );
  const totalSubmittedVotes = parseInt(submittedRes.rows[0]?.total_submitted || '0', 10);

  // Thống kê phiếu bầu thật đã nộp chính thức cho từng ứng viên trong round này
  const officialTallyRes = await pool.query(`
    SELECT c.id, c.name, c.is_incumbent, COUNT(vd.id) as official_votes
    FROM giatruong.candidates c
    LEFT JOIN giatruong.vote_details vd ON c.id = vd.candidate_id
    LEFT JOIN giatruong.votes v ON vd.vote_id = v.id AND v.is_trial = FALSE AND v.round_id = $1
    WHERE c.is_active = TRUE
    GROUP BY c.id, c.name, c.is_incumbent
  `, [roundId]);

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

  const topEstimated = combinedCandidates.slice(0, limit);

  return {
    roundId,
    activeDraftingCount,
    totalSubmittedVotes,
    customDraftCount,
    topEstimated,
  };
}

export async function triggerLiveBroadcastIfEligible(
  pool: Pool,
  redis: Redis | undefined,
  log?: any
): Promise<{ triggered: boolean; reason?: string; milestone?: string; votesSinceLast?: number; timeSinceLast?: number }> {
  if (!redis) return { triggered: false, reason: 'no_redis' };

  try {
    const statusRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'voting_status'");
    if (statusRes.rows[0]?.value !== 'real_only') {
      return { triggered: false, reason: 'not_real_only' };
    }

    const currentRound = await getCurrentElectionRound(pool);
    const roundId = currentRound?.id || 1;

    const countRes = await pool.query('SELECT COUNT(*) as cnt FROM giatruong.votes WHERE round_id = $1 AND is_trial = FALSE', [roundId]);
    const totalSubmitted = parseInt(countRes.rows[0]?.cnt || '0', 10);
    if (totalSubmitted <= 0) return { triggered: false, reason: 'zero_votes' };

    const state = await redis.hgetall(`giatruong:round:${roundId}:broadcast_state`);
    const lastTs = parseInt(state.last_ts || '0', 10);
    const lastCount = parseInt(state.last_count || '0', 10);
    const now = Date.now();
    const votesSinceLast = totalSubmitted - lastCount;
    const timeSinceLast = now - lastTs;

    const isMilestone = totalSubmitted % 4 === 0 || votesSinceLast >= 4;
    const isTimeThrottle = timeSinceLast >= 45000 && votesSinceLast >= 1;

    if (!isMilestone && !isTimeThrottle && totalSubmitted < 40) {
      return { triggered: false, reason: 'throttled', votesSinceLast, timeSinceLast };
    }

    await redis.hset(`giatruong:round:${roundId}:broadcast_state`, {
      last_ts: String(now),
      last_count: String(totalSubmitted),
    });

    const liveData = await computeLiveStatus(pool, redis, 10, roundId);
    const milestone = `${liveData.totalSubmittedVotes}/40 phiếu`;

    const timeStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const topText = liveData.topEstimated
      .map((c, i) => `${i + 1}. ${c.name}: ${c.total_estimated} phiếu (Chính thức: ${c.official_votes})`)
      .join('\n');

    const customText = liveData.customDraftCount > 0
      ? `\n🔒 (Ghi nhận có ${liveData.customDraftCount} lượt chọn ẩn danh cho các nhân tố mới ngoài danh sách)`
      : '';

    const roundTitle = currentRound ? ` [ĐỢT ${currentRound.round_number}]` : '';
    const zaloMessage = `📊 [TRỰC TIẾP BẦU CỬ GIA TRƯỞNG${roundTitle}] - Cập nhật tiến độ (${milestone})
⏰ Thời gian: ${timeStr}
🗳️ Đã nộp: ${liveData.totalSubmittedVotes}/40 cử tri
👥 Đang thao tác nháp: ${liveData.activeDraftingCount} cử tri

🏆 TOP 10 ỨNG VIÊN DẪN ĐẦU (TẠM THỜI):
${topText}${customText}

👉 Cử tri tiếp tục bỏ phiếu tại: https://thanhgiuse.gaudetedomino.io.vn/giatruong/`;

    const targetThreadId = process.env.ZALO_GIATRUONG_GROUP_ID || '8686690356639968363';
    const zaloBroadcastUrl = process.env.N8N_ZALO_BROADCAST_URL || 'https://n8nhome.gaudetedomino.io.vn/webhook/broadcast-zalo?token=LongDen1982';

    fetch(zaloBroadcastUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: targetThreadId,
        chat_type: 'group',
        message: zaloMessage,
      }),
      signal: AbortSignal.timeout(6000),
    }).catch((wErr: any) => {
      log?.warn?.({ err: wErr.message }, '[ZALO BROADCAST DIRECT TRIGGER FAILED]');
    });

    return { triggered: true, milestone };
  } catch (err: any) {
    log?.error?.(err, '[TRIGGER LIVE BROADCAST ERROR]');
    return { triggered: false, reason: err.message };
  }
}

export const giatruongRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = fastify.pg as Pool;
  const redis = (fastify as any).redis as Redis | undefined;

  // =========================================================================
  // 1. GET /config: Lấy cấu hình trạng thái, thông tin Round & đếm ngược
  // =========================================================================
  fastify.get('/config', async (_request, reply) => {
    try {
      const res = await pool.query('SELECT key, value FROM giatruong.settings');
      const cfg: Record<string, string> = {};
      res.rows.forEach((r) => {
        cfg[r.key] = r.value;
      });

      const currentRound = await getCurrentElectionRound(pool);
      const now = Date.now();

      let remainingSecondsToStart = 0;
      let remainingSecondsToEnd = 0;

      if (currentRound) {
        if (currentRound.scheduled_start_at) {
          const startMs = new Date(currentRound.scheduled_start_at).getTime();
          remainingSecondsToStart = Math.max(0, Math.round((startMs - now) / 1000));
        }
        if (currentRound.expires_at) {
          const expiresMs = new Date(currentRound.expires_at).getTime();
          remainingSecondsToEnd = Math.max(0, Math.round((expiresMs - now) / 1000));
        }
      }

      return reply.send({
        success: true,
        voting_status: cfg.voting_status || 'closed', // 'trial_only' | 'real_only' | 'closed'
        real_duration_minutes: parseInt(cfg.real_duration_minutes || '8', 10),
        trial_duration_minutes: parseInt(cfg.trial_duration_minutes || '4', 10),
        max_picks: parseInt(cfg.max_picks || '8', 10),
        server_time: new Date().toISOString(),
        current_round: currentRound ? {
          id: currentRound.id,
          round_number: currentRound.round_number,
          title: currentRound.title,
          status: currentRound.status,
          scheduled_start_at: currentRound.scheduled_start_at,
          started_at: currentRound.started_at,
          expires_at: currentRound.expires_at,
          duration_minutes: currentRound.duration_minutes,
          remaining_seconds_to_start: remainingSecondsToStart,
          remaining_seconds_to_end: remainingSecondsToEnd,
        } : null,
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
  // 3. POST /session/start: Bắt đầu phiên bỏ phiếu (Unified Identity & Per-Round)
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

      const now = new Date();
      let currentRound = await getCurrentElectionRound(pool);

      // 2. Nếu là Bầu Thật: Kiểm tra Round, Scheduled Window & Per-round idempotency
      if (!is_trial) {
        if (!currentRound) {
          return reply.status(400).send({ success: false, message: 'Chưa có đợt bầu cử chính thức nào được kích hoạt.' });
        }

        if (currentRound.status === 'cancelled') {
          return reply.status(403).send({ success: false, message: 'Đợt bầu cử này đã bị tạm hoãn bởi Ban Tổ Chức.' });
        }

        // Nếu đang ở trạng thái hẹn giờ và chưa tới giờ G
        if (currentRound.status === 'scheduled' && currentRound.scheduled_start_at && new Date(currentRound.scheduled_start_at) > now) {
          const timeStr = new Date(currentRound.scheduled_start_at).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return reply.status(403).send({
            success: false,
            message: `Cổng bầu cử chính thức chưa mở. Dự kiến mở lúc ${timeStr}. Vui lòng chờ trong phòng chờ.`,
          });
        }

        // Kiểm tra xem round đã hết giờ chưa
        if (currentRound.expires_at && new Date(currentRound.expires_at) <= now) {
          return reply.status(400).send({ success: false, message: 'Đợt bầu cử này đã kết thúc thời gian bỏ phiếu.' });
        }

        // Per-round idempotency (Task 2.4): Kiểm tra trong phạm vi current_round.id
        const existingVote = await pool.query(`
          SELECT id FROM giatruong.votes 
          WHERE round_id = $1 AND is_trial = FALSE
            AND (
              ($2 != '' AND voter_phone IS NOT NULL AND voter_phone = $2)
              OR 
              ($3 != '' AND clean_voter_name IS NOT NULL AND clean_voter_name = $3)
            )
        `, [currentRound.id, identity.cleanPhone, identity.cleanName]);

        if (existingVote.rows.length > 0) {
          return reply.status(409).send({
            success: false,
            message: `Cử tri này đã hoàn thành lượt bầu của Đợt ${currentRound.round_number} (1 người 1 phiếu).`,
          });
        }

        // Kiểm tra xem có phiên thật dở dang trong round này không
        const activeSess = await pool.query(
          `SELECT id, expires_at, EXTRACT(EPOCH FROM (expires_at - NOW()))::int as remaining_seconds
           FROM giatruong.voting_sessions
           WHERE round_id = $1 AND is_trial = FALSE AND status = 'in_progress' AND expires_at > NOW() AND (
             ($2 <> '' AND voter_phone = $2) OR
             ($3 <> '' AND clean_voter_name = $3)
           )
           ORDER BY started_at DESC LIMIT 1`,
          [currentRound.id, identity.cleanPhone, identity.cleanName]
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
      let expiresAt: Date;
      let durationSeconds: number;

      if (!is_trial && currentRound && currentRound.expires_at) {
        // Đồng bộ toàn cục theo giờ kết thúc của Round (Late-joiner tính chuẩn thời gian còn lại)
        expiresAt = new Date(currentRound.expires_at);
        durationSeconds = Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 1000));
        if (durationSeconds <= 0) {
          return reply.status(400).send({ success: false, message: 'Đợt bầu cử này đã kết thúc thời gian bỏ phiếu.' });
        }
      } else {
        const durationMin = is_trial
          ? parseInt(cfg.trial_duration_minutes || '4', 10)
          : parseInt(cfg.real_duration_minutes || '8', 10);
        durationSeconds = durationMin * 60;
        expiresAt = new Date(now.getTime() + durationSeconds * 1000);
      }

      // 4. Tạo phiên mới trong Database
      const sessionRes = await pool.query(
        `INSERT INTO giatruong.voting_sessions (round_id, voter_name, clean_voter_name, voter_phone, is_trial, started_at, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress')
         RETURNING id`,
        [
          currentRound ? currentRound.id : null,
          identity.voterNameForDb,
          identity.cleanName,
          identity.cleanPhone || null,
          is_trial,
          now,
          expiresAt,
        ]
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
  // 4. GET /session/active: Nhận diện & khôi phục phiên dở dang
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
      const isTrial = request.query.is_trial === 'true';

      if (!phoneParam && !cleanName) {
        return reply.send({ success: true, active: false });
      }

      const currentRound = await getCurrentElectionRound(pool);
      const roundId = currentRound?.id || 1;

      const activeRes = await pool.query(
        `SELECT id, round_id, voter_name, clean_voter_name, voter_phone, is_trial, started_at, expires_at,
                EXTRACT(EPOCH FROM (expires_at - NOW()))::int as remaining_seconds
         FROM giatruong.voting_sessions
         WHERE is_trial = $1 AND status = 'in_progress' AND expires_at > NOW() AND (
           ($2 <> '' AND voter_phone = $2) OR
           ($3 <> '' AND clean_voter_name = $3)
         )
         ORDER BY started_at DESC LIMIT 1`,
        [isTrial, phoneParam, cleanName]
      );

      if (activeRes.rows.length === 0) {
        return reply.send({ success: true, active: false });
      }

      const sess = activeRes.rows[0];

      // Đọc draft candidates từ Redis namespace theo round nếu có
      let draftCandidates: Array<number | string> = [];
      if (redis) {
        try {
          const rawDraft = await redis.get(`giatruong:round:${sess.round_id || roundId}:draft:${sess.id}`);
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
        round_id: sess.round_id,
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
  // 5. POST /draft-pick: Đồng bộ lượt chọn nháp (Redis Namespace per Round)
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
        const currentRound = await getCurrentElectionRound(pool);
        const roundId = currentRound?.id || 1;

        const now = Date.now();
        const pipeline = redis.pipeline();

        // Đưa session vào ZSET của round hiện tại với score là timestamp
        pipeline.zadd(`giatruong:round:${roundId}:active_sessions`, now, session_id);

        // Lưu snapshot danh sách ứng viên với TTL 10 phút
        pipeline.setex(`giatruong:round:${roundId}:draft:${session_id}`, 600, JSON.stringify(candidate_ids));

        await pipeline.exec();
      }

      return reply.send({ success: true });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /draft-pick ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 6. GET /live-status: Trực tiếp tiến độ (Non-blocking, Secret Ballot, Per-Round)
  // =========================================================================
  fastify.get<{
    Querystring: {
      limit?: string;
      round_id?: string;
    };
  }>('/live-status', async (request, reply) => {
    try {
      const limit = parseInt(request.query?.limit || '10', 10);
      const targetRoundId = request.query?.round_id ? parseInt(request.query.round_id, 10) : null;
      const liveData = await computeLiveStatus(pool, redis, limit, targetRoundId);

      return reply.send({
        success: true,
        round_id: liveData.roundId,
        active_drafting_count: liveData.activeDraftingCount,
        total_submitted_votes: liveData.totalSubmittedVotes,
        custom_candidates_draft_count: liveData.customDraftCount,
        top_estimated: liveData.topEstimated,
        server_time: new Date().toISOString(),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /live-status ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 7. POST /submit-vote: Nộp phiếu với Per-Round Idempotency & Clean Redis
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
      'SELECT id, round_id, voter_name, clean_voter_name, voter_phone, is_trial, expires_at, status FROM giatruong.voting_sessions WHERE id = $1',
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

      // Ghi nhận phiếu vào bảng giatruong.votes kèm round_id và clean_voter_name
      const voteRes = await client.query(
        `INSERT INTO giatruong.votes (round_id, session_id, clean_voter_name, voter_phone, is_trial, submitted_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [session.round_id, session_id, session.clean_voter_name, session.voter_phone, session.is_trial]
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

      // Cập nhật total_votes của Round nếu là bầu thật
      if (!session.is_trial && session.round_id) {
        await client.query(
          "UPDATE giatruong.election_rounds SET total_votes = total_votes + 1 WHERE id = $1",
          [session.round_id]
        );
      }

      await client.query('COMMIT');

      // Chống đếm trùng: Xóa ngay session khỏi Redis active draft của round này
      if (redis) {
        try {
          const roundId = session.round_id || 1;
          const pipeline = redis.pipeline();
          pipeline.zrem(`giatruong:round:${roundId}:active_sessions`, session_id);
          pipeline.del(`giatruong:round:${roundId}:draft:${session_id}`);
          await pipeline.exec();
        } catch (rErr) {
          fastify.log.warn(rErr, '[REDIS DRAFT CLEANUP WARN]');
        }
      }

      // Kích hoạt phát sóng Zalo theo mốc submit
      if (!session.is_trial) {
        setImmediate(() => {
          triggerLiveBroadcastIfEligible(pool, redis, fastify.log);
        });
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
      client.release();
    }
  });

  // =========================================================================
  // 8. GET /admin/results: Bảng tổng kết kết quả phiếu bầu (Real-time Round)
  // =========================================================================
  fastify.get<{
    Querystring: {
      token?: string;
      round_id?: string;
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

      const currentRound = await getCurrentElectionRound(pool);
      const roundId = request.query?.round_id ? parseInt(request.query.round_id, 10) : (currentRound?.id || 1);

      // Thống kê tổng số phiếu trong round này
      const countRes = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE is_trial = FALSE) as total_real_votes,
          COUNT(*) FILTER (WHERE is_trial = TRUE) as total_trial_votes
        FROM giatruong.votes
        WHERE round_id = $1 OR is_trial = TRUE
      `, [roundId]);
      const { total_real_votes, total_trial_votes } = countRes.rows[0];

      // Thống kê danh sách ứng viên Bầu Thật của round này
      const realRankRes = await pool.query(`
        SELECT 
          c.id, c.name, c.is_incumbent,
          COUNT(vd.id) as vote_count
        FROM giatruong.candidates c
        LEFT JOIN giatruong.vote_details vd ON c.id = vd.candidate_id
        LEFT JOIN giatruong.votes v ON vd.vote_id = v.id AND v.is_trial = FALSE AND v.round_id = $1
        WHERE c.is_active = TRUE
        GROUP BY c.id, c.name, c.is_incumbent
        ORDER BY vote_count DESC, c.is_incumbent DESC, c.id ASC
      `, [roundId]);

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
        round_id: roundId,
        round_number: currentRound?.round_number || 1,
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
  // 9. BỘ API QUẢN TRỊ ĐỢT BẦU CỬ (ELECTION ROUNDS)
  // =========================================================================

  // 9.1 POST /admin/schedule-round: Ấn định thời gian bắt đầu
  fastify.post<{
    Body: {
      title?: string;
      duration_minutes?: number;
      start_mode?: 'now' | 'delay_minutes' | 'fixed_time';
      delay_minutes?: number;
      scheduled_start_at?: string;
      fixed_time?: string; // "19:30"
      notes?: string;
    };
  }>('/admin/schedule-round', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!headerToken || headerToken !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      const { title, duration_minutes = 8, start_mode, delay_minutes, fixed_time, scheduled_start_at } = request.body || {};
      const now = new Date();
      let scheduledStartAt: Date;
      let status: 'scheduled' | 'in_progress' = 'scheduled';

      if (scheduled_start_at) {
        scheduledStartAt = new Date(scheduled_start_at);
        if (scheduledStartAt <= now) {
          scheduledStartAt = now;
          status = 'in_progress';
        } else {
          status = 'scheduled';
        }
      } else if (delay_minutes !== undefined && delay_minutes > 0) {
        scheduledStartAt = new Date(now.getTime() + delay_minutes * 60 * 1000);
        status = 'scheduled';
      } else if (start_mode === 'now' || delay_minutes === 0) {
        scheduledStartAt = now;
        status = 'in_progress';
      } else if (start_mode === 'delay_minutes') {
        const dMin = delay_minutes || 5;
        scheduledStartAt = new Date(now.getTime() + dMin * 60 * 1000);
        status = 'scheduled';
      } else if ((start_mode === 'fixed_time' || fixed_time) && fixed_time) {
        const [h, m] = fixed_time.split(':').map((v) => parseInt(v, 10));
        scheduledStartAt = new Date(now);
        scheduledStartAt.setHours(h, m, 0, 0);
        if (scheduledStartAt <= now) {
          scheduledStartAt = now;
          status = 'in_progress';
        } else {
          status = 'scheduled';
        }
      } else {
        scheduledStartAt = new Date(now.getTime() + 5 * 60 * 1000);
        status = 'scheduled';
      }

      const expiresAt = new Date(scheduledStartAt.getTime() + duration_minutes * 60 * 1000);

      // Lấy số thứ tự round tiếp theo
      const maxRes = await pool.query('SELECT COALESCE(MAX(round_number), 0) as max_round FROM giatruong.election_rounds');
      const nextRoundNum = (parseInt(maxRes.rows[0]?.max_round || '0', 10)) + 1;
      const roundTitle = title || `Bầu Cử Ban Điều Hành Gia Trưởng - Đợt ${nextRoundNum}`;

      // Đóng các round cũ nếu đang mở
      await pool.query(
        "UPDATE giatruong.election_rounds SET status = 'completed', ended_at = COALESCE(ended_at, NOW()) WHERE status IN ('scheduled', 'in_progress')"
      );

      // Tạo round mới
      const insertRes = await pool.query(
        `INSERT INTO giatruong.election_rounds (round_number, title, status, scheduled_start_at, started_at, expires_at, duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          nextRoundNum,
          roundTitle,
          status,
          scheduledStartAt,
          status === 'in_progress' ? now : null,
          expiresAt,
          duration_minutes,
        ]
      );
      const newRoundId = insertRes.rows[0].id;

      // Cập nhật current_round_id và voting_status = 'real_only'
      await pool.query(
        "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('current_round_id', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        [String(newRoundId)]
      );
      await pool.query(
        "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('voting_status', 'real_only', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()"
      );

      return reply.send({
        success: true,
        message: status === 'in_progress'
          ? `Đã kích hoạt Đợt ${nextRoundNum} bắt đầu ngay lập tức!`
          : `Đã ấn định Đợt ${nextRoundNum} mở cổng lúc ${scheduledStartAt.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`,
        round: {
          id: newRoundId,
          round_number: nextRoundNum,
          title: roundTitle,
          status,
          scheduled_start_at: scheduledStartAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          duration_minutes,
        },
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/schedule-round ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // 9.2 POST /admin/new-round: Khởi động Đợt mới (Reset về 0 + Lưu vết)
  fastify.post<{
    Body: {
      duration_minutes?: number;
      delay_minutes?: number;
      scheduled_start_at?: string;
      title?: string;
      notes?: string;
    };
  }>('/admin/new-round', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!headerToken || headerToken !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      const { duration_minutes = 8, delay_minutes = 0, scheduled_start_at, title } = request.body || {};
      const now = new Date();

      let status: 'scheduled' | 'in_progress' = 'in_progress';
      let scheduledStartAt: Date | null = null;
      let startedAt: Date | null = now;
      let expiresAt: Date;

      if (scheduled_start_at) {
        scheduledStartAt = new Date(scheduled_start_at);
        if (scheduledStartAt > now) {
          status = 'scheduled';
          startedAt = null;
          expiresAt = new Date(scheduledStartAt.getTime() + duration_minutes * 60 * 1000);
        } else {
          expiresAt = new Date(now.getTime() + duration_minutes * 60 * 1000);
        }
      } else if (delay_minutes > 0) {
        status = 'scheduled';
        scheduledStartAt = new Date(now.getTime() + delay_minutes * 60 * 1000);
        startedAt = null;
        expiresAt = new Date(scheduledStartAt.getTime() + duration_minutes * 60 * 1000);
      } else {
        expiresAt = new Date(now.getTime() + duration_minutes * 60 * 1000);
      }

      // Chốt round cũ
      const oldRoundRes = await pool.query("SELECT id FROM giatruong.election_rounds WHERE status IN ('scheduled', 'in_progress') ORDER BY id DESC LIMIT 1");
      const oldRoundId = oldRoundRes.rows[0]?.id;
      if (oldRoundId) {
        await pool.query(
          "UPDATE giatruong.election_rounds SET status = 'completed', ended_at = NOW() WHERE id = $1",
          [oldRoundId]
        );
        // Dọn dẹp rác Redis round cũ
        if (redis) {
          try {
            await redis.del(`giatruong:round:${oldRoundId}:active_sessions`);
          } catch {}
        }
      }

      const maxRes = await pool.query('SELECT COALESCE(MAX(round_number), 0) as max_round FROM giatruong.election_rounds');
      const nextRoundNum = (parseInt(maxRes.rows[0]?.max_round || '0', 10)) + 1;
      const roundTitle = title || `Bầu Cử Ban Điều Hành Gia Trưởng - Đợt ${nextRoundNum}`;

      const insertRes = await pool.query(
        `INSERT INTO giatruong.election_rounds (round_number, title, status, scheduled_start_at, started_at, expires_at, duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [nextRoundNum, roundTitle, status, scheduledStartAt, startedAt, expiresAt, duration_minutes]
      );
      const newRoundId = insertRes.rows[0].id;

      await pool.query(
        "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('current_round_id', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        [String(newRoundId)]
      );
      await pool.query(
        "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('voting_status', 'real_only', NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()"
      );

      return reply.send({
        success: true,
        message: `Đã khởi động Đợt ${nextRoundNum}! Toàn bộ kết quả đã được reset về 0.`,
        round: {
          id: newRoundId,
          round_number: nextRoundNum,
          title: roundTitle,
          status,
          scheduled_start_at: scheduledStartAt?.toISOString(),
          started_at: startedAt?.toISOString(),
          expires_at: expiresAt.toISOString(),
          duration_minutes,
        },
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/new-round ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // 9.3 POST /admin/reschedule-round: Đổi giờ hoặc Hủy đợt bầu
  fastify.post<{
    Body: {
      action: 'reschedule' | 'cancel' | 'delay' | 'start_now';
      delay_minutes?: number;
      add_minutes?: number;
      fixed_time?: string;
    };
  }>('/admin/reschedule-round', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!headerToken || headerToken !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      const { action, delay_minutes = 5, add_minutes, fixed_time } = request.body || {};
      const currentRound = await getCurrentElectionRound(pool);

      if (!currentRound) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy đợt bầu cử hiện hành.' });
      }

      const now = new Date();
      const durationMin = currentRound.duration_minutes || 8;

      if (action === 'cancel') {
        await pool.query("UPDATE giatruong.election_rounds SET status = 'cancelled', ended_at = NOW() WHERE id = $1", [currentRound.id]);
        await pool.query("UPDATE giatruong.settings SET value = 'closed', updated_at = NOW() WHERE key = 'voting_status'");
        return reply.send({ success: true, message: 'Đã tạm hoãn đợt bầu cử hiện tại và đóng cổng.' });
      }

      if (action === 'start_now') {
        const expiresAt = new Date(now.getTime() + durationMin * 60 * 1000);
        await pool.query(
          "UPDATE giatruong.election_rounds SET status = 'in_progress', started_at = $1, expires_at = $2 WHERE id = $3",
          [now, expiresAt, currentRound.id]
        );
        await pool.query("UPDATE giatruong.settings SET value = 'real_only', updated_at = NOW() WHERE key = 'voting_status'");
        return reply.send({
          success: true,
          message: 'Đã kích hoạt đợt bầu cử bắt đầu ngay lập tức.',
          round: {
            id: currentRound.id,
            status: 'in_progress',
            started_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
          },
        });
      }

      let newStartAt: Date;
      if (action === 'delay') {
        const addMin = add_minutes || delay_minutes || 2;
        const currentStart = currentRound.scheduled_start_at ? new Date(currentRound.scheduled_start_at) : now;
        const base = currentStart > now ? currentStart : now;
        newStartAt = new Date(base.getTime() + addMin * 60 * 1000);
      } else if (fixed_time) {
        const [h, m] = fixed_time.split(':').map((v) => parseInt(v, 10));
        newStartAt = new Date(now);
        newStartAt.setHours(h, m, 0, 0);
        if (newStartAt <= now) {
          newStartAt.setDate(newStartAt.getDate() + 1);
        }
      } else {
        newStartAt = new Date(now.getTime() + delay_minutes * 60 * 1000);
      }

      const newExpiresAt = new Date(newStartAt.getTime() + durationMin * 60 * 1000);

      await pool.query(
        "UPDATE giatruong.election_rounds SET status = 'scheduled', scheduled_start_at = $1, expires_at = $2 WHERE id = $3",
        [newStartAt, newExpiresAt, currentRound.id]
      );

      return reply.send({
        success: true,
        message: `Đã đổi giờ mở cổng sang ${newStartAt.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`,
        round: {
          id: currentRound.id,
          status: 'scheduled',
          scheduled_start_at: newStartAt.toISOString(),
          expires_at: newExpiresAt.toISOString(),
        },
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/reschedule-round ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // 9.4 GET /admin/rounds: Lịch sử toàn bộ các đợt bầu cử
  fastify.get<{
    Querystring: {
      token?: string;
    };
  }>('/admin/rounds', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const queryToken = request.query.token;
      const token = headerToken || queryToken;

      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!token || token !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      const roundsRes = await pool.query(`
        SELECT r.*,
               COUNT(v.id) FILTER (WHERE v.is_trial = FALSE) as actual_votes_count
        FROM giatruong.election_rounds r
        LEFT JOIN giatruong.votes v ON r.id = v.round_id
        GROUP BY r.id
        ORDER BY r.round_number DESC, r.id DESC
      `);

      return reply.send({
        success: true,
        rounds: roundsRes.rows.map((r) => ({
          ...r,
          actual_votes_count: parseInt(r.actual_votes_count || '0', 10),
        })),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/rounds ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // 9.5 GET /admin/rounds/:id/results: Bảng kết quả chi tiết của 1 round cụ thể
  fastify.get<{
    Params: {
      id: string;
    };
    Querystring: {
      token?: string;
    };
  }>('/admin/rounds/:id/results', async (request, reply) => {
    try {
      const headerToken = request.headers['x-admin-token'] || (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const queryToken = request.query.token;
      const token = headerToken || queryToken;

      const secretRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'admin_secret_token'");
      const expectedToken = secretRes.rows[0]?.value || 'admin_secret_giatruong_2026';

      if (!token || token !== expectedToken) {
        return reply.status(401).send({ success: false, message: 'Sai mã xác thực Ban Tổ Chức (Unauthorized).' });
      }

      const roundId = parseInt(request.params.id, 10);
      const roundRes = await pool.query('SELECT * FROM giatruong.election_rounds WHERE id = $1', [roundId]);
      if (roundRes.rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Không tìm thấy đợt bầu cử này.' });
      }

      const rankRes = await pool.query(`
        SELECT 
          c.id, c.name, c.is_incumbent,
          COUNT(vd.id) as vote_count
        FROM giatruong.candidates c
        LEFT JOIN giatruong.vote_details vd ON c.id = vd.candidate_id
        LEFT JOIN giatruong.votes v ON vd.vote_id = v.id AND v.is_trial = FALSE AND v.round_id = $1
        WHERE c.is_active = TRUE
        GROUP BY c.id, c.name, c.is_incumbent
        ORDER BY vote_count DESC, c.is_incumbent DESC, c.id ASC
      `, [roundId]);

      const countRes = await pool.query(
        'SELECT COUNT(*) as total_votes FROM giatruong.votes WHERE round_id = $1 AND is_trial = FALSE',
        [roundId]
      );

      return reply.send({
        success: true,
        round: roundRes.rows[0],
        total_votes: parseInt(countRes.rows[0]?.total_votes || '0', 10),
        ranking: rankRes.rows.map((r) => ({
          ...r,
          vote_count: parseInt(r.vote_count || '0', 10),
        })),
      });
    } catch (err: any) {
      fastify.log.error(err, '[GIATRUONG /admin/rounds/:id/results ERROR]');
      return reply.status(500).send({ success: false, message: err.message });
    }
  });

  // =========================================================================
  // 10. POST /admin/settings: Cập nhật cấu hình chung
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

        if (voting_status === 'real_only') {
          const currentRound = await getCurrentElectionRound(pool);
          const durationSettingRes = await pool.query("SELECT value FROM giatruong.settings WHERE key = 'real_duration_minutes'");
          const durationMin = real_duration_minutes || parseInt(durationSettingRes.rows[0]?.value || '8', 10);
          const now = new Date();
          const expiresAt = new Date(now.getTime() + durationMin * 60 * 1000);

          if (!currentRound || currentRound.status === 'completed' || currentRound.status === 'cancelled') {
            const maxRes = await pool.query('SELECT COALESCE(MAX(round_number), 0) as max_round FROM giatruong.election_rounds');
            const nextRoundNum = (parseInt(maxRes.rows[0]?.max_round || '0', 10)) + 1;
            const roundTitle = `Bầu Cử Ban Điều Hành Gia Trưởng - Đợt ${nextRoundNum}`;
            const insertRes = await pool.query(
              `INSERT INTO giatruong.election_rounds (round_number, title, status, started_at, expires_at, duration_minutes)
               VALUES ($1, $2, 'in_progress', $3, $4, $5) RETURNING id`,
              [nextRoundNum, roundTitle, now, expiresAt, durationMin]
            );
            await pool.query(
              "INSERT INTO giatruong.settings (key, value, updated_at) VALUES ('current_round_id', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
              [String(insertRes.rows[0].id)]
            );
          } else if (currentRound.status === 'scheduled') {
            await pool.query(
              "UPDATE giatruong.election_rounds SET status = 'in_progress', started_at = $1, expires_at = $2 WHERE id = $3",
              [now, expiresAt, currentRound.id]
            );
          }
        }
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
  // 11. POST /admin/reset-trial: Reset chỉ các lượt bầu thử
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
