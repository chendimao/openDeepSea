import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WsServerEvent } from '../types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'opendeepsea-image-generation-jobs-')), 'test.db');

const { db } = await import('../db.js');

test('image generation schema creates provider job output and source tables', () => {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'image_provider_profiles',
        'image_generation_jobs',
        'image_generation_outputs',
        'image_generation_source_images'
      )
    ORDER BY name
  `).all() as Array<{ name: string }>;

  assert.deepEqual(tables.map((row) => row.name), [
    'image_generation_jobs',
    'image_generation_outputs',
    'image_generation_source_images',
    'image_provider_profiles',
  ]);
});

test('image generation websocket events are part of server event union', () => {
  const event: WsServerEvent = {
    type: 'image_job:updated',
    projectId: 'project-1',
    sessionId: 'session-1',
    roomId: null,
    job: {
      id: 'job-1',
      project_id: 'project-1',
      room_id: null,
      session_id: 'session-1',
      source_message_id: null,
      source_agent_id: null,
      source_task_id: null,
      provider_profile_id: 'profile-1',
      workflow: 'generate',
      prompt: 'apple',
      count: 1,
      quality: 'auto',
      size: 'auto',
      status: 'queued',
      message: null,
      error: null,
      created_at: 1,
      started_at: null,
      completed_at: null,
      updated_at: 1,
    },
  };

  assert.equal(event.type, 'image_job:updated');
});
