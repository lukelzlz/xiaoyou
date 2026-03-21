/**
 * 安全服务
 * 
 * 实现认证、授权、数据加密和审计功能
 */
import crypto from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import { config } from '../config/index.js';

const log = createChildLogger('security');

// ============ 配置 ============

const SECURITY_CONFIG = {
  // AES-256-GCM 加密配置
  encryption: {
    algorithm: 'aes-256-gcm',
    ivLength: 12,
    authTagLength: 16,
    // 安全获取加密密钥：生产环境必须设置，开发环境允许使用临时密钥
    key: (() => {
      const key = process.env.ENCRYPTION_KEY;
      if (!key) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('ENCRYPTION_KEY environment variable is required in production');
        }
        log.warn('ENCRYPTION_KEY not set, using ephemeral key - encrypted data will be lost on restart');
        return crypto.randomBytes(32).toString('hex');
      }
      return key;
    })(),
  },
  // Token 配置
  token: {
    accessTokenExpiry: 3600, // 1小时
    refreshTokenExpiry: 86400 * 7, // 7天
    issuer: 'xiaoyou',
  },
  // 审计日志保留天数
  auditRetentionDays: 90,
};

// ============ 类型定义 ============

export interface User {
  id: string;
  roles: string[];
  permissions: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AuditLog {
  id: string;
  timestamp: Date;
  userId: string;
  action: string;
  resource: string;
  result: 'success' | 'failure';
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

// ============ 认证服务 ============

export class AuthenticationService {
  private tokenCache = new Map<string, { userId: string; expiresAt: number }>();

  /**
   * 验证用户身份
   * @param userId 用户ID
   * @param token 访问令牌
   * @returns 验证是否成功
   */
  async authenticate(userId: string, token: string): Promise<boolean> {
    try {
      // 解析并验证 JWT token
      const decoded = this.verifyToken(token);
      
      if (decoded.userId !== userId) {
        log.warn({ userId, tokenUserId: decoded.userId }, 'Token 用户ID不匹配');
        return false;
      }

      // 检查 token 是否在缓存中（未被撤销）
      const cached = this.tokenCache.get(token);
      if (cached) {
        // Token 在缓存中，检查是否过期
        if (cached.expiresAt < Date.now()) {
          log.warn({ userId }, 'Token 已过期');
          return false;
        }
        // Token 有效且在缓存中
        return true;
      }

      // Token 不在缓存中（可能是服务重启后），需要重新验证并添加到缓存
      // verifyToken 已经验证了签名和过期时间，这里重新添加到缓存
      const expiresAt = decoded.exp ? decoded.exp * 1000 : Date.now() + SECURITY_CONFIG.token.accessTokenExpiry * 1000;
      this.tokenCache.set(token, {
        userId: decoded.userId,
        expiresAt,
      });

      return true;
    } catch (error) {
      log.warn({ error, userId }, '认证失败');
      return false;
    }
  }

  /**
   * 生成访问令牌
   * @param userId 用户ID
   * @param roles 用户角色
   * @returns 认证令牌
   */
  async generateToken(userId: string, roles: string[] = []): Promise<AuthToken> {
    const accessToken = this.createJWT({
      userId,
      roles,
      type: 'access',
      exp: Math.floor(Date.now() / 1000) + SECURITY_CONFIG.token.accessTokenExpiry,
      iat: Math.floor(Date.now() / 1000),
      iss: SECURITY_CONFIG.token.issuer,
    });

    const refreshToken = this.createJWT({
      userId,
      type: 'refresh',
      exp: Math.floor(Date.now() / 1000) + SECURITY_CONFIG.token.refreshTokenExpiry,
      iat: Math.floor(Date.now() / 1000),
      iss: SECURITY_CONFIG.token.issuer,
    });

    // 缓存 token
    this.tokenCache.set(accessToken, {
      userId,
      expiresAt: Date.now() + SECURITY_CONFIG.token.accessTokenExpiry * 1000,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: SECURITY_CONFIG.token.accessTokenExpiry,
      tokenType: 'Bearer',
    };
  }

  /**
   * 刷新访问令牌
   * @param refreshToken 刷新令牌
   * @returns 新的认证令牌
   */
  async refreshToken(refreshToken: string): Promise<AuthToken> {
    const decoded = this.verifyToken(refreshToken);
    
    if (decoded.type !== 'refresh') {
      throw new XiaoyouError(ErrorCode.UNAUTHORIZED, '无效的刷新令牌');
    }

    return this.generateToken(decoded.userId, decoded.roles || []);
  }

  /**
   * 撤销令牌
   * @param token 访问令牌
   */
  async revokeToken(token: string): Promise<void> {
    this.tokenCache.delete(token);
    log.info('令牌已撤销');
  }

  /**
   * 创建 JWT token
   */
  private createJWT(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', SECURITY_CONFIG.encryption.key)
      .update(`${header}.${body}`)
      .digest('base64url');
    
    return `${header}.${body}.${signature}`;
  }

  /**
   * 验证 JWT token（公开方法，供 WebSocket 认证使用)
   * 注意: 此方法不需要 async，因为内部没有任何 await 操作。
   */
  verifyToken(token: string): Record<string, any> {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new XiaoyouError(ErrorCode.UNAUTHORIZED, '无效的令牌格式');
    }

    const [header, body, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', SECURITY_CONFIG.encryption.key)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (signature !== expectedSignature) {
      throw new XiaoyouError(ErrorCode.UNAUTHORIZED, '令牌签名无效');
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new XiaoyouError(ErrorCode.UNAUTHORIZED, '令牌已过期');
    }

    return payload;
  }
}

// ============ 授权服务 ============

// 默认权限配置
const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  user: ['chat:*', 'tool:read', 'task:create', 'task:read', 'schedule:create', 'schedule:read'],
  guest: ['chat:read', 'tool:read'],
};

export class AuthorizationService {
  private rolePermissions: Map<string, Set<string>>;

  constructor() {
    this.rolePermissions = new Map();
    for (const [role, permissions] of Object.entries(DEFAULT_PERMISSIONS)) {
      this.rolePermissions.set(role, new Set(permissions));
    }
  }

  /**
   * 检查权限
   * @param userId 用户ID
   * @param action 操作
   * @param resource 资源
   * @returns 是否有权限
   */
  async authorize(userId: string, action: string, resource: string): Promise<boolean> {
    // 获取用户角色（实际应从数据库获取）
    const roles = await this.getUserRoles(userId);
    
    // 检查每个角色的权限
    for (const role of roles) {
      const permissions = this.rolePermissions.get(role);
      if (!permissions) continue;

      // 检查通配符权限
      if (permissions.has('*')) {
        return true;
      }

      // 检查具体权限
      const permission = `${action}:${resource}`;
      if (permissions.has(permission)) {
        return true;
      }

      // 检查资源通配符
      const resourceWildcard = `${action}:*`;
      if (permissions.has(resourceWildcard)) {
        return true;
      }
    }

    log.warn({ userId, action, resource }, '权限检查失败');
    return false;
  }

  /**
   * 敏感操作确认
   * @param userId 用户ID
   * @param action 操作
   * @returns 是否需要确认
   */
  async requireConfirmation(userId: string, action: string): Promise<boolean> {
    // 敏感操作列表
    const sensitiveActions = [
      'task:delete',
      'schedule:delete',
      'user:delete',
      'config:update',
    ];

    return sensitiveActions.includes(action);
  }

  /**
   * 授予角色权限
   * @param role 角色
   * @param permissions 权限列表
   */
  grantPermissions(role: string, permissions: string[]): void {
    const current = this.rolePermissions.get(role) || new Set();
    for (const perm of permissions) {
      current.add(perm);
    }
    this.rolePermissions.set(role, current);
    log.info({ role, permissions }, '权限已授予');
  }

  /**
   * 撤销角色权限
   * @param role 角色
   * @param permissions 权限列表
   */
  revokePermissions(role: string, permissions: string[]): void {
    const current = this.rolePermissions.get(role);
    if (current) {
      for (const perm of permissions) {
        current.delete(perm);
      }
      log.info({ role, permissions }, '权限已撤销');
    }
  }

  /**
   * 获取用户角色
   */
  private async getUserRoles(userId: string): Promise<string[]> {
    // 实际应从数据库获取
    // 默认返回 user 角色
    return ['user'];
  }
}

// ============ 数据安全服务 ============

export class DataSecurityService {
  private encryptionKey: Buffer;

  constructor() {
    // 从配置获取加密密钥，确保是 32 字节
    const keyHex = SECURITY_CONFIG.encryption.key;
    if (keyHex.length === 64) {
      this.encryptionKey = Buffer.from(keyHex, 'hex');
    } else {
      // 派生密钥
      this.encryptionKey = crypto.createHash('sha256').update(keyHex).digest();
    }
  }

  /**
   * 敏感数据加密
   * @param data 明文数据
   * @returns 加密后的数据（base64）
   */
  encrypt(data: string): string {
    const iv = crypto.randomBytes(SECURITY_CONFIG.encryption.ivLength);
    const cipher = crypto.createCipheriv(
      SECURITY_CONFIG.encryption.algorithm,
      this.encryptionKey,
      iv,
      { authTagLength: SECURITY_CONFIG.encryption.authTagLength }
    );

    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // 返回格式: iv:authTag:encrypted
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  }

  /**
   * 敏感数据解密
   * @param encrypted 加密数据
   * @returns 解密后的明文
   */
  decrypt(encrypted: string): string {
    const [ivBase64, authTagBase64, data] = encrypted.split(':');
    
    if (!ivBase64 || !authTagBase64 || !data) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '无效的加密数据格式');
    }

    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = crypto.createDecipheriv(
      SECURITY_CONFIG.encryption.algorithm,
      this.encryptionKey,
      iv,
      { authTagLength: SECURITY_CONFIG.encryption.authTagLength }
    );

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * 数据脱敏
   * @param data 原始数据
   * @param type 数据类型
   * @returns 脱敏后的数据
   */
  mask(data: string, type: 'email' | 'phone' | 'idcard' | 'bankcard' | 'default'): string {
    switch (type) {
      case 'email': {
        const [local, domain] = data.split('@');
        if (!domain) return this.maskDefault(data);
        const maskedLocal = local.length > 2 
          ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1]
          : '*'.repeat(local.length);
        return `${maskedLocal}@${domain}`;
      }

      case 'phone': {
        if (data.length !== 11) return this.maskDefault(data);
        return data.slice(0, 3) + '****' + data.slice(-4);
      }

      case 'idcard': {
        if (data.length < 8) return this.maskDefault(data);
        return data.slice(0, 4) + '*'.repeat(data.length - 8) + data.slice(-4);
      }

      case 'bankcard': {
        if (data.length < 8) return this.maskDefault(data);
        return data.slice(0, 4) + '*'.repeat(data.length - 8) + data.slice(-4);
      }

      default:
        return this.maskDefault(data);
    }
  }

  private maskDefault(data: string): string {
    if (data.length <= 2) return '*'.repeat(data.length);
    if (data.length <= 6) return data[0] + '*'.repeat(data.length - 2) + data[data.length - 1];
    return data.slice(0, 2) + '*'.repeat(data.length - 4) + data.slice(-2);
  }

  /**
   * 访问审计
   * @param userId 用户ID
   * @param action 操作
   * @param resource 资源
   */
  audit(userId: string, action: string, resource: string): void {
    const auditLog: AuditLog = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      userId,
      action,
      resource,
      result: 'success',
    };

    // 记录审计日志
    log.info({ auditLog }, '审计日志');

    // 实际应存储到数据库
    this.storeAuditLog(auditLog);
  }

  /**
   * 存储审计日志
   */
  private storeAuditLog(log: AuditLog): void {
    // 实际应存储到数据库
    // 这里只是占位实现
  }
}

// ============ 导出单例 ============

export const authenticationService = new AuthenticationService();
export const authorizationService = new AuthorizationService();
export const dataSecurityService = new DataSecurityService();

// ============ 安全服务统一接口 ============

export interface SecurityService {
  authenticate(userId: string, token: string): Promise<boolean>;
  authorize(userId: string, action: string, resource: string): Promise<boolean>;
  requireConfirmation(userId: string, action: string): Promise<boolean>;
}

export class SecurityServiceImpl implements SecurityService {
  private auth = authenticationService;
  private authz = authorizationService;

  async authenticate(userId: string, token: string): Promise<boolean> {
    return this.auth.authenticate(userId, token);
  }

  async authorize(userId: string, action: string, resource: string): Promise<boolean> {
    return this.authz.authorize(userId, action, resource);
  }

  async requireConfirmation(userId: string, action: string): Promise<boolean> {
    return this.authz.requireConfirmation(userId, action);
  }
}

export const securityService = new SecurityServiceImpl();
