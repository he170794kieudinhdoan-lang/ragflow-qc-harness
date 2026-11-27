import React from 'react';
import { Database, FileText, Layers, AlertTriangle, CheckCircle2, Sliders } from 'lucide-react';
import { AdvisorResponse, CandidateConfigPack, HypothesisPack, SwarmDiagnosisReport } from '../types';
import { AgentDiagnosisPanel } from './AgentDiagnosisPanel';

interface Props {
  advisor: AdvisorResponse | null;
  loading: boolean;
  applyingPackId: string;
  onApplyPack?: (pack: CandidateConfigPack, forkNewRun: boolean) => void;
  agentReport?: SwarmDiagnosisReport | null;
  isAgentReportStale?: boolean;
  loadingAgentReport?: boolean;
  onRunAgentDiagnosis?: (forceRefresh: boolean) => void;
  onApplyHypothesisPack?: (pack: HypothesisPack, forkNewRun: boolean) => void;
  onOpenParserConfig?: (section: 'parser' | 'chunker') => void;
  pendingReparse?: boolean;
  reparsing?: boolean;
  onReparseNow?: () => void;
  onOpenWorkspace?: () => void;
}

export const ConfigAdvisorPanel: React.FC<Props> = ({
  advisor,
  loading,
  applyingPackId,
  agentReport = null,
  isAgentReportStale = false,
  loadingAgentReport = false,
  onRunAgentDiagnosis,
  onApplyHypothesisPack,
  onOpenParserConfig,
  pendingReparse = false,
  reparsing = false,
  onReparseNow,
  onOpenWorkspace,
}) => {
  if (loading && !advisor && !agentReport) {
    return (
      <div className="p-12 text-center text-sm text-[#71717a] border border-[#e4e4e2] rounded-xl bg-white">
        Đang tải dữ liệu phiên kiểm thử...
      </div>
    );
  }

  const cp = advisor?.corpus_profile;
  const signals = advisor?.failure_signals || [];

  return (
    <div className="space-y-6">
      {/* Slim single-line Corpus Status Bar */}
      {advisor && cp && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-[#e4e4e2] bg-[#fafaf9] text-xs">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[#3d3d3d]">
            <span className="inline-flex items-center gap-1.5 font-medium text-[#161616]">
              <Database className="size-3.5 text-[#71717a]" />
              {cp.doc_count} tài liệu · {cp.total_chunks} đoạn
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Layers className="size-3.5 text-[#71717a]" />
              TB <strong className="font-mono text-[#161616]">{cp.avg_chunk_tokens}</strong> token/đoạn
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5 text-[#71717a]" />
              Bảng <strong className="font-mono text-[#161616]">{(cp.table_ratio * 100).toFixed(0)}%</strong> · Scan{' '}
              <strong className="font-mono text-[#161616]">{(cp.scan_ratio * 100).toFixed(0)}%</strong>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Sliders className="size-3.5 text-[#71717a]" />
              Đang dùng:{' '}
              <strong className="font-mono text-[#161616]">
                {advisor.current_config.index.chunk_method} ({advisor.current_config.index.chunk_token_size} tok)
              </strong>
            </span>
          </div>

          <div className="shrink-0">
            {signals.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 font-medium text-[11px]">
                <AlertTriangle className="size-3.5 text-amber-600" />
                {signals.length} điểm cần chú ý
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#f2fbf6] border border-[#03aa5c]/30 text-[#027a42] font-medium text-[11px]">
                <CheckCircle2 className="size-3.5 text-[#03aa5c]" />
                Chỉ số ổn định
              </span>
            )}
          </div>
        </div>
      )}

      {/* Primary 3+1 Multi-Agent Workflow */}
      {onRunAgentDiagnosis && (
        <AgentDiagnosisPanel
          report={agentReport}
          isStale={isAgentReportStale}
          loading={loadingAgentReport}
          applyingPackId={applyingPackId}
          onRunDiagnosis={onRunAgentDiagnosis}
          onApplyPack={onApplyHypothesisPack}
          onOpenParserConfig={onOpenParserConfig}
          pendingReparse={pendingReparse}
          reparsing={reparsing}
          onReparseNow={onReparseNow}
          onOpenWorkspace={onOpenWorkspace}
        />
      )}
    </div>
  );
};
