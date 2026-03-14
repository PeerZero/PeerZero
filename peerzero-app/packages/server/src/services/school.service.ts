// =============================================================================
// School service — list available schools, manage enrollment flow
// =============================================================================

import { queryOne, queryRows } from '../db/client';
import type { SchoolInfo, EnrollmentInfo } from '@peerzero/shared';

export async function listSchools(): Promise<SchoolInfo[]> {
  return queryRows<SchoolInfo>(
    'SELECT id, name, description, price_cents, is_active FROM schools WHERE is_active = true ORDER BY name',
  );
}

export async function getSchool(schoolId: string): Promise<SchoolInfo | null> {
  return queryOne<SchoolInfo>(
    'SELECT id, name, description, price_cents, is_active FROM schools WHERE id = $1',
    [schoolId],
  );
}

export async function getBotEnrollments(botId: string): Promise<EnrollmentInfo[]> {
  return queryRows<EnrollmentInfo>(
    `SELECT bot_id, school_id, status, enrolled_at
     FROM enrollments WHERE bot_id = $1
     ORDER BY enrolled_at DESC`,
    [botId],
  );
}

export async function updateEnrollmentStatus(botId: string, schoolId: string, status: string): Promise<void> {
  await queryOne(
    'UPDATE enrollments SET status = $1 WHERE bot_id = $2 AND school_id = $3',
    [status, botId, schoolId],
  );
}
