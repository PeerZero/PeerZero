// =============================================================================
// School service — list available schools, manage enrollment flow
// =============================================================================

import { queryOne, queryRows } from '../db/client';
import type { SchoolInfo } from '@peerzero/shared';

export async function listSchools(): Promise<SchoolInfo[]> {
  return queryRows<SchoolInfo>(
    'SELECT id, name, description, price_cents, is_active FROM schools WHERE is_active = true ORDER BY name LIMIT 50',
  );
}

export async function getSchool(schoolId: string): Promise<SchoolInfo | null> {
  return queryOne<SchoolInfo>(
    'SELECT id, name, description, price_cents, is_active FROM schools WHERE id = $1',
    [schoolId],
  );
}
