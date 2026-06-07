#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const stdin = readFileSync(0, 'utf-8');
if (process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE) {
  appendFileSync(
    process.env.OPENCLAW_FAKE_CLI_CAPTURE_FILE,
    `${JSON.stringify({ argv: process.argv.slice(2), stdin })}\n`,
    'utf-8',
  );
}

const sessionId = process.env.OPENCLAW_FAKE_CLI_SESSION_ID ?? 'fake-cli-session';
process.stdout.write(`${JSON.stringify({ type: 'text', text: 'fake cli answer' })}\n`);
process.stdout.write(`${JSON.stringify({ session_id: sessionId })}\n`);
