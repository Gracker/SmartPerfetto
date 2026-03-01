/**
 * SQL学习系统 - 从错误中学习并形成闭环
 *
 * 核心思想:
 * 1. 记录所有SQL错误
 * 2. 分析错误模式
 * 3. 自动生成修正规则
 * 4. 下次遇到相同错误时直接应用规则
 * 5. 持续学习和改进
 */

import fs from 'fs/promises';
import path from 'path';

// ============================================================================
// 类型定义
// ============================================================================

interface SQLError {
  id: string;
  timestamp: Date;
  originalSQL: string;
  errorType: string;
  errorMessage: string;
  userQuery: string;
  context?: any;
}

interface SQLFix {
  id: string;
  errorId: string;
  timestamp: Date;
  originalSQL: string;
  fixedSQL: string;
  fixMethod: 'auto' | 'manual' | 'learned';
  success: boolean;
  validationResult?: any;
}

interface FixRule {
  id: string;
  name: string;
  description: string;
  errorPattern: RegExp | string;
  fixPattern: string;
  replacement: string;
  confidence: number;  // 0-1, 成功率
  usageCount: number;
  successCount: number;
  createdAt: Date;
  lastUsedAt?: Date;
  examples: Array<{
    before: string;
    after: string;
  }>;
}

interface LearningStats {
  totalErrors: number;
  totalFixes: number;
  successRate: number;
  rulesCount: number;
  topErrors: Array<{ type: string; count: number }>;
  topRules: Array<{ name: string; successRate: number }>;
}

// ============================================================================
// 错误日志系统
// ============================================================================

class SQLErrorLog {
  private logFile: string;
  private errors: Map<string, SQLError>;

  constructor(logDir: string = './logs/sql_errors') {
    this.logFile = path.join(logDir, 'errors.json');
    this.errors = new Map();
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.logFile), { recursive: true });
      const data = await fs.readFile(this.logFile, 'utf-8');
      const errors = JSON.parse(data);
      errors.forEach((e: SQLError) => this.errors.set(e.id, e));
    } catch (error) {
      // 文件不存在，初始化为空
      await this.save();
    }
  }

  async logError(error: Omit<SQLError, 'id' | 'timestamp'>): Promise<string> {
    const id = this.generateId();
    const sqlError: SQLError = {
      id,
      timestamp: new Date(),
      ...error
    };

    this.errors.set(id, sqlError);
    await this.save();

    console.log(`[ErrorLog] 记录错误: ${id} - ${error.errorType}`);
    return id;
  }

  async save(): Promise<void> {
    const data = Array.from(this.errors.values());
    await fs.writeFile(this.logFile, JSON.stringify(data, null, 2));
  }

  getError(id: string): SQLError | undefined {
    return this.errors.get(id);
  }

  getErrorsByType(errorType: string): SQLError[] {
    return Array.from(this.errors.values())
      .filter(e => e.errorType === errorType);
  }

  getAllErrors(): SQLError[] {
    return Array.from(this.errors.values());
  }

  private generateId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// 修正日志系统
// ============================================================================

class SQLFixLog {
  private logFile: string;
  private fixes: Map<string, SQLFix>;

  constructor(logDir: string = './logs/sql_errors') {
    this.logFile = path.join(logDir, 'fixes.json');
    this.fixes = new Map();
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.logFile), { recursive: true });
      const data = await fs.readFile(this.logFile, 'utf-8');
      const fixes = JSON.parse(data);
      fixes.forEach((f: SQLFix) => this.fixes.set(f.id, f));
    } catch (error) {
      await this.save();
    }
  }

  async logFix(fix: Omit<SQLFix, 'id' | 'timestamp'>): Promise<string> {
    const id = this.generateId();
    const sqlFix: SQLFix = {
      id,
      timestamp: new Date(),
      ...fix
    };

    this.fixes.set(id, sqlFix);
    await this.save();

    console.log(`[FixLog] 记录修正: ${id} - ${fix.fixMethod} - ${fix.success ? '成功' : '失败'}`);
    return id;
  }

  async save(): Promise<void> {
    const data = Array.from(this.fixes.values());
    await fs.writeFile(this.logFile, JSON.stringify(data, null, 2));
  }

  getSuccessfulFixes(): SQLFix[] {
    return Array.from(this.fixes.values()).filter(f => f.success);
  }

  getFixesByErrorId(errorId: string): SQLFix[] {
    return Array.from(this.fixes.values())
      .filter(f => f.errorId === errorId);
  }

  private generateId(): string {
    return `fix_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// 修正规则引擎
// ============================================================================

class SQLFixRuleEngine {
  private rulesFile: string;
  private rules: Map<string, FixRule>;

  constructor(rulesDir: string = './logs/sql_errors') {
    this.rulesFile = path.join(rulesDir, 'fix_rules.json');
    this.rules = new Map();
    this.initDefaultRules();
  }

  async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.rulesFile), { recursive: true });
      const data = await fs.readFile(this.rulesFile, 'utf-8');
      const rules = JSON.parse(data);
      rules.forEach((r: any) => {
        // 如果是正则表达式字符串，转换回RegExp
        if (r.errorPattern.startsWith('/')) {
          const match = r.errorPattern.match(/^\/(.*)\/([gimuy]*)$/);
          if (match) {
            r.errorPattern = new RegExp(match[1], match[2]);
          }
        }
        this.rules.set(r.id, r);
      });
    } catch (error) {
      // 使用默认规则
      await this.save();
    }
  }

  private initDefaultRules(): void {
    // 默认修正规则
    const defaultRules: FixRule[] = [
      {
        id: 'rule_001',
        name: '修正表名_app_launch',
        description: '将错误的app_launch表名替换为slice',
        errorPattern: /FROM\s+app_launch/gi,
        fixPattern: 'FROM app_launch',
        replacement: 'FROM slice',
        confidence: 0.95,
        usageCount: 0,
        successCount: 0,
        createdAt: new Date(),
        examples: [
          {
            before: 'SELECT * FROM app_launch WHERE id = 1',
            after: 'SELECT * FROM slice WHERE id = 1'
          }
        ]
      },
      {
        id: 'rule_002',
        name: '添加时间单位转换_ts',
        description: '为timestamp添加单位转换',
        errorPattern: /SELECT\s+(\w+\.)?ts\s/gi,
        fixPattern: 'SELECT ts ',
        replacement: 'SELECT ts / 1e9 AS timestamp_s ',
        confidence: 0.85,
        usageCount: 0,
        successCount: 0,
        createdAt: new Date(),
        examples: [
          {
            before: 'SELECT ts FROM slice',
            after: 'SELECT ts / 1e9 AS timestamp_s FROM slice'
          }
        ]
      },
      {
        id: 'rule_003',
        name: '添加时间单位转换_dur',
        description: '为duration添加单位转换',
        errorPattern: /SELECT\s+(\w+\.)?dur\s/gi,
        fixPattern: 'SELECT dur ',
        replacement: 'SELECT dur / 1e6 AS duration_ms ',
        confidence: 0.85,
        usageCount: 0,
        successCount: 0,
        createdAt: new Date(),
        examples: [
          {
            before: 'SELECT dur FROM slice',
            after: 'SELECT dur / 1e6 AS duration_ms FROM slice'
          }
        ]
      },
      {
        id: 'rule_004',
        name: '修正counter表cpu字段',
        description: 'counter表没有cpu字段，应从counter_track.name提取',
        errorPattern: /SELECT\s+cpu\s+FROM\s+counter/gi,
        fixPattern: 'SELECT cpu FROM counter',
        replacement: 'SELECT CAST(SUBSTR(counter_track.name, 8) AS INT) AS cpu FROM counter JOIN counter_track ON counter.track_id = counter_track.id',
        confidence: 0.90,
        usageCount: 0,
        successCount: 0,
        createdAt: new Date(),
        examples: [
          {
            before: 'SELECT cpu FROM counter WHERE value > 1000',
            after: 'SELECT CAST(SUBSTR(counter_track.name, 8) AS INT) AS cpu FROM counter JOIN counter_track ON counter.track_id = counter_track.id WHERE value > 1000'
          }
        ]
      }
    ];

    defaultRules.forEach(rule => this.rules.set(rule.id, rule));
  }

  async save(): Promise<void> {
    const rulesArray = Array.from(this.rules.values()).map(r => ({
      ...r,
      errorPattern: r.errorPattern instanceof RegExp
        ? r.errorPattern.toString()
        : r.errorPattern
    }));
    await fs.writeFile(this.rulesFile, JSON.stringify(rulesArray, null, 2));
  }

  applyRules(sql: string): { fixed: string; appliedRules: string[] } {
    let fixed = sql;
    const appliedRules: string[] = [];

    // 按confidence排序，优先应用高置信度规则
    const sortedRules = Array.from(this.rules.values())
      .sort((a, b) => b.confidence - a.confidence);

    for (const rule of sortedRules) {
      const pattern = rule.errorPattern;
      if ((pattern instanceof RegExp && pattern.test(fixed)) ||
          (typeof pattern === 'string' && fixed.includes(pattern))) {

        const before = fixed;
        if (pattern instanceof RegExp) {
          fixed = fixed.replace(pattern, rule.replacement);
        } else {
          fixed = fixed.replace(new RegExp(rule.fixPattern, 'g'), rule.replacement);
        }

        if (before !== fixed) {
          appliedRules.push(rule.id);
          rule.usageCount++;
          rule.lastUsedAt = new Date();
          console.log(`[FixRule] 应用规则: ${rule.name}`);
        }
      }
    }

    return { fixed, appliedRules };
  }

  async recordSuccess(ruleId: string): Promise<void> {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.successCount++;
      rule.confidence = rule.successCount / rule.usageCount;
      await this.save();
    }
  }

  async addRule(rule: Omit<FixRule, 'id' | 'usageCount' | 'successCount' | 'createdAt'>): Promise<string> {
    const id = `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newRule: FixRule = {
      id,
      usageCount: 0,
      successCount: 0,
      createdAt: new Date(),
      ...rule
    };

    this.rules.set(id, newRule);
    await this.save();

    console.log(`[FixRule] 新增规则: ${rule.name}`);
    return id;
  }

  getRules(): FixRule[] {
    return Array.from(this.rules.values());
  }

  getTopRules(limit: number = 10): FixRule[] {
    return Array.from(this.rules.values())
      .filter(r => r.usageCount > 0)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }
}

// ============================================================================
// 模式学习器 - 从成功的修正中学习新规则
// ============================================================================

class SQLPatternLearner {
  private errorLog: SQLErrorLog;
  private fixLog: SQLFixLog;
  private ruleEngine: SQLFixRuleEngine;

  constructor(errorLog: SQLErrorLog, fixLog: SQLFixLog, ruleEngine: SQLFixRuleEngine) {
    this.errorLog = errorLog;
    this.fixLog = fixLog;
    this.ruleEngine = ruleEngine;
  }

  /**
   * 分析成功的修正，学习新的模式
   */
  async learnFromSuccesses(): Promise<number> {
    const successfulFixes = this.fixLog.getSuccessfulFixes();
    let newRulesCount = 0;

    // 按错误类型分组
    const groupedByError = new Map<string, SQLFix[]>();
    for (const fix of successfulFixes) {
      const error = this.errorLog.getError(fix.errorId);
      if (error) {
        const key = error.errorType;
        if (!groupedByError.has(key)) {
          groupedByError.set(key, []);
        }
        groupedByError.get(key)!.push(fix);
      }
    }

    // 对每种错误类型，寻找共同模式
    for (const [errorType, fixes] of groupedByError) {
      if (fixes.length >= 3) {  // 至少3个成功案例才学习
        const pattern = this.detectPattern(fixes);
        if (pattern) {
          const ruleId = await this.ruleEngine.addRule({
            name: `学习规则_${errorType}`,
            description: `从${fixes.length}个成功修正中学习的规则`,
            errorPattern: pattern.errorPattern,
            fixPattern: pattern.fixPattern,
            replacement: pattern.replacement,
            confidence: 0.7,  // 初始置信度
            examples: fixes.slice(0, 3).map(f => ({
              before: f.originalSQL,
              after: f.fixedSQL
            }))
          });

          console.log(`[PatternLearner] 学习到新规则: ${ruleId}`);
          newRulesCount++;
        }
      }
    }

    return newRulesCount;
  }

  /**
   * 从多个修正中检测共同模式
   */
  private detectPattern(fixes: SQLFix[]): {
    errorPattern: RegExp | string;
    fixPattern: string;
    replacement: string;
  } | null {
    // 简单实现：找到所有修正中的最长公共子串
    const pairs = fixes.map(f => ({
      before: f.originalSQL,
      after: f.fixedSQL
    }));

    // 找到所有before和after的差异
    const diffs = pairs.map(p => this.findDifference(p.before, p.after));

    // 如果所有差异都相似，创建规则
    if (this.areDiffsSimilar(diffs)) {
      return {
        errorPattern: diffs[0].pattern,
        fixPattern: diffs[0].before,
        replacement: diffs[0].after
      };
    }

    return null;
  }

  private findDifference(before: string, after: string): {
    pattern: string;
    before: string;
    after: string;
  } {
    // 简化实现：找到第一个不同的地方
    let i = 0;
    while (i < before.length && i < after.length && before[i] === after[i]) {
      i++;
    }

    const start = Math.max(0, i - 20);
    const end = Math.min(before.length, i + 20);

    return {
      pattern: before.substring(start, end).trim(),
      before: before.substring(start, end).trim(),
      after: after.substring(start, Math.min(after.length, i + 20)).trim()
    };
  }

  private areDiffsSimilar(diffs: any[]): boolean {
    if (diffs.length < 2) return false;

    const first = diffs[0];
    return diffs.every(d =>
      d.before.includes(first.before.substring(0, 10)) ||
      first.before.includes(d.before.substring(0, 10))
    );
  }
}

// ============================================================================
// 完整的SQL学习系统 - 整合所有组件
// ============================================================================

class SQLLearningSystem {
  private errorLog: SQLErrorLog;
  private fixLog: SQLFixLog;
  private ruleEngine: SQLFixRuleEngine;
  private patternLearner: SQLPatternLearner;
  private initialized: boolean = false;

  constructor(logDir: string = './logs/sql_errors') {
    this.errorLog = new SQLErrorLog(logDir);
    this.fixLog = new SQLFixLog(logDir);
    this.ruleEngine = new SQLFixRuleEngine(logDir);
    this.patternLearner = new SQLPatternLearner(
      this.errorLog,
      this.fixLog,
      this.ruleEngine
    );
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    await Promise.all([
      this.errorLog.init(),
      this.fixLog.init(),
      this.ruleEngine.init()
    ]);

    this.initialized = true;
    console.log('[SQLLearningSystem] 初始化完成');
  }

  /**
   * 完整的SQL修正流程（闭环）
   *
   * 1. 记录错误
   * 2. 应用已知规则
   * 3. 验证修正结果
   * 4. 记录修正
   * 5. 更新规则置信度
   */
  async fixSQL(
    originalSQL: string,
    errorMessage: string,
    userQuery: string,
    validator: (sql: string) => { isValid: boolean; errors: string[] },
    executor?: (sql: string) => Promise<{ ok: boolean; error?: string }>
  ): Promise<{
    success: boolean;
    fixedSQL: string;
    appliedRules: string[];
    method: string;
    executionError?: string;
  }> {
    await this.init();

    // 步骤1: 记录错误
    const errorId = await this.errorLog.logError({
      originalSQL,
      errorType: this.classifyError(errorMessage),
      errorMessage,
      userQuery
    });

    // 步骤2: 应用修正规则
    const { fixed, appliedRules } = this.ruleEngine.applyRules(originalSQL);

    // 步骤3: 验证修正结果
    const validation = validator(fixed);
    let executionOk = validation.isValid;
    let executionError: string | undefined;
    if (validation.isValid && executor) {
      try {
        const execResult = await executor(fixed);
        executionOk = execResult.ok;
        executionError = execResult.error;
      } catch (error: any) {
        executionOk = false;
        executionError = error?.message || String(error);
      }
    }
    const success = validation.isValid && executionOk;

    // 步骤4: 记录修正（仅当规则实际改变了 SQL 时标记为 'learned'）
    const rulesActuallyApplied = appliedRules.length > 0 && fixed.trim() !== originalSQL.trim();
    await this.fixLog.logFix({
      errorId,
      originalSQL,
      fixedSQL: fixed,
      fixMethod: rulesActuallyApplied ? 'learned' : 'auto',
      success,
      validationResult: {
        ...validation,
        execution: {
          verified: !!executor,
          ok: executionOk,
          ...(executionError ? { error: executionError } : {}),
        },
      },
    });

    // 步骤5: 持久化规则使用统计（无论成功与否，usageCount 已在 applyRules 中增加）
    if (appliedRules.length > 0) {
      if (success) {
        for (const ruleId of appliedRules) {
          await this.ruleEngine.recordSuccess(ruleId);
        }
      } else {
        // 即使失败也要持久化 usageCount，防止重启后统计丢失
        await this.ruleEngine.save();
      }
    }

    return {
      success,
      fixedSQL: fixed,
      appliedRules,
      method: appliedRules.length > 0 ? 'learned_rules' : 'basic_fix',
      ...(executionError ? { executionError } : {}),
    };
  }

  /**
   * 定期学习新规则（建议每天运行一次）
   */
  async learnNewRules(): Promise<number> {
    await this.init();
    return await this.patternLearner.learnFromSuccesses();
  }

  /**
   * 获取学习统计
   */
  async getStats(): Promise<LearningStats> {
    await this.init();

    const allErrors = this.errorLog.getAllErrors();
    const allFixes = this.fixLog.getSuccessfulFixes();
    const allRules = this.ruleEngine.getRules();

    // 统计错误类型
    const errorTypes = new Map<string, number>();
    allErrors.forEach(e => {
      errorTypes.set(e.errorType, (errorTypes.get(e.errorType) || 0) + 1);
    });

    const topErrors = Array.from(errorTypes.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 统计规则效果
    const topRules = this.ruleEngine.getTopRules(10)
      .map(r => ({
        name: r.name,
        successRate: r.confidence
      }));

    return {
      totalErrors: allErrors.length,
      totalFixes: allFixes.length,
      successRate: allFixes.length / Math.max(allErrors.length, 1),
      rulesCount: allRules.length,
      topErrors,
      topRules
    };
  }

  /**
   * 导出学习报告
   */
  async generateReport(): Promise<string> {
    const stats = await this.getStats();

    return `
# SQL学习系统报告

## 总体统计
- 总错误数: ${stats.totalErrors}
- 成功修正数: ${stats.totalFixes}
- 修正成功率: ${(stats.successRate * 100).toFixed(2)}%
- 规则总数: ${stats.rulesCount}

## Top 错误类型
${stats.topErrors.map((e, i) => `${i + 1}. ${e.type}: ${e.count}次`).join('\n')}

## Top 修正规则
${stats.topRules.map((r, i) => `${i + 1}. ${r.name}: 成功率 ${(r.successRate * 100).toFixed(2)}%`).join('\n')}

生成时间: ${new Date().toISOString()}
    `.trim();
  }

  private classifyError(errorMessage: string): string {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('table') || msg.includes('表')) {
      return 'TABLE_NOT_FOUND';
    } else if (msg.includes('column') || msg.includes('字段')) {
      return 'COLUMN_NOT_FOUND';
    } else if (msg.includes('join')) {
      return 'JOIN_ERROR';
    } else if (msg.includes('syntax')) {
      return 'SYNTAX_ERROR';
    } else {
      return 'UNKNOWN';
    }
  }
}

export {
  SQLLearningSystem,
  SQLErrorLog,
  SQLFixLog,
  SQLFixRuleEngine,
  SQLPatternLearner,
  SQLError,
  SQLFix,
  FixRule,
  LearningStats
};

export default SQLLearningSystem;
