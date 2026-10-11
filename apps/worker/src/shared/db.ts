import { createDbPool } from '@thanh-giuse/shared-infra';
import { workerEnv } from '../config.js';

export const pool = createDbPool(workerEnv.db);
