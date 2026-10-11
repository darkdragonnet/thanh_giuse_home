import { Job } from 'bullmq';
import { pool } from '../shared/db.js';
import { syncCloudPersonsToStudentsBatch, CloudPersonSyncItem } from '../services/sync.service.js';

export interface HanetSyncJobPayload {
  batchId: string;
  persons: CloudPersonSyncItem[];
}

export async function handleHanetSync2000(job: Job<HanetSyncJobPayload>) {
  const { persons, batchId } = job.data;

  if (!persons || persons.length === 0) {
    return { batchId, totalSynced: 0, conflictsCount: 0 };
  }

  try {
    const result = await syncCloudPersonsToStudentsBatch(
      pool,
      persons,
      100,
      async (percent: number) => {
        await job.updateProgress(percent);
      }
    );

    return {
      batchId,
      totalSynced: result.totalSynced,
      conflictsCount: result.conflictsCount,
    };
  } catch (err: any) {
    console.error(`[Worker Job ${job.id}] Batch sync failed:`, err);
    throw err;
  }
}
