// =============================================================================
// Class routes — education group management
// Teachers create classes, students join with codes, dashboard for monitoring.
// =============================================================================

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { userRateLimit } from '../middleware/rate-limit';
import * as classService from '../services/class.service';

const router = Router();
router.use(requireAuth);

// List my classes (owned + joined)
router.get('/', userRateLimit('read'), async (req: Request, res: Response) => {
  const classes = await classService.getUserClasses(req.user!.userId);
  res.json(classes);
});

// Create a class
router.post('/', userRateLimit('write'), async (req: Request, res: Response) => {
  const { name, description, school_id } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  const cls = await classService.createClass(req.user!.userId, name, description, school_id);
  res.status(201).json(cls);
});

// Join a class by code
router.post('/join', userRateLimit('write'), async (req: Request, res: Response) => {
  const { join_code, bot_id } = req.body;
  if (!join_code) {
    res.status(400).json({ error: 'join_code required' });
    return;
  }
  const cls = await classService.joinClass(req.user!.userId, join_code, bot_id);
  res.json(cls);
});

// Get class detail
router.get('/:id', userRateLimit('read'), async (req: Request, res: Response) => {
  const cls = await classService.getClass(req.params.id, req.user!.userId);
  res.json(cls);
});

// Update class settings
router.patch('/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  const { name, description, settings } = req.body;
  await classService.updateClass(req.user!.userId, req.params.id, { name, description, settings });
  res.json({ success: true });
});

// Delete class (owner only)
router.delete('/:id', userRateLimit('write'), async (req: Request, res: Response) => {
  await classService.deleteClass(req.user!.userId, req.params.id);
  res.json({ success: true });
});

// Leave a class
router.post('/:id/leave', userRateLimit('write'), async (req: Request, res: Response) => {
  await classService.leaveClass(req.user!.userId, req.params.id);
  res.json({ success: true });
});

// List class members
router.get('/:id/members', userRateLimit('read'), async (req: Request, res: Response) => {
  const members = await classService.getClassMembers(req.params.id, req.user!.userId);
  res.json(members);
});

// Remove a member (owner only)
router.delete('/:id/members/:userId', userRateLimit('write'), async (req: Request, res: Response) => {
  await classService.removeMember(req.params.id, req.user!.userId, req.params.userId);
  res.json({ success: true });
});

// Update which bot is enrolled in the class
router.patch('/:id/bot', userRateLimit('write'), async (req: Request, res: Response) => {
  const { bot_id } = req.body;
  await classService.updateMemberBot(req.params.id, req.user!.userId, bot_id || null);
  res.json({ success: true });
});

// Teacher dashboard
router.get('/:id/dashboard', userRateLimit('read'), async (req: Request, res: Response) => {
  const dashboard = await classService.getClassDashboard(req.params.id, req.user!.userId);
  res.json(dashboard);
});

export default router;
