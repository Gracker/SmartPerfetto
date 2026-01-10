#!/bin/bash
# Jank Detection Regression Test
# 验证掉帧检测逻辑的回归测试脚本
#
# 使用方法: ./verify_jank_detection.sh
#
# 期望结果:
#   Heavy Jank Trace: 39 total jank events
#   Light Jank Trace: 8 total jank events

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TRACE_PROCESSOR="$PROJECT_ROOT/perfetto/out/ui/trace_processor_shell"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 验证 SQL
VERIFY_SQL="
WITH
vsync_intervals AS (
  SELECT c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
vsync_config AS (
  SELECT COALESCE(
    (SELECT CAST(PERCENTILE(interval_ns, 0.5) AS INTEGER)
     FROM vsync_intervals WHERE interval_ns > 5000000 AND interval_ns < 15000000),
    8333333
  ) as vsync_period_ns
),
vsync_events AS (
  SELECT c.ts as vsync_ts, c.ts - LAG(c.ts) OVER (ORDER BY c.ts) as interval_ns
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name = 'VSYNC-sf'
),
buffer_events AS (
  SELECT c.ts, c.value as buffer_count
  FROM counter c
  JOIN counter_track t ON c.track_id = t.id
  WHERE t.name LIKE '%BufferTX%'
),
vsync_with_buffer AS (
  SELECT v.vsync_ts, v.interval_ns,
    (SELECT b.buffer_count FROM buffer_events b WHERE b.ts <= v.vsync_ts ORDER BY b.ts DESC LIMIT 1) as buffer_at_vsync
  FROM vsync_events v
  WHERE v.interval_ns IS NOT NULL
),
jank_analysis AS (
  SELECT
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5 THEN 1 ELSE 0 END) as total_jank_count,
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5 AND buffer_at_vsync = 0 THEN 1 ELSE 0 END) as app_jank_count,
    SUM(CASE WHEN interval_ns > (SELECT vsync_period_ns FROM vsync_config) * 1.5 AND COALESCE(buffer_at_vsync, 1) > 0 THEN 1 ELSE 0 END) as sf_jank_count
  FROM vsync_with_buffer
  WHERE buffer_at_vsync IS NOT NULL
)
SELECT total_jank_count, app_jank_count, sf_jank_count FROM jank_analysis;
"

# 检查 trace_processor_shell 是否存在
if [ ! -f "$TRACE_PROCESSOR" ]; then
    echo -e "${RED}Error: trace_processor_shell not found at $TRACE_PROCESSOR${NC}"
    echo "Please build it first: cd perfetto && tools/ninja -C out/ui trace_processor_shell"
    exit 1
fi

echo "=== Jank Detection Regression Test ==="
echo ""

# 测试 Heavy Jank Trace
HEAVY_TRACE="$PROJECT_ROOT/test-traces/app_aosp_scrolling_heavy_jank.pftrace"
if [ -f "$HEAVY_TRACE" ]; then
    echo "Testing: Heavy Jank Trace"
    RESULT=$("$TRACE_PROCESSOR" "$HEAVY_TRACE" -Q "$VERIFY_SQL" 2>/dev/null | tail -1)

    # 解析结果 (格式: "total,app,sf")
    TOTAL=$(echo "$RESULT" | cut -d',' -f1 | tr -d '"')
    APP=$(echo "$RESULT" | cut -d',' -f2 | tr -d '"')
    SF=$(echo "$RESULT" | cut -d',' -f3 | tr -d '"')

    EXPECTED_TOTAL=39
    EXPECTED_APP=6
    EXPECTED_SF=33

    if [ "$TOTAL" == "$EXPECTED_TOTAL" ]; then
        echo -e "  ${GREEN}✓${NC} Total jank events: $TOTAL (expected: $EXPECTED_TOTAL)"
    else
        echo -e "  ${RED}✗${NC} Total jank events: $TOTAL (expected: $EXPECTED_TOTAL)"
    fi

    if [ "$APP" == "$EXPECTED_APP" ]; then
        echo -e "  ${GREEN}✓${NC} App jank events: $APP (expected: $EXPECTED_APP)"
    else
        echo -e "  ${RED}✗${NC} App jank events: $APP (expected: $EXPECTED_APP)"
    fi

    if [ "$SF" == "$EXPECTED_SF" ]; then
        echo -e "  ${GREEN}✓${NC} SF jank events: $SF (expected: $EXPECTED_SF)"
    else
        echo -e "  ${RED}✗${NC} SF jank events: $SF (expected: $EXPECTED_SF)"
    fi
else
    echo -e "${YELLOW}Warning: Heavy jank trace not found at $HEAVY_TRACE${NC}"
fi

echo ""

# 测试 Light Jank Trace
LIGHT_TRACE="$PROJECT_ROOT/test-traces/app_aosp_scrolling_light.pftrace"
if [ -f "$LIGHT_TRACE" ]; then
    echo "Testing: Light Jank Trace"
    RESULT=$("$TRACE_PROCESSOR" "$LIGHT_TRACE" -Q "$VERIFY_SQL" 2>/dev/null | tail -1)

    TOTAL=$(echo "$RESULT" | cut -d',' -f1 | tr -d '"')
    APP=$(echo "$RESULT" | cut -d',' -f2 | tr -d '"')
    SF=$(echo "$RESULT" | cut -d',' -f3 | tr -d '"')

    EXPECTED_TOTAL=8
    EXPECTED_APP=6
    EXPECTED_SF=2

    if [ "$TOTAL" == "$EXPECTED_TOTAL" ]; then
        echo -e "  ${GREEN}✓${NC} Total jank events: $TOTAL (expected: $EXPECTED_TOTAL)"
    else
        echo -e "  ${RED}✗${NC} Total jank events: $TOTAL (expected: $EXPECTED_TOTAL)"
    fi

    if [ "$APP" == "$EXPECTED_APP" ]; then
        echo -e "  ${GREEN}✓${NC} App jank events: $APP (expected: $EXPECTED_APP)"
    else
        echo -e "  ${RED}✗${NC} App jank events: $APP (expected: $EXPECTED_APP)"
    fi

    if [ "$SF" == "$EXPECTED_SF" ]; then
        echo -e "  ${GREEN}✓${NC} SF jank events: $SF (expected: $EXPECTED_SF)"
    else
        echo -e "  ${RED}✗${NC} SF jank events: $SF (expected: $EXPECTED_SF)"
    fi
else
    echo -e "${YELLOW}Warning: Light jank trace not found at $LIGHT_TRACE${NC}"
fi

echo ""
echo "=== Test Complete ==="
