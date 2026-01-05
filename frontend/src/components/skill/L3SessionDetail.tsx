import React from 'react';
import { Descriptions, Table, Tag } from 'antd';

interface Props {
  data: Record<string, any>;
  expandedFrames: Set<string>;
  onToggleFrame: (frameId: string) => void;
}

const L3SessionDetail: React.FC<Props> = ({ data, expandedFrames, onToggleFrame }) => {
  const fpsMetrics = data.calculate_fps_by_phase?.data || [];
  const jankFrames = data.get_jank_frames?.data || [];

  // 处理 FPS 指标
  const touchFling = fpsMetrics.find((m: any) => m.phase === 'touch_fling');
  const flingOnly = fpsMetrics.find((m: any) => m.phase === 'fling_only');

  const columns = [
    {
      title: '帧序号',
      dataIndex: 'frame_number',
      key: 'frame_number',
      width: 80,
    },
    {
      title: '阶段',
      dataIndex: 'phase',
      key: 'phase',
      width: 80,
    },
    {
      title: '耗时',
      dataIndex: 'dur_ms',
      key: 'dur_ms',
      width: 80,
      render: (val: number) => `${val.toFixed(1)} ms`,
    },
    {
      title: '诊断',
      dataIndex: 'diagnosis',
      key: 'diagnosis',
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: any) => {
        const frameId = `frame_${record.frame_number}`;
        const isExpanded = expandedFrames.has(frameId);
        return (
          <a onClick={() => onToggleFrame(frameId)}>
            {isExpanded ? '收起' : '详情'}
          </a>
        );
      },
    },
  ];

  return (
    <div>
      {/* FPS 指标 */}
      <Descriptions title="FPS 指标" bordered size="small" column={2}>
        <Descriptions.Item label="整体 FPS">
          <Tag color="blue">{touchFling?.fps?.toFixed(1) || '-'} fps</Tag>
          <span className="ml-2 text-gray-500">(包含 touch + fling)</span>
        </Descriptions.Item>
        <Descriptions.Item label="Fling FPS">
          <Tag color="purple">{flingOnly?.fps?.toFixed(1) || '-'} fps</Tag>
          <span className="ml-2 text-gray-500">(纯惯性阶段)</span>
        </Descriptions.Item>
      </Descriptions>

      {/* 掉帧帧列表 */}
      <h4 className="mt-4 mb-2">掉帧帧列表</h4>
      <Table
        columns={columns}
        dataSource={jankFrames}
        rowKey="frame_number"
        size="small"
        pagination={false}
      />
    </div>
  );
};

export default L3SessionDetail;
