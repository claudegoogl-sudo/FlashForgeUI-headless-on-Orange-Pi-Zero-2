/**
 * @fileoverview Authentication manager for WebUI providing password validation and session token management.
 *
 * Manages all aspects of WebUI authentication including password validation against configured
 * credentials, secure JWT-style token generation with HMAC signatures, session lifecycle tracking,
 * and automatic session cleanup. Supports both persistent (24-hour) and temporary (1-hour) sessions
 * based on "remember me" preferences. Tokens are cryptographically signed using SHA-256 HMAC with
 * a secret derived from the WebUI password, preventing tampering and ensuring secure authentication.
 * Integrates with ConfigManager for password storage and provides session management including
 * token revocation, activity tracking, and automatic expiration cleanup.
 *
 * Key exports:
 * - AuthManager class: Main authentication service with singleton pattern
 * - getAuthManager(): Singleton accessor function
 * - Session management: validateLogin, validateToken, revokeToken, getActiveSessionCount
 * - Token utilities: extractTokenFromHeader, getAuthStatus
 * - Cleanup: Automatic session expiration every 5 minutes, manual clearAllSessions
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'crypto';
import { getConfigManager } from '../../managers/ConfigManager';
import { getDataPath } from '../../utils/setup';
import { validateAuthToken } from '../schemas/web-api.schemas';
import type {
  WebUIAuthStatus,
  WebUILoginRequest,
  WebUILoginResponse,
} from '../types/web-api.types';

/**
 * Token payload structure
 */
interface TokenPayload {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly persistent: boolean;
}

/**
 * Stored session information
 */
interface SessionInfo {
  readonly token: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  lastActivity: Date; // Mutable for updates
  readonly persistent: boolean;
}

/** Session as written to <data dir>/sessions.json */
interface StoredSession {
  readonly sessionId: string;
  readonly token: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly persistent: boolean;
}

/** "Remember me" sessions last this long (30 days); others last one hour. */
const REMEMBERED_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function defaultSessionsFile(): string | null {
  if (process.env.NODE_ENV === 'test') return null; // tests must not write into ./data
  try {
    return path.join(getDataPath(), 'sessions.json');
  } catch {
    return null;
  }
}

/**
 * Authentication manager for web UI
 *
 * Sessions are kept in memory and mirrored to <data dir>/sessions.json (mode 600), so
 * a restart or an update of the server no longer logs everyone out. A stored session is
 * only honoured while its token still verifies against the current password.
 */
export class AuthManager {
  private readonly configManager = getConfigManager();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly sessionTimeout = REMEMBERED_SESSION_MS; // 30 days for "remember me"
  private readonly tempSessionTimeout = 60 * 60 * 1000; // 1 hour for temporary
  private cleanupInterval: NodeJS.Timeout | null = null;

  private readonly sessionsFile: string | null;

  /**
   * @param sessionsFile file mirroring the sessions; null disables persistence
   *                     (default: <data dir>/sessions.json, off under tests)
   */
  constructor(sessionsFile: string | null = defaultSessionsFile()) {
    this.sessionsFile = sessionsFile;
    this.loadSessions();
    this.startSessionCleanup();
  }

  private loadSessions(): void {
    if (!this.sessionsFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8')) as {
        sessions?: StoredSession[];
      };
      const now = Date.now();
      for (const stored of raw.sessions ?? []) {
        if (
          typeof stored?.sessionId !== 'string' ||
          typeof stored.token !== 'string' ||
          typeof stored.createdAt !== 'number' ||
          typeof stored.expiresAt !== 'number' ||
          stored.expiresAt <= now
        ) {
          continue;
        }
        this.sessions.set(stored.sessionId, {
          token: stored.token,
          createdAt: new Date(stored.createdAt),
          expiresAt: new Date(stored.expiresAt),
          lastActivity: new Date(stored.createdAt),
          persistent: stored.persistent === true,
        });
      }
    } catch {
      // no file yet, or unreadable: start with no sessions
    }
  }

  private saveSessions(): void {
    if (!this.sessionsFile) return;
    try {
      const sessions: StoredSession[] = [];
      for (const [sessionId, info] of this.sessions.entries()) {
        sessions.push({
          sessionId,
          token: info.token,
          createdAt: info.createdAt.getTime(),
          expiresAt: info.expiresAt.getTime(),
          persistent: info.persistent,
        });
      }
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      const temporary = `${this.sessionsFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
      fs.renameSync(temporary, this.sessionsFile);
    } catch (error) {
      console.warn(
        '[Auth] Could not save sessions:',
        error instanceof Error ? error.message : error
      );
    }
  }

  /**
   * Validate login credentials and generate token
   */
  public async validateLogin(request: WebUILoginRequest): Promise<WebUILoginResponse> {
    if (!this.isAuthenticationRequired()) {
      return {
        success: false,
        message: 'Authentication is currently disabled',
      };
    }

    const config = this.configManager.getConfig();
    const serverPassword = config.WebUIPassword;

    if (request.password !== serverPassword) {
      return {
        success: false,
        message: 'Invalid password',
      };
    }

    const token = this.generateToken(request.rememberMe || false);

    return {
      success: true,
      token,
      message: 'Authentication successful',
    };
  }

  /**
   * Generate a secure session token
   */
  private generateToken(persistent: boolean): string {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const timeout = persistent ? this.sessionTimeout : this.tempSessionTimeout;
    const expiresAt = now + timeout;

    const payload: TokenPayload = {
      sessionId,
      createdAt: now,
      expiresAt,
      persistent,
    };

    const tokenData = Buffer.from(JSON.stringify(payload)).toString('base64');

    const secret = this.getTokenSecret();
    const signature = crypto.createHmac('sha256', secret).update(tokenData).digest('hex');

    const token = `${tokenData}.${signature}`;

    const sessionInfo: SessionInfo = {
      token,
      createdAt: new Date(now),
      expiresAt: new Date(expiresAt),
      lastActivity: new Date(now),
      persistent,
    };

    this.sessions.set(sessionId, sessionInfo);
    this.saveSessions();

    return token;
  }

  /**
   * Validate token and return validation result
   */
  public validateToken(token: string): { isValid: boolean; sessionId?: string } {
    if (!this.isAuthenticationRequired()) {
      return { isValid: true };
    }

    try {
      const validatedToken = validateAuthToken(token);
      if (!validatedToken) {
        return { isValid: false };
      }

      const parts = token.split('.');
      if (parts.length !== 2) {
        return { isValid: false };
      }

      const [tokenData, signature] = parts;

      const secret = this.getTokenSecret();
      const expectedSignature = crypto.createHmac('sha256', secret).update(tokenData).digest('hex');

      if (signature !== expectedSignature) {
        return { isValid: false };
      }

      const payload = JSON.parse(Buffer.from(tokenData, 'base64').toString()) as TokenPayload;

      if (payload.expiresAt < Date.now()) {
        this.sessions.delete(payload.sessionId);
        this.saveSessions();
        return { isValid: false };
      }

      const session = this.sessions.get(payload.sessionId);
      if (!session) {
        return { isValid: false };
      }

      session.lastActivity = new Date();

      return { isValid: true, sessionId: payload.sessionId };
    } catch {
      console.error('Token validation error');
      return { isValid: false };
    }
  }

  /**
   * Verify and decode a token
   */
  public verifyToken(token: string): boolean {
    if (!this.isAuthenticationRequired()) {
      return true;
    }

    try {
      const validatedToken = validateAuthToken(token);
      if (!validatedToken) {
        return false;
      }

      const parts = token.split('.');
      if (parts.length !== 2) {
        return false;
      }

      const [tokenData, signature] = parts;

      const secret = this.getTokenSecret();
      const expectedSignature = crypto.createHmac('sha256', secret).update(tokenData).digest('hex');

      if (signature !== expectedSignature) {
        return false;
      }

      const payload = JSON.parse(Buffer.from(tokenData, 'base64').toString()) as TokenPayload;

      if (payload.expiresAt < Date.now()) {
        this.sessions.delete(payload.sessionId);
        return false;
      }

      const session = this.sessions.get(payload.sessionId);
      if (!session) {
        return false;
      }

      session.lastActivity = new Date();

      return true;
    } catch {
      console.error('Token verification error');
      return false;
    }
  }

  /**
   * Extract token from Authorization header
   */
  public extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }

  /**
   * Get authentication status
   */
  public getAuthStatus(): WebUIAuthStatus {
    const config = this.configManager.getConfig();

    return {
      hasPassword: config.WebUIPasswordRequired && !!config.WebUIPassword,
      defaultPassword: config.WebUIPassword === 'changeme',
      authRequired: config.WebUIPasswordRequired,
    };
  }

  /**
   * Revoke a token
   */
  public revokeToken(token: string): void {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) return;

      const payload = JSON.parse(Buffer.from(parts[0], 'base64').toString()) as TokenPayload;

      this.sessions.delete(payload.sessionId);
      this.saveSessions();
    } catch {
      // Ignore errors during revocation
    }
  }

  /**
   * Get active session count
   */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions
   */
  public clearAllSessions(): void {
    this.sessions.clear();
    this.saveSessions();
  }

  /**
   * Get token secret based on configuration
   */
  private getTokenSecret(): string {
    const config = this.configManager.getConfig();
    return crypto
      .createHash('sha256')
      .update(config.WebUIPassword)
      .update('ffui-webui-2025')
      .digest('hex');
  }

  /**
   * Check if authentication is required based on configuration
   */
  public isAuthenticationRequired(): boolean {
    const config = this.configManager.getConfig();
    return config.WebUIPasswordRequired;
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startSessionCleanup(): void {
    this.cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        let removed = false;

        for (const [sessionId, session] of this.sessions.entries()) {
          if (session.expiresAt.getTime() < now) {
            this.sessions.delete(sessionId);
            removed = true;
          }
        }
        if (removed) this.saveSessions();
      },
      5 * 60 * 1000
    );
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }
}

let authManager: AuthManager | null = null;

export function getAuthManager(): AuthManager {
  if (!authManager) {
    authManager = new AuthManager();
  }
  return authManager;
}
