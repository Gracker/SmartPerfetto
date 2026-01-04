import React from 'react';
import { Card, Statistic, Row, Col, Tag } from 'antd';

interface Props {
  data: Record<string, any>;
}

const L1OverviewCard: React.FC<Props> = ({ data }) => {
  const performanceSummary = data.performance_summary?.data?.[0];
  const jankStats = data.jank_type_stats?.data ?? [];

  const getRatingColor = (rating: string) => {
    switch (rating) {
      case '优秀': return 'success';
      case '良好': return 'processing';
      case '一般': return 'warning';
      case '较差': return 'error';
      default: return 'default';
    }
  };

  return (
    <Card title="滑动性能概览" className="mb-4">
      <Row gutter={16}>
        <Col span={6}>
          <Statistic
            title="平均 FPS"
            value={performanceSummary?.avg_fps || 0}
            precision={1}
            suffix="fps"
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="掉帧率"
            value={performanceSummary?.jank_rate || 0}
            precision={2}
            suffix="%"
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="评级"
            value={performanceSummary?.rating || '-'}
            valueStyle={{ fontSize: 24 }}
          />
        </Col>
        <Col span={6}>
          <Statistic
            title="总帧数"
            value={performanceSummary?.total_frames || 0}
          />
        </Col>
      </Row>

      {/* 掉帧类型 Top 3 */}
      <div className="mt-4">
        <div className="text-gray-500 mb-2">主要掉帧类型</div>
        {jankStats.slice(0, 3).map((stat: any, idx: number) => (
          <Tag key={idx} color="orange" className="mr-2 mb-2">
            {stat.jank_type}: {stat.count} 次
          </Tag>
        ))}
      </div>
    </Card>
  );
};

export default L1OverviewCard;
