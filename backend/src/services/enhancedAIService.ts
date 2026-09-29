// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * 增强版AI服务 - 集成SQL模板引擎
 *
 * 工作流程:
 * 1. 用户输入 → 尝试模板匹配
 * 2. 如果匹配成功 → 使用模板生成SQL
 * 3. 如果匹配失败 → 使用AI生成SQL
 * 4. 验证SQL → 如果失败则修正
 * 5. 执行SQL → 返回结果
 */

import { SQLTemplateEngine, SQLTemplate } from './sqlTemplateEngine';

interface GenerateSqlRequest {
  query: string;
  context?: string;
  app_package?: string;
  start_ts?: string;
  end_ts?: string;
}

interface GenerateSqlResponse {
  sql: string;
  explanation: string;
  method: 'template' | 'ai_generated';
  template_used?: string;
  validation: {
    isValid: boolean;
    warnings: string[];
    suggestions: string[];
  };
}

class EnhancedAIService {
  private sqlEngine: SQLTemplateEngine;

  constructor() {
    this.sqlEngine = new SQLTemplateEngine();
  }

  /**
   * 主要方法：生成Perfetto SQL
   *
   * 工作流程:
   * 1. 首先尝试模板匹配（快速、可靠）
   * 2. 如果没有匹配的模板，则使用AI生成（灵活、可能不准确）
   * 3. 无论哪种方式，都要验证SQL
   * 4. 如果验证失败，尝试修正
   */
  async generatePerfettoSQL(request: GenerateSqlRequest): Promise<GenerateSqlResponse> {
    console.log(`\n=== 生成SQL: "${request.query}" ===`);

    // 步骤1: 尝试模板匹配
    const template = this.sqlEngine.matchTemplate(request.query);

    if (template) {
      console.log(`✓ 匹配到模板: ${template.name}`);
      return this.generateFromTemplate(template, request);
    }

    console.log('✗ 未匹配到模板，使用AI生成');

    // 步骤2: 使用AI生成
    return this.generateFromAI(request);
  }

  /**
   * 使用模板生成SQL
   */
  private generateFromTemplate(
    template: SQLTemplate,
    request: GenerateSqlRequest
  ): GenerateSqlResponse {
    console.log('使用模板生成SQL...');

    // 步骤1: 提取参数
    const params = this.extractParameters(template, request);
    console.log(`提取参数:`, params);

    // 步骤2: 渲染SQL
    let sql: string;
    try {
      sql = this.sqlEngine.render(template.name, params);
    } catch (error: any) {
      // 如果参数不足，尝试使用示例参数
      console.log(`参数不足，使用示例参数: ${error.message}`);
      sql = this.sqlEngine.render(template.name, {
        ...template.examples,
        ...params
      });
    }

    // 步骤3: 验证SQL
    const validation = this.sqlEngine.validateSQL(sql);
    console.log(`验证结果: ${validation.isValid ? '✓ 通过' : '✗ 失败'}`);

    // 步骤4: 如果验证失败，尝试修正
    if (!validation.isValid) {
      console.log('尝试修正SQL...');
      const fixed = this.sqlEngine.suggestFix(sql, validation.errors[0]);
      if (fixed) {
        sql = fixed;
        console.log('✓ SQL已修正');
      }
    }

    return {
      sql,
      explanation: template.description,
      method: 'template',
      template_used: template.name,
      validation: {
        isValid: validation.isValid,
        warnings: validation.warnings,
        suggestions: validation.suggestions
      }
    };
  }

  /**
   * 使用AI生成SQL（占位符 - 实际应该调用OpenAI/Claude等）
   */
  private async generateFromAI(request: GenerateSqlRequest): Promise<GenerateSqlResponse> {
    console.log('使用AI生成SQL（模拟）...');

    // 这里应该调用实际的AI服务
    // const aiResponse = await this.callOpenAI(request.query);

    // 模拟AI生成的SQL
    const sql = this.mockAIGeneration(request.query);

    // 验证AI生成的SQL
    const validation = this.sqlEngine.validateSQL(sql);
    console.log(`验证结果: ${validation.isValid ? '✓ 通过' : '✗ 失败'}`);

    // 如果验证失败，尝试修正
    let finalSQL = sql;
    if (!validation.isValid) {
      console.log('AI生成的SQL验证失败，尝试修正...');
      const fixed = this.sqlEngine.suggestFix(sql, validation.errors[0]);
      if (fixed) {
        finalSQL = fixed;
        console.log('✓ SQL已修正');
      } else {
        console.log('✗ 无法自动修正，需要重新生成');
        // 在实际实现中，这里应该重新调用AI
      }
    }

    return {
      sql: finalSQL,
      explanation: '由AI生成的Perfetto SQL查询',
      method: 'ai_generated',
      validation: {
        isValid: validation.isValid || !!this.sqlEngine.suggestFix(sql, ''),
        warnings: validation.warnings,
        suggestions: validation.suggestions
      }
    };
  }

  /**
   * 从请求中提取模板参数
   */
  private extractParameters(
    template: SQLTemplate,
    request: GenerateSqlRequest
  ): { [key: string]: any } {
    const params: { [key: string]: any } = {};

    // 从请求中提取已知参数
    if (request.app_package) {
      params.app_package = request.app_package;
    }

    if (request.start_ts) {
      params.start_ts = request.start_ts;
    }

    if (request.end_ts) {
      params.end_ts = request.end_ts;
    }

    // 尝试从查询文本中提取包名
    if (!params.app_package) {
      const packageMatch = request.query.match(/com\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+/);
      if (packageMatch) {
        params.app_package = packageMatch[0];
      }
    }

    // 为常用参数设置默认值
    if (template.params.includes('limit') && !params.limit) {
      params.limit = '20';
    }

    if (template.params.includes('min_duration_ns') && !params.min_duration_ns) {
      params.min_duration_ns = '1000000'; // 1ms
    }

    if (template.params.includes('min_count') && !params.min_count) {
      params.min_count = '5';
    }

    // 计算window_ns（如果需要）
    if (template.params.includes('window_ns') && params.start_ts && params.end_ts) {
      params.window_ns = (parseInt(params.end_ts) - parseInt(params.start_ts)).toString();
    }

    return params;
  }

  /**
   * 模拟AI生成SQL（占位符）
   */
  private mockAIGeneration(query: string): string {
    // 这里模拟一些常见的错误SQL，用于演示验证和修正功能

    if (query.includes('启动') || query.includes('launch')) {
      // 模拟一个有警告的SQL（缺少时间单位转换）
      return `SELECT slice.name, slice.ts, slice.dur FROM slice JOIN thread_track ON slice.track_id = thread_track.id JOIN thread USING (utid) JOIN process USING (upid) WHERE process.name = 'com.example.app' AND slice.name LIKE '%start%';`;
    }

    if (query.includes('cpu') || query.includes('CPU')) {
      // 模拟一个错误的SQL（使用了不存在的表）
      return `SELECT * FROM app_launch WHERE cpu = 0;`;
    }

    // 默认返回一个基本查询
    return `SELECT slice.name, COUNT(*) as count FROM slice GROUP BY slice.name ORDER BY count DESC LIMIT 10;`;
  }

  /**
   * 列出所有可用的模板（供前端选择）
   */
  listAvailableTemplates(): Array<{
    name: string;
    description: string;
    category: string;
    params: string[];
  }> {
    const templates = this.sqlEngine.listTemplates();
    return templates.map(t => ({
      name: t.name,
      description: t.description,
      category: t.category,
      params: t.params
    }));
  }

  /**
   * 获取模板详情
   */
  getTemplateInfo(templateName: string): SQLTemplate | undefined {
    return this.sqlEngine.getTemplate(templateName);
  }

  /**
   * 直接使用模板生成SQL
   */
  useTemplate(templateName: string, params: { [key: string]: any }): GenerateSqlResponse {
    const template = this.sqlEngine.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    const sql = this.sqlEngine.render(templateName, params);
    const validation = this.sqlEngine.validateSQL(sql);

    return {
      sql,
      explanation: template.description,
      method: 'template',
      template_used: templateName,
      validation: {
        isValid: validation.isValid,
        warnings: validation.warnings,
        suggestions: validation.suggestions
      }
    };
  }
}

// ============================================================================
// 使用示例
// ============================================================================

async function demonstrateUsage() {
  const service = new EnhancedAIService();

  console.log('='.repeat(80));
  console.log('增强版AI服务演示');
  console.log('='.repeat(80));

  // 示例1: 使用模板（自动匹配）
  console.log('\n【示例1: 自动匹配模板】');
  const result1 = await service.generatePerfettoSQL({
    query: '分析com.example.androidappdemo的启动时间'
  });

  console.log('\n结果:');
  console.log(`  方法: ${result1.method}`);
  console.log(`  模板: ${result1.template_used}`);
  console.log(`  说明: ${result1.explanation}`);
  console.log(`  SQL: ${result1.sql.substring(0, 100)}...`);
  console.log(`  验证通过: ${result1.validation.isValid}`);

  // 示例2: AI生成（没有匹配的模板）
  console.log('\n【示例2: AI生成（未匹配模板）】');
  const result2 = await service.generatePerfettoSQL({
    query: '查找所有GC事件'
  });

  console.log('\n结果:');
  console.log(`  方法: ${result2.method}`);
  console.log(`  SQL: ${result2.sql}`);
  console.log(`  警告: ${result2.validation.warnings.join(', ') || '无'}`);

  // 示例3: 直接使用模板
  console.log('\n【示例3: 直接使用模板】');
  const result3 = service.useTemplate('TOP_OPERATIONS', {
    app_package: 'com.example.app',
    start_ts: '40919970000000',
    end_ts: '40920200000000',
    min_duration_ns: '1000000',
    limit: '15'
  });

  console.log('\n结果:');
  console.log(`  模板: ${result3.template_used}`);
  console.log(`  SQL: ${result3.sql.substring(0, 100)}...`);

  // 示例4: 列出所有模板
  console.log('\n【示例4: 可用的模板列表】');
  const templates = service.listAvailableTemplates();
  templates.forEach((t, index) => {
    console.log(`\n${index + 1}. ${t.name}`);
    console.log(`   分类: ${t.category}`);
    console.log(`   描述: ${t.description}`);
    console.log(`   参数: ${t.params.join(', ')}`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('演示完成');
  console.log('='.repeat(80));
}

// 如果直接运行
if (require.main === module) {
  demonstrateUsage().catch(console.error);
}

export default EnhancedAIService;
export type { GenerateSqlRequest, GenerateSqlResponse };