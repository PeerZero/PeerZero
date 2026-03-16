// =============================================================================
// Class service — education group management
// Teachers create classes with join codes, students join and link their bots.
// Dashboard provides aggregate stats for teacher monitoring.
// =============================================================================

import crypto from 'crypto';
import { queryOne, queryRows, query } from '../db/client';
import { AppError } from '../middleware/error-handler';
import { logAudit } from './audit.service';
import { notifyClassJoined } from './notification.service';
import { MAX_CLASS_MEMBERS, JOIN_CODE_LENGTH } from '@peerzero/shared';
import type { ClassInfo, ClassMember, ClassDashboard } from '@peerzero/shared';

function generateJoinCode(): string {
  // 6-char alphanumeric, cryptographically random
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 to avoid confusion
  const bytes = crypto.randomBytes(JOIN_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/** Create a new class. The creator becomes a 'teacher' member. */
export async function createClass(
  userId: string,
  name: string,
  description?: string,
  schoolId?: string,
): Promise<ClassInfo> {
  if (!name || name.length < 2 || name.length > 100) {
    throw new AppError(400, 'Class name must be 2–100 characters');
  }

  // Validate school exists if provided
  if (schoolId) {
    const school = await queryOne('SELECT id FROM schools WHERE id = $1 AND is_active = true', [schoolId]);
    if (!school) throw new AppError(404, 'School not found');
  }

  // Generate unique join code (retry on collision)
  let joinCode = generateJoinCode();
  let attempts = 0;
  while (attempts < 5) {
    const existing = await queryOne('SELECT id FROM classes WHERE join_code = $1', [joinCode]);
    if (!existing) break;
    joinCode = generateJoinCode();
    attempts++;
  }
  if (attempts >= 5) throw new AppError(500, 'Failed to generate unique join code');

  const cls = await queryOne<{ id: string; created_at: string }>(
    `INSERT INTO classes (owner_id, name, description, join_code, school_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [userId, name, description || null, joinCode, schoolId || null],
  );

  // Add creator as teacher
  await query(
    `INSERT INTO class_members (class_id, user_id, role) VALUES ($1, $2, 'teacher')`,
    [cls!.id, userId],
  );

  logAudit({
    userId,
    action: 'class.create',
    entityType: 'bot',
    entityId: cls!.id,
    metadata: { name, join_code: joinCode },
  });

  return {
    id: cls!.id,
    name,
    description: description || null,
    join_code: joinCode,
    school_name: null, // caller can join if needed
    member_count: 1,
    role: 'teacher',
    created_at: cls!.created_at,
  };
}

/** List classes a user owns or belongs to. */
export async function getUserClasses(userId: string): Promise<ClassInfo[]> {
  return queryRows<ClassInfo>(
    `SELECT c.id, c.name, c.description, c.join_code,
            s.name as school_name,
            cm.role,
            c.created_at,
            (SELECT COUNT(*)::int FROM class_members WHERE class_id = c.id) as member_count
     FROM classes c
     JOIN class_members cm ON cm.class_id = c.id AND cm.user_id = $1
     LEFT JOIN schools s ON s.id = c.school_id
     ORDER BY c.created_at DESC`,
    [userId],
  );
}

/** Get class detail (must be member or owner). */
export async function getClass(classId: string, userId: string): Promise<ClassInfo> {
  const cls = await queryOne<ClassInfo>(
    `SELECT c.id, c.name, c.description, c.join_code,
            s.name as school_name,
            cm.role,
            c.created_at,
            (SELECT COUNT(*)::int FROM class_members WHERE class_id = c.id) as member_count
     FROM classes c
     JOIN class_members cm ON cm.class_id = c.id AND cm.user_id = $2
     LEFT JOIN schools s ON s.id = c.school_id
     WHERE c.id = $1`,
    [classId, userId],
  );
  if (!cls) throw new AppError(404, 'Class not found');
  return cls;
}

/** Join a class by code. */
export async function joinClass(
  userId: string,
  joinCode: string,
  botId?: string,
): Promise<ClassInfo> {
  const cls = await queryOne<{ id: string; max_members: number }>(
    'SELECT id, max_members FROM classes WHERE join_code = $1',
    [joinCode.toUpperCase()],
  );
  if (!cls) throw new AppError(404, 'Invalid join code');

  // Check not already a member
  const existing = await queryOne(
    'SELECT id FROM class_members WHERE class_id = $1 AND user_id = $2',
    [cls.id, userId],
  );
  if (existing) throw new AppError(409, 'Already a member of this class');

  // Check member limit
  const countResult = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM class_members WHERE class_id = $1',
    [cls.id],
  );
  if ((countResult?.count || 0) >= cls.max_members) {
    throw new AppError(400, 'Class is full');
  }

  // Verify bot ownership if provided
  if (botId) {
    const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
    if (!bot) throw new AppError(400, 'Invalid bot');
  }

  await query(
    `INSERT INTO class_members (class_id, user_id, bot_id, role) VALUES ($1, $2, $3, 'student')`,
    [cls.id, userId, botId || null],
  );

  // Fire-and-forget notification
  const classInfo = await queryOne<{ name: string }>('SELECT name FROM classes WHERE id = $1', [cls.id]);
  notifyClassJoined(userId, classInfo?.name || 'a class', cls.id);

  return getClass(cls.id, userId);
}

/** Leave a class. */
export async function leaveClass(userId: string, classId: string): Promise<void> {
  // Check if owner — owners can't leave, they must delete
  const cls = await queryOne<{ owner_id: string }>('SELECT owner_id FROM classes WHERE id = $1', [classId]);
  if (!cls) throw new AppError(404, 'Class not found');
  if (cls.owner_id === userId) throw new AppError(400, 'Class owner cannot leave. Delete the class instead.');

  const result = await query(
    'DELETE FROM class_members WHERE class_id = $1 AND user_id = $2',
    [classId, userId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'Not a member of this class');
}

/** Delete a class (owner only). */
export async function deleteClass(userId: string, classId: string): Promise<void> {
  const result = await query(
    'DELETE FROM classes WHERE id = $1 AND owner_id = $2',
    [classId, userId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'Class not found or not owner');

  logAudit({
    userId,
    action: 'class.delete',
    entityType: 'bot',
    entityId: classId,
  });
}

/** Update class settings (owner only). */
export async function updateClass(
  userId: string,
  classId: string,
  updates: Partial<{ name: string; description: string; settings: Record<string, unknown> }>,
): Promise<void> {
  const cls = await queryOne('SELECT id FROM classes WHERE id = $1 AND owner_id = $2', [classId, userId]);
  if (!cls) throw new AppError(404, 'Class not found or not owner');

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    if (updates.name.length < 2 || updates.name.length > 100) throw new AppError(400, 'Name must be 2–100 characters');
    sets.push(`name = $${idx++}`); params.push(updates.name);
  }
  if (updates.description !== undefined) { sets.push(`description = $${idx++}`); params.push(updates.description); }
  if (updates.settings !== undefined) { sets.push(`settings = $${idx++}`); params.push(JSON.stringify(updates.settings)); }

  if (sets.length === 0) return;

  sets.push(`updated_at = NOW()`);
  params.push(classId);
  await query(`UPDATE classes SET ${sets.join(', ')} WHERE id = $${idx++}`, params);
}

/** List class members with their bot summaries. */
export async function getClassMembers(classId: string, userId: string): Promise<ClassMember[]> {
  // Must be a member to view
  const member = await queryOne(
    'SELECT id FROM class_members WHERE class_id = $1 AND user_id = $2',
    [classId, userId],
  );
  if (!member) throw new AppError(404, 'Class not found');

  const rows = await queryRows<{
    user_id: string;
    display_name: string | null;
    role: string;
    joined_at: string;
    bot_id: string | null;
    bot_name: string | null;
    bot_status: string | null;
    bot_cached_credibility: number | null;
    bot_cached_grade: number | null;
    bot_cached_tier: number | null;
    bot_cycle_count: number | null;
    bot_avatar_config: Record<string, unknown> | null;
    bot_last_cycle_at: string | null;
    school_name: string | null;
  }>(
    `SELECT cm.user_id, u.display_name, cm.role, cm.joined_at,
            b.id as bot_id, b.name as bot_name, b.status as bot_status,
            b.cached_credibility as bot_cached_credibility,
            b.cached_grade as bot_cached_grade,
            b.cached_tier as bot_cached_tier,
            b.cycle_count as bot_cycle_count,
            b.avatar_config as bot_avatar_config,
            b.last_cycle_at as bot_last_cycle_at,
            s.name as school_name
     FROM class_members cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN bots b ON b.id = cm.bot_id
     LEFT JOIN schools s ON s.id = b.school_id
     WHERE cm.class_id = $1
     ORDER BY cm.role DESC, cm.joined_at`,
    [classId],
  );

  return rows.map((r): ClassMember => ({
    user_id: r.user_id,
    display_name: r.display_name,
    role: r.role,
    joined_at: r.joined_at,
    bot: r.bot_id ? {
      id: r.bot_id,
      name: r.bot_name!,
      avatar_config: r.bot_avatar_config as any || {},
      status: r.bot_status as any,
      cached_credibility: r.bot_cached_credibility,
      cached_grade: r.bot_cached_grade,
      cached_tier: r.bot_cached_tier,
      school_name: r.school_name,
      cycle_count: r.bot_cycle_count || 0,
      last_cycle_at: r.bot_last_cycle_at,
    } : null,
  }));
}

/** Remove a member from a class (owner only). */
export async function removeMember(classId: string, ownerId: string, targetUserId: string): Promise<void> {
  const cls = await queryOne('SELECT owner_id FROM classes WHERE id = $1', [classId]);
  if (!cls) throw new AppError(404, 'Class not found');
  if ((cls as any).owner_id !== ownerId) throw new AppError(403, 'Only the class owner can remove members');
  if (targetUserId === ownerId) throw new AppError(400, 'Cannot remove yourself');

  const result = await query(
    'DELETE FROM class_members WHERE class_id = $1 AND user_id = $2',
    [classId, targetUserId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'Member not found');
}

/** Update which bot a member has in the class. */
export async function updateMemberBot(classId: string, userId: string, botId: string | null): Promise<void> {
  if (botId) {
    const bot = await queryOne('SELECT id FROM bots WHERE id = $1 AND user_id = $2', [botId, userId]);
    if (!bot) throw new AppError(400, 'Invalid bot');
  }

  const result = await query(
    'UPDATE class_members SET bot_id = $1 WHERE class_id = $2 AND user_id = $3',
    [botId, classId, userId],
  );
  if (result.rowCount === 0) throw new AppError(404, 'Not a member of this class');
}

/** Teacher dashboard — aggregate stats for the class. */
export async function getClassDashboard(classId: string, userId: string): Promise<ClassDashboard> {
  // Must be a teacher or owner
  const member = await queryOne<{ role: string }>(
    'SELECT role FROM class_members WHERE class_id = $1 AND user_id = $2',
    [classId, userId],
  );
  if (!member) throw new AppError(404, 'Class not found');
  if (member.role !== 'teacher') throw new AppError(403, 'Only teachers can view the dashboard');

  // Aggregate stats from class members' bots
  const stats = await queryOne<{
    member_count: number;
    avg_credibility: number | null;
    active_bots: number;
    total_cycles: number;
  }>(
    `SELECT
       COUNT(DISTINCT cm.user_id)::int as member_count,
       AVG(b.cached_credibility)::real as avg_credibility,
       COUNT(DISTINCT CASE WHEN b.status = 'running' THEN b.id END)::int as active_bots,
       COALESCE(SUM(b.cycle_count), 0)::int as total_cycles
     FROM class_members cm
     LEFT JOIN bots b ON b.id = cm.bot_id
     WHERE cm.class_id = $1`,
    [classId],
  );

  // Grade distribution
  const gradeRows = await queryRows<{ grade: number; count: number }>(
    `SELECT b.cached_grade as grade, COUNT(*)::int as count
     FROM class_members cm
     JOIN bots b ON b.id = cm.bot_id
     WHERE cm.class_id = $1 AND b.cached_grade IS NOT NULL
     GROUP BY b.cached_grade
     ORDER BY b.cached_grade`,
    [classId],
  );
  const gradeDistribution: Record<number, number> = {};
  for (const row of gradeRows) {
    gradeDistribution[row.grade] = row.count;
  }

  // Top performers (by credibility)
  const topPerformers = await queryRows<{ display_name: string; bot_name: string; credibility: number }>(
    `SELECT u.display_name, b.name as bot_name, b.cached_credibility as credibility
     FROM class_members cm
     JOIN users u ON u.id = cm.user_id
     JOIN bots b ON b.id = cm.bot_id
     WHERE cm.class_id = $1 AND b.cached_credibility IS NOT NULL
     ORDER BY b.cached_credibility DESC
     LIMIT 5`,
    [classId],
  );

  // Recent milestones (from activity log of class members' bots)
  const milestones = await queryRows<{
    display_name: string; bot_name: string; headline: string; created_at: string;
  }>(
    `SELECT u.display_name, b.name as bot_name,
            (al.translated->>'headline') as headline,
            al.created_at
     FROM class_members cm
     JOIN bots b ON b.id = cm.bot_id
     JOIN users u ON u.id = cm.user_id
     JOIN activity_log al ON al.bot_id = b.id AND al.deleted_at IS NULL
     WHERE cm.class_id = $1
       AND (al.translated->>'mood') = 'milestone'
     ORDER BY al.created_at DESC
     LIMIT 10`,
    [classId],
  );

  return {
    member_count: stats?.member_count || 0,
    avg_credibility: stats?.avg_credibility || null,
    grade_distribution: gradeDistribution,
    active_bots: stats?.active_bots || 0,
    total_cycles: stats?.total_cycles || 0,
    top_performers: topPerformers.map(p => ({
      display_name: p.display_name || 'Anonymous',
      bot_name: p.bot_name,
      credibility: p.credibility,
    })),
    recent_milestones: milestones.map(m => ({
      display_name: m.display_name || 'Anonymous',
      bot_name: m.bot_name,
      event: m.headline,
      timestamp: m.created_at,
    })),
  };
}
