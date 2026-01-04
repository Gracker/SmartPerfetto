import React, { useState, useCallback } from 'react';
import { Collapse, Button } from 'antd';
import L1OverviewCard from './L1OverviewCard';
import L2SessionList from './L2SessionList';
import L3SessionDetail from './L3SessionDetail';
import L4FrameAnalysis from './L4FrameAnalysis';

const { Panel } = Collapse;

interface LayeredResult {
  layers: {
    L1?: Record<string, any>;
    L2?: Record<string, any>;
    L3?: Record<string, Record<string, any>>;
    L4?: Record<string, Record<string, any>>;
  };
  defaultExpanded: ('L1' | 'L2' | 'L3' | 'L4')[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
}

interface Props {
  result: LayeredResult;
}

const LayeredResultView: React.FC<Props> = ({ result }) => {
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(
    new Set(result.defaultExpanded)
  );

  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedFrames, setExpandedFrames] = useState<Set<string>>(new Set());

  const toggleLayer = useCallback((layer: string) => {
    setExpandedLayers(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(layer)) {
        newExpanded.delete(layer);
      } else {
        newExpanded.add(layer);
      }
      return newExpanded;
    });
  }, []);

  const toggleSession = useCallback((sessionId: string) => {
    setExpandedSessions(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(sessionId)) {
        newExpanded.delete(sessionId);
      } else {
        newExpanded.add(sessionId);
      }
      return newExpanded;
    });
  }, []);

  const toggleFrame = useCallback((frameId: string) => {
    setExpandedFrames(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(frameId)) {
        newExpanded.delete(frameId);
      } else {
        newExpanded.add(frameId);
      }
      return newExpanded;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedLayers(new Set(['L1', 'L2', 'L3', 'L4']));
    const allSessions = Object.keys(result.layers.L3 || {});
    const allFrames = Object.keys(result.layers.L4 || {});
    setExpandedSessions(new Set(allSessions));
    setExpandedFrames(new Set(allFrames));
  }, [result.layers]);

  const collapseAll = useCallback(() => {
    setExpandedLayers(new Set(['L1', 'L2']));
    setExpandedSessions(new Set());
    setExpandedFrames(new Set());
  }, []);

  return (
    <div className="layered-result-view">
      <div className="mb-2">
        <Button size="small" onClick={expandAll} className="mr-2">
          全部展开
        </Button>
        <Button size="small" onClick={collapseAll}>
          全部折叠
        </Button>
      </div>

      {/* L1 - 概览层 */}
      {result.layers.L1 && expandedLayers.has('L1') && (
        <L1OverviewCard data={result.layers.L1} />
      )}

      {/* L2 - 区间层 */}
      {result.layers.L2 && expandedLayers.has('L2') && (
        <L2SessionList
          data={result.layers.L2}
          expandedSessions={expandedSessions}
          onToggleSession={toggleSession}
        />
      )}

      {/* L3 - 区间详情层 */}
      {result.layers.L3 && expandedSessions.size > 0 && (
        <Collapse ghost>
          {Array.from(expandedSessions).map(sessionId => (
            <Panel
              header={`区间 ${sessionId} 详情`}
              key={sessionId}
              forceRender
            >
              <L3SessionDetail
                data={(result.layers.L3?.[sessionId]) ?? {}}
                expandedFrames={expandedFrames}
                onToggleFrame={toggleFrame}
              />
            </Panel>
          ))}
        </Collapse>
      )}

      {/* L4 - 帧分析层 */}
      {result.layers.L4 && expandedFrames.size > 0 && (
        <Collapse ghost>
          {Array.from(expandedFrames).map(frameId => (
            <Panel
              header={`帧 ${frameId} 分析`}
              key={frameId}
              forceRender
            >
              <L4FrameAnalysis data={(result.layers.L4?.[frameId]) ?? {}} />
            </Panel>
          ))}
        </Collapse>
      )}
    </div>
  );
};

export default LayeredResultView;
