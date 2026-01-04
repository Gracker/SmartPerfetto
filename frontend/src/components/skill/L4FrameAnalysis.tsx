import React from 'react';
import { Descriptions, Card, Alert } from 'antd';

interface Props {
  data: any;
}

const L4FrameAnalysis: React.FC<Props> = ({ data }) => {
  const diagnosisSummary = data.diagnosis_summary || '暂无诊断';
  const fullAnalysis = data.full_analysis || {};

  // 四大象限数据
  const quadrants = fullAnalysis.quadrants || {};

  return (
    <div>
      {/* 诊断摘要 */}
      <Alert
        message="诊断摘要"
        description={diagnosisSummary}
        type="info"
        showIcon
        className="mb-4"
      />

      {/* 完整分析 */}
      <Card title="详细分析" size="small">
        {/* 四大象限 */}
        {quadrants.main_thread && (
          <Descriptions title="主线程四大象限" bordered size="small" column={2}>
            <Descriptions.Item label="Q1 (大核运行)">
              {quadrants.main_thread.q1?.toFixed(1) || 0}%
            </Descriptions.Item>
            <Descriptions.Item label="Q2 (小核运行)">
              {quadrants.main_thread.q2?.toFixed(1) || 0}%
            </Descriptions.Item>
            <Descriptions.Item label="Q3 (Runnable)">
              {quadrants.main_thread.q3?.toFixed(1) || 0}%
            </Descriptions.Item>
            <Descriptions.Item label="Q4 (Sleeping)">
              {quadrants.main_thread.q4?.toFixed(1) || 0}%
            </Descriptions.Item>
          </Descriptions>
        )}

        {/* Binder 调用 */}
        {fullAnalysis.binder_calls && fullAnalysis.binder_calls.length > 0 && (
          <Descriptions title="Binder 调用" bordered size="small" className="mt-4">
            <Descriptions.Item label="同步调用次数">
              {fullAnalysis.binder_calls.filter((c: any) => c.is_sync).length}
            </Descriptions.Item>
            <Descriptions.Item label="最大耗时">
              {(fullAnalysis.binder_calls && fullAnalysis.binder_calls.length > 0
                ? Math.max(...fullAnalysis.binder_calls.map((c: any) => c.dur_ms))
                : 0
              ).toFixed(1)} ms
            </Descriptions.Item>
          </Descriptions>
        )}

        {/* CPU 频率 */}
        {fullAnalysis.cpu_frequency && (
          <Descriptions title="CPU 频率" bordered size="small" className="mt-4">
            <Descriptions.Item label="大核平均频率">
              {fullAnalysis.cpu_frequency.big_avg_mhz || 0} MHz
            </Descriptions.Item>
            <Descriptions.Item label="小核平均频率">
              {fullAnalysis.cpu_frequency.little_avg_mhz || 0} MHz
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>
    </div>
  );
};

export default L4FrameAnalysis;
