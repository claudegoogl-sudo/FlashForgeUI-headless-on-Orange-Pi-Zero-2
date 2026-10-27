/**
 * @fileoverview Tests for login sessions that survive a restart, and for the login
 * rate limiter that only counts failed attempts.
 */
import { EventEmitter } from 'node:events';
import { promises as fsp, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

const config = { WebUIPassword: 'galvopi', WebUIPasswordRequired: true };

jest.mock('../../managers/ConfigManager', () => ({
  getConfigManager: () => ({ getConfig: () => config }),
}));

import { AuthManager } from './AuthManager';
import { createLoginRateLimiter } from './auth-middleware';

describe('AuthManager session persistence', () => {
  let dir: string;
  let file: string;
  const managers: AuthManager[] = [];
  const make = () => {
    const manager = new AuthManager(file);
    managers.push(manager);
    return manager;
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-auth-'));
    file = path.join(dir, 'data', 'sessions.json');
    config.WebUIPassword = 'galvopi';
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    jest.useRealTimers();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const login = async (manager: AuthManager, rememberMe: boolean) => {
    const result = await manager.validateLogin({ password: 'galvopi', rememberMe });
    expect(result.success).toBe(true);
    return result.token as string;
  };

  it('keeps a login valid across a restart', async () => {
    const first = make();
    const token = await login(first, true);
    expect(first.validateToken(token).isValid).toBe(true);
    first.dispose(); // what shutdown does

    const second = make(); // new process
    expect(second.validateToken(token).isValid).toBe(true);
    expect(second.getActiveSessionCount()).toBe(1);
  });

  it('writes the file with owner-only permissions', async () => {
    await login(make(), true);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const stored = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      version: number;
      sessions: unknown[];
    };
    expect(stored).toMatchObject({ version: 1 });
    expect(stored.sessions).toHaveLength(1);
  });

  it('remembers for 30 days, otherwise one hour', async () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 27, 12, 0, 0) });
    const manager = make();
    const remembered = await login(manager, true);
    const temporary = await login(manager, false);

    jest.setSystemTime(new Date(2026, 9, 27, 13, 30, 0)); // 1.5 h later
    expect(manager.validateToken(temporary).isValid).toBe(false);
    expect(manager.validateToken(remembered).isValid).toBe(true);

    jest.setSystemTime(new Date(2026, 10, 20, 12, 0, 0)); // 24 days later
    expect(manager.validateToken(remembered).isValid).toBe(true);
    jest.setSystemTime(new Date(2026, 10, 28, 12, 0, 0)); // 32 days later
    expect(manager.validateToken(remembered).isValid).toBe(false);
  });

  it('does not bring back expired, revoked or password-invalidated sessions', async () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 27, 12, 0, 0) });
    const first = make();
    const expiring = await login(first, false);
    const revoked = await login(first, true);
    const kept = await login(first, true);
    first.revokeToken(revoked);
    first.dispose();

    jest.setSystemTime(new Date(2026, 9, 27, 14, 0, 0));
    const second = make();
    expect(second.validateToken(expiring).isValid).toBe(false);
    expect(second.validateToken(revoked).isValid).toBe(false);
    expect(second.validateToken(kept).isValid).toBe(true);
    second.dispose();

    config.WebUIPassword = 'changed'; // changing the password signs everyone out
    expect(make().validateToken(kept).isValid).toBe(false);
  });

  it('ignores a corrupt or hostile file and rejects a forged token', async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, '{ nope');
    const manager = make();
    expect(manager.getActiveSessionCount()).toBe(0);
    expect((await login(manager, true)).length).toBeGreaterThan(20);

    await fsp.writeFile(
      file,
      JSON.stringify({ sessions: [{ sessionId: 1 }, null, { sessionId: 'x', token: 't' }] })
    );
    const third = make();
    expect(third.getActiveSessionCount()).toBe(0);
    expect(third.validateToken('abc.def').isValid).toBe(false);
  });

  it('can run without a file', async () => {
    const manager = new AuthManager(null);
    managers.push(manager);
    const token = await login(manager, true);
    expect(manager.validateToken(token).isValid).toBe(true);
  });
});

describe('login rate limiter', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 27, 15, 0, 0) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Runs one request through the limiter; the handler answers with `outcome`. */
  const attempt = (
    limiter: ReturnType<typeof createLoginRateLimiter>,
    ip: string,
    outcome: 200 | 401
  ) => {
    class FakeResponse extends EventEmitter {
      statusCode = 200;
      status(code: number) {
        this.statusCode = code;
        return this;
      }
      json() {
        this.emit('finish');
        return this;
      }
    }
    const res = new FakeResponse();
    let passed = false;
    const next: NextFunction = () => {
      passed = true;
      res.statusCode = outcome;
      res.emit('finish');
    };
    limiter({ ip } as Request, res as unknown as Response, next);
    return { passed, status: res.statusCode };
  };

  it('lets the owner log in as often as needed from many devices', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 40; i++) {
      expect(attempt(limiter, '192.168.2.78', 200).passed).toBe(true);
    }
  });

  it('locks an address out after 5 failed attempts, even with the right password', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 5; i++) expect(attempt(limiter, '10.0.0.9', 401).passed).toBe(true);
    const blocked = attempt(limiter, '10.0.0.9', 200);
    expect(blocked.passed).toBe(false);
    expect(blocked.status).toBe(429);
    expect(attempt(limiter, '10.0.0.8', 200).passed).toBe(true); // other addresses are unaffected
  });

  it('counts only failures, and the lockout ends 15 minutes after the first one', () => {
    const limiter = createLoginRateLimiter();
    attempt(limiter, '10.0.0.9', 401);
    attempt(limiter, '10.0.0.9', 200); // success gives its attempt back
    for (let i = 0; i < 3; i++) attempt(limiter, '10.0.0.9', 401);
    expect(attempt(limiter, '10.0.0.9', 401).passed).toBe(true); // 5th failure
    expect(attempt(limiter, '10.0.0.9', 200).passed).toBe(false);

    jest.setSystemTime(new Date(2026, 9, 27, 15, 14, 0));
    expect(attempt(limiter, '10.0.0.9', 200).passed).toBe(false);
    jest.setSystemTime(new Date(2026, 9, 27, 15, 16, 0));
    expect(attempt(limiter, '10.0.0.9', 200).passed).toBe(true);
  });
});
