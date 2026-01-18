#!/bin/bash
# =============================================================================
# AI Panel 自动化测试脚本
# =============================================================================
#
# 使用方法：
#   ./scripts/test-ai-panel.sh [unit|e2e|all]
#
# 示例：
#   ./scripts/test-ai-panel.sh unit   # 只运行单元测试
#   ./scripts/test-ai-panel.sh e2e    # 只运行 E2E 测试
#   ./scripts/test-ai-panel.sh all    # 运行所有测试
#   ./scripts/test-ai-panel.sh        # 默认运行单元测试

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
UI_DIR="$PROJECT_ROOT/perfetto/ui"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

run_unit_tests() {
    echo_info "运行 AI Panel 单元测试..."
    cd "$UI_DIR"

    # 构建并运行单元测试
    npm test 2>&1 | tee /tmp/ai-panel-unit-test.log

    # 检查 AI Panel 测试结果
    if grep -q "ai_panel_data_transform_unittest" /tmp/ai-panel-unit-test.log; then
        if grep -A1 "ai_panel_data_transform_unittest" /tmp/ai-panel-unit-test.log | grep -q "PASS"; then
            echo_info "✅ AI Panel 单元测试通过"
            return 0
        else
            echo_error "❌ AI Panel 单元测试失败"
            return 1
        fi
    else
        echo_warn "⚠️  未找到 AI Panel 单元测试结果"
        return 1
    fi
}

run_e2e_tests() {
    echo_info "运行 AI Panel E2E 测试..."
    cd "$UI_DIR"

    # 检查开发服务器是否运行
    if ! curl -s http://localhost:10000 > /dev/null 2>&1; then
        echo_warn "前端开发服务器未运行，正在启动..."
        ./run-dev-server &
        sleep 5
    fi

    # 检查后端是否运行
    if ! curl -s http://localhost:3000/api/traces/health > /dev/null 2>&1; then
        echo_warn "后端服务未运行，E2E 测试可能会跳过部分用例"
    fi

    # 运行 Playwright E2E 测试
    npx playwright test src/test/ai_panel.test.ts --reporter=list

    echo_info "✅ E2E 测试完成"
}

check_dependencies() {
    echo_info "检查依赖..."

    # 检查 node_modules
    echo_info "  - 检查 node_modules..."
    if [ ! -d "$UI_DIR/node_modules" ]; then
        echo_error "请先运行 'npm install' 安装依赖"
        exit 1
    fi
    echo_info "  - node_modules ✓"

    # 检查 Playwright (仅 E2E 测试需要)
    if [ "$1" = "e2e" ] || [ "$1" = "all" ]; then
        echo_info "  - 检查 Playwright..."
        cd "$UI_DIR"
        # 跳过 Playwright 版本检查，直接假设已安装
        # 如果 E2E 测试失败会提示安装
        if [ -d "node_modules/@playwright" ]; then
            echo_info "  - Playwright 模块存在 ✓"
        else
            echo_warn "  - Playwright 未安装，运行: npx playwright install chromium"
        fi
    fi

    echo_info "依赖检查完成"
}

print_usage() {
    echo "AI Panel 自动化测试"
    echo ""
    echo "使用方法："
    echo "  $0 [unit|e2e|all]"
    echo ""
    echo "选项："
    echo "  unit   运行单元测试（快速，不需要浏览器）"
    echo "  e2e    运行 E2E 测试（需要启动开发服务器）"
    echo "  all    运行所有测试"
    echo ""
    echo "测试内容："
    echo "  - 单元测试: StepResult 数据格式检测、数据提取、显示格式化"
    echo "  - E2E 测试: 表格渲染验证、禁止列检测、时间戳点击跳转"
}

# =============================================================================
# 主流程
# =============================================================================

TEST_TYPE="${1:-unit}"

case "$TEST_TYPE" in
    unit)
        check_dependencies unit
        run_unit_tests
        ;;
    e2e)
        check_dependencies e2e
        run_e2e_tests
        ;;
    all)
        check_dependencies all
        run_unit_tests
        run_e2e_tests
        ;;
    help|--help|-h)
        print_usage
        ;;
    *)
        echo_error "未知的测试类型: $TEST_TYPE"
        print_usage
        exit 1
        ;;
esac

echo_info "测试完成！"
