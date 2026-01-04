import React from 'react';
import { Table, Tag } from 'antd';

interface Props {
  data: Record<string, any>;
  expandedSessions: Set<string>;
  onToggleSession: (sessionId: string) => void;
}

const L2SessionList: React.FC<Props> = ({ data, expandedSessions, onToggleSession }) => {
  const sessions = data.scroll_sessions?.data ?? [];
  const sessionJank = data.session_jank_analysis?.data ?? [];

  const getJankRateColor = (rate: number) => {
    if (rate > 15) return 'red';
    if (rate > 5) return 'orange';
    return 'green';
  };

  const columns = [
    {
      title: '区间 ID',
      dataIndex: 'session_id',
      key: 'session_id',
      width: 100,
    },
    {
      title: '时长',
      dataIndex: 'duration_ms',
      key: 'duration_ms',
      width: 100,
      render: (val: number) => `${val.toFixed(0)} ms`,
    },
    {
      title: '帧数',
      dataIndex: 'frame_count',
      key: 'frame_count',
      width: 80,
    },
    {
      title: 'FPS',
      dataIndex: 'avg_fps',
      key: 'avg_fps',
      width: 80,
      render: (_: any, record: any) => {
        const fps = 1000 / (record.avg_frame_ms || 16.67);
        return fps.toFixed(1);
      },
    },
    {
      title: '掉帧率',
      dataIndex: 'jank_rate',
      key: 'jank_rate',
      width: 100,
      render: (rate: number) => (
        <Tag color={getJankRateColor(rate)}>{rate.toFixed(1)}%</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: any) => {
        const sessionId = `session_${record.session_id}`;
        const isExpanded = expandedSessions.has(sessionId);
        return (
          <a onClick={() => onToggleSession(sessionId)}>
            {isExpanded ? '收起' : '展开'}
          </a>
        );
      },
    },
  ];

  // 合并数据
  const dataSource = sessions.map((session: any) => {
    const jankData = sessionJank.find((j: any) => j.session_id === session.session_id);
    return {
      ...session,
      jank_rate: jankData?.jank_rate || 0,
    };
  });

  return (
    <div className="mb-4">
      <h3 className="text-lg font-semibold mb-2">滑动区间</h3>
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey="session_id"
        size="small"
        pagination={false}
        rowClassName={(record) => {
          const sessionId = `session_${record.session_id}`;
          return expandedSessions.has(sessionId) ? 'bg-blue-50' : '';
        }}
      />
    </div>
  );
};

export default L2SessionList;
