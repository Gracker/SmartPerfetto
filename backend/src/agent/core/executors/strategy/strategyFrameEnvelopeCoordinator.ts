import type { DataEnvelope } from '../../../../types/dataContract';
import type { AgentResponse } from '../../../types/agentProtocol';
import type { StageDefinition, DirectSkillTask } from '../../../strategies';
import type { Finding } from '../../../types';

export class StrategyFrameEnvelopeCoordinator {
  deferExpandableFrameTables(
    stage: StageDefinition,
    responses: AgentResponse[]
  ): { responsesForEmit: AgentResponse[]; deferred: DataEnvelope[] } {
    if (stage.name !== 'session_overview') {
      return { responsesForEmit: responses, deferred: [] };
    }

    const deferred: DataEnvelope[] = [];

    const responsesForEmit = responses.map((response) => {
      if (!response.toolResults || response.toolResults.length === 0) return response;

      const toolResults = response.toolResults.map((tr) => {
        const envelopes = tr.dataEnvelopes || [];
        if (envelopes.length === 0) return tr;

        const kept: DataEnvelope[] = [];
        for (const env of envelopes) {
          const stepId = env.meta?.stepId;
          const layer = env.display?.layer;
          const format = env.display?.format;

          if (stepId === 'get_app_jank_frames' && layer === 'list' && (format === 'table' || !format)) {
            deferred.push(env);
            continue;
          }
          kept.push(env);
        }

        return {
          ...tr,
          dataEnvelopes: kept.length > 0 ? kept : undefined,
        };
      });

      return {
        ...response,
        toolResults,
      };
    });

    return { responsesForEmit, deferred };
  }

  attachExpandableDataToDeferredTables(
    tables: DataEnvelope[],
    tasks: DirectSkillTask[],
    responses: AgentResponse[]
  ): DataEnvelope[] {
    if (tables.length === 0 || tasks.length === 0 || responses.length === 0) return [];

    const tableInfos = tables.map((env) => {
      const payload = env.data as any;
      const columns: string[] = Array.isArray(payload?.columns) ? payload.columns : [];
      const rows: any[][] = Array.isArray(payload?.rows) ? payload.rows : [];

      const colIndex = new Map<string, number>();
      columns.forEach((c, idx) => colIndex.set(c, idx));

      const frameIdIdx = colIndex.get('frame_id');
      const sessionIdIdx = colIndex.get('session_id');
      const startTsIdx = colIndex.get('start_ts');

      const items: Array<Record<string, any>> = rows.map((row) => {
        const obj: Record<string, any> = {};
        columns.forEach((c, idx) => {
          obj[c] = row[idx];
        });
        return obj;
      });

      const keyToRowIndex = new Map<string, number>();
      for (let i = 0; i < items.length; i++) {
        const frameId = frameIdIdx !== undefined ? items[i][columns[frameIdIdx]] : items[i].frame_id;
        const sessionId = sessionIdIdx !== undefined ? items[i][columns[sessionIdIdx]] : items[i].session_id;
        const startTs = startTsIdx !== undefined ? items[i][columns[startTsIdx]] : items[i].start_ts;

        if (sessionId !== undefined && frameId !== undefined) {
          keyToRowIndex.set(`sf:${String(sessionId)}:${String(frameId)}`, i);
        }
        if (frameId !== undefined) {
          keyToRowIndex.set(`f:${String(frameId)}`, i);
        }
        if (startTs !== undefined) {
          keyToRowIndex.set(`ts:${String(startTs)}`, i);
        }
      }

      return {
        env,
        items,
        keyToRowIndex,
      };
    });

    const globalKeyToTable = new Map<string, { tableIdx: number; rowIdx: number }>();
    tableInfos.forEach((ti, tableIdx) => {
      for (const [key, rowIdx] of ti.keyToRowIndex.entries()) {
        if (!globalKeyToTable.has(key)) {
          globalKeyToTable.set(key, { tableIdx, rowIdx });
        }
      }
    });

    const perTableExpandable: Array<any[]> = tableInfos.map((ti) =>
      ti.items.map((item) => ({
        item,
        result: {
          success: false,
          sections: {},
          error: 'No frame analysis result bound',
        },
      }))
    );

    const count = Math.min(tasks.length, responses.length);
    for (let i = 0; i < count; i++) {
      const interval = tasks[i].interval;
      const sessionId = interval.metadata?.sessionId ?? interval.metadata?.session_id;
      const frameId = interval.metadata?.frameId ?? interval.metadata?.frame_id ?? interval.id;
      const startTs = interval.startTs;

      const candidateKeys = [
        (sessionId !== undefined && frameId !== undefined) ? `sf:${String(sessionId)}:${String(frameId)}` : '',
        (frameId !== undefined) ? `f:${String(frameId)}` : '',
        startTs ? `ts:${String(startTs)}` : '',
      ].filter(Boolean);
      if (candidateKeys.length === 0) continue;

      const location = candidateKeys
        .map((k) => globalKeyToTable.get(k))
        .find((v) => v !== undefined);
      if (!location) continue;

      const resp = responses[i];
      const toolResult = resp.toolResults?.[0];
      const rawResults = (toolResult?.data || {}) as Record<string, any>;

      const sections = this.rawResultsToSections(rawResults, resp.findings || toolResult?.findings);

      perTableExpandable[location.tableIdx][location.rowIdx] = {
        item: tableInfos[location.tableIdx].items[location.rowIdx],
        result: {
          success: resp.success,
          sections,
          error: toolResult?.error,
        },
      };
    }

    for (let i = 0; i < tableInfos.length; i++) {
      const payload = tableInfos[i].env.data as any;
      payload.expandableData = perTableExpandable[i];
    }

    return tableInfos.map((ti) => ti.env);
  }

  private rawResultsToSections(
    rawResults: Record<string, any>,
    findings?: Finding[]
  ): Record<string, any> {
    const sections: Record<string, any> = {};

    if (findings && findings.length > 0) {
      sections.findings = {
        title: '诊断要点',
        data: findings.map((f) => ({
          severity: f.severity,
          title: f.title,
          description: f.description || '',
          source: f.source || '',
        })),
      };
    }

    for (const [stepId, stepResult] of Object.entries(rawResults || {})) {
      if (!stepResult || typeof stepResult !== 'object') continue;

      const title = (stepResult.display && stepResult.display.title) ? String(stepResult.display.title) : stepId;
      const data = (stepResult as any).data;

      if (data && typeof data === 'object' && Array.isArray((data as any).columns) && Array.isArray((data as any).rows)) {
        const cols: string[] = (data as any).columns;
        const rows: any[][] = (data as any).rows;
        const objects = rows.map((row) => {
          const obj: Record<string, any> = {};
          cols.forEach((c, idx) => {
            obj[c] = row[idx];
          });
          return obj;
        });
        if (objects.length > 0) {
          sections[stepId] = { title, data: objects };
        }
        continue;
      }

      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
        sections[stepId] = { title, data };
        continue;
      }

      if (data !== undefined && data !== null) {
        sections[stepId] = {
          title,
          data: [
            typeof data === 'object' ? data : { value: data },
          ],
        };
      }
    }

    return sections;
  }
}
