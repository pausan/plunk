// IMPORTANT: this file runs before each test file's imports execute.
// We rewrite DATABASE_URL and REDIS_URL here so per-worker isolation is
// applied before any service module constructs a Prisma/Redis client.

import dotenv from 'dotenv';
import path from 'path';
import {afterAll, afterEach, beforeAll, vi} from 'vitest';

dotenv.config({path: path.resolve(__dirname, '../.env')});

// Vitest assigns each worker a 1-based pool id; defaults to "1" for single-worker runs.
const workerId = process.env.VITEST_POOL_ID || '1';

if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  const baseDb = url.pathname.replace(/^\//, '') || 'plunk_test';
  url.pathname = `/${baseDb}_w${workerId}`;
  process.env.DATABASE_URL = url.toString();
  // Mirror onto DIRECT_DATABASE_URL so prisma migrate uses the same worker DB.
  if (process.env.DIRECT_DATABASE_URL) {
    const direct = new URL(process.env.DIRECT_DATABASE_URL);
    direct.pathname = `/${baseDb}_w${workerId}`;
    process.env.DIRECT_DATABASE_URL = direct.toString();
  }
}

if (process.env.REDIS_URL) {
  const url = new URL(process.env.REDIS_URL);
  url.pathname = `/${(parseInt(workerId, 10) - 1) % 16}`;
  process.env.REDIS_URL = url.toString();
}

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing';
// Fixed, non-secret 32-byte keys for the SMTP sending-provider tests — the
// "PREVIOUS" one is distinct on purpose so key-rotation fallback can be tested.
process.env.SMTP_CREDENTIALS_ENCRYPTION_KEY =
  process.env.SMTP_CREDENTIALS_ENCRYPTION_KEY || '9OutLY+mIIlbpqgCyhrRn7+o0GMoFOODkbGr/JEqtbw=';
process.env.SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS =
  process.env.SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS || 'rWVEIGPrkAEeVUz25kTIQOH4e6cFqY0dT+vYojZbSSE=';
process.env.TRACKING_SIGNING_SECRET = process.env.TRACKING_SIGNING_SECRET || 'test-tracking-signing-secret';

// Static import is safe: database.ts only reads env in initialize(), which runs
// in beforeAll — well after the env mutations above.
import {testDatabase} from './helpers/database';

beforeAll(async () => {
  await testDatabase.initialize();
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  await testDatabase.cleanup();
});

afterAll(async () => {
  await testDatabase.disconnect();
});
