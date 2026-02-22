import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionLogger, sanitizeLogData } from '../sessionLogger';

describe('sanitizeLogData', () => {
  it('redacts sensitive keys recursively', () => {
    const sanitized = sanitizeLogData({
      token: 'abc',
      nested: {
        authorization: 'Bearer secret',
        safe: 'value',
      },
      list: [
        { apiKey: 'k1', keep: 'ok' },
      ],
    });

    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.nested.authorization).toBe('[REDACTED]');
    expect(sanitized.nested.safe).toBe('value');
    expect(sanitized.list[0].apiKey).toBe('[REDACTED]');
    expect(sanitized.list[0].keep).toBe('ok');
  });
});

describe('SessionLogger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logger-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores sanitized request payloads in logs', () => {
    const logger = new SessionLogger('session-1', tempDir);
    logger.info('HTTP', 'request', {
      query: {
        q: 'find jank',
        authToken: 'top-secret',
      },
      headers: {
        authorization: 'Bearer 123',
        'user-agent': 'jest',
      },
    });

    const entries = logger.readLogs();
    const requestLog = entries.find((entry) => entry.component === 'HTTP' && entry.message === 'request');

    expect(requestLog).toBeDefined();
    expect((requestLog!.data as any).query.q).toBe('find jank');
    expect((requestLog!.data as any).query.authToken).toBe('[REDACTED]');
    expect((requestLog!.data as any).headers.authorization).toBe('[REDACTED]');
  });
});
