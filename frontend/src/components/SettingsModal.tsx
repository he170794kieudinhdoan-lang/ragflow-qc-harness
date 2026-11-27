import React, { useEffect, useState } from 'react';
import {
  FlaskConical,
  Plug,
  FolderSync,
  FileSearch,
  Scissors,
  SearchCheck,
  RotateCcw,
  AlertCircle,
  X,
} from 'lucide-react';
import { api } from '../api/client';

type SectionId = 'connection' | 'step1' | 'step2' | 'step3' | 'step4';

interface SettingsModalProps {
  settings: Record<string, string>;
  defaults: Record<string, string>;
  setSettings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onClose: () => void;
  onSave: () => Promise<boolean>;
  onSaveSilent?: () => Promise<boolean>;
  onTestRagflow: () => Promise<boolean>;
  testing: boolean;
  connMsg: { ok?: boolean; text?: string };
  setConnMsg: React.Dispatch<React.SetStateAction<{ ok?: boolean; text?: string }>>;
}

const SECTION_KEYS: Record<SectionId, string[]> = {
  connection: [
    'ragflow_base_url',
    'llm_base_url',
    'llm_model',
    'swarm_parsing_model',
    'swarm_chunking_model',
    'swarm_retrieval_model',
    'swarm_supervisor_model',
    'systemone_base_url',
    'systemone_model',
  ],
  step1: ['slow_parse_threshold_sec'],
  step2: [
    'parsing_table_cell_match_threshold',
    'target_text_completeness',
    'target_table_accuracy',
    'target_reading_order',
  ],
  step3: [
    'chunking_judge_provider',
    'chunk_sample_mode',
    'chunk_sample_per_doc',
    'chunk_sample_min',
    'chunk_sample_max',
    'chunk_sample_sqrt_k',
    'min_chunk_chars',
    'max_chunk_chars',
    'exempt_intact_table_from_max_chars',
    'chunk_dup_threshold',
    'chunk_adj_overlap_threshold',
    'chunk_repeated_line_min',
    'target_chunk_integrity',
    'max_chunk_noise_rate',
    'target_valid_size_rate',
  ],
  step4: [
    'retrieval_judge_provider',
    'systemone_threshold',
    'default_top_k',
    'default_similarity_threshold',
    'default_vector_similarity_weight',
    'default_rerank_id',
    'default_keyword_enabled',
    'golden_gen_per_doc',
    'target_contextual_precision',
    'target_context_coverage',
  ],
};

const NAV_ITEMS: { id: SectionId; label: string; sub: string; icon: React.ComponentType<any> }[] = [
  { id: 'connection', label: 'Kết nối & LLM', sub: 'RAGFlow API, LLM Judge', icon: Plug },
  { id: 'step1', label: 'Bước 1: Đồng bộ', sub: 'Cảnh báo parse', icon: FolderSync },
  { id: 'step2', label: 'Bước 2: Parsing', sub: 'Ngưỡng đọc & KPI', icon: FileSearch },
  { id: 'step3', label: 'Bước 3: Chunking', sub: 'Mẫu, size, trùng, nhiễu', icon: Scissors },
  { id: 'step4', label: 'Bước 4: Retrieval', sub: 'Search mặc định & KPI', icon: SearchCheck },
];

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-[#27272a] mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[#71717a] mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

export default function SettingsModal({
  settings,
  defaults,
  setSettings,
  onClose,
  onSave,
  onSaveSilent,
  onTestRagflow,
  testing,
  connMsg,
  setConnMsg,
}: SettingsModalProps) {
  const [section, setSection] = useState<SectionId>('connection');
  const [testingLlm, setTestingLlm] = useState(false);
  const [testingVision, setTestingVision] = useState(false);
  const [testingSys1, setTestingSys1] = useState(false);
  const [testingSwarm, setTestingSwarm] = useState(false);
  const [swarmTestRoles, setSwarmTestRoles] = useState<Record<string, { model: string; ok: boolean; error: string }> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !testing && !testingLlm && !testingVision && !testingSys1) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, testing, testingLlm, testingVision, testingSys1]);

  const val = (key: string, fallback = '') => settings[key] ?? defaults[key] ?? fallback;
  const setKey = (key: string, value: string) => setSettings((prev) => ({ ...prev, [key]: value }));

  const resetSection = () => {
    const keys = SECTION_KEYS[section];
    setSettings((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (defaults[k] !== undefined) next[k] = defaults[k];
      }
      return next;
    });
    setConnMsg({ ok: true, text: 'Đã khôi phục giá trị mặc định cho mục này (bấm Lưu để áp dụng).' });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-[#fefefe] border border-[#dedede] rounded-[6px] w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden shadow-xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#dedede] flex items-center justify-between shrink-0">
          <div>
            <div className="ts-eyebrow">SYSTEM &amp; PIPELINE SETTINGS</div>
            <h2 className="text-base font-semibold text-[#161616] mt-0.5">Cài đặt hệ thống &amp; từng bước kiểm thử</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="p-1.5 text-[#71717a] hover:text-[#161616] rounded-[4px] hover:bg-[#f4f4f2]"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body: Left sidebar + Right content */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <aside className="w-52 shrink-0 border-r border-[#dedede] bg-[#fafaf9] p-2.5 space-y-1 overflow-y-auto">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSection(item.id);
                    setConnMsg({});
                  }}
                  className={`w-full text-left px-2.5 py-2 rounded-[4px] flex items-start gap-2.5 transition-colors ${active
                    ? 'bg-white border border-[#dedede] text-[#161616] shadow-2xs'
                    : 'border border-transparent text-[#52525b] hover:bg-[#f1f1ef] hover:text-[#161616]'
                    }`}
                >
                  <Icon className={`size-4 mt-0.5 shrink-0 ${active ? 'text-[#03aa5c]' : 'text-[#71717a]'}`} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{item.label}</div>
                    <div className="text-[10px] text-[#71717a] truncate">{item.sub}</div>
                  </div>
                </button>
              );
            })}
          </aside>

          {/* Right Panel */}
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-[#ededeb] pb-3">
              <div>
                <h3 className="text-sm font-semibold text-[#161616]">
                  {NAV_ITEMS.find((i) => i.id === section)?.label}
                </h3>
                <p className="text-[11px] text-[#71717a]">
                  {NAV_ITEMS.find((i) => i.id === section)?.sub}
                </p>
              </div>
              <button
                type="button"
                onClick={resetSection}
                className="inline-flex items-center gap-1.5 text-[11px] text-[#52525b] hover:text-[#161616] px-2.5 py-1 rounded-[4px] border border-[#e4e4e2] hover:bg-[#f4f4f2]"
              >
                <RotateCcw className="size-3" />
                Khôi phục mặc định
              </button>
            </div>

            {section === 'connection' && (
              <div className="space-y-5">
                <div className="flex items-center justify-between px-3.5 py-2.5 rounded-[5px] border border-[#e4e4e2] bg-[#fafaf9]">
                  <span className="text-xs font-medium text-[#161616]">Demo</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={val('demo_mode', 'false') === 'true'}
                    onClick={() =>
                      setKey('demo_mode', val('demo_mode', 'false') === 'true' ? 'false' : 'true')
                    }
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      val('demo_mode', 'false') === 'true' ? 'bg-[#03aa5c]' : 'bg-[#d4d4d8]'
                    }`}
                  >
                    <span
                      className={`inline-block size-3.5 transform rounded-full bg-white shadow transition-transform ${
                        val('demo_mode', 'false') === 'true' ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>

                <div className="space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    RAGFlow Server
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="Địa chỉ RAGFlow (Base URL)">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('ragflow_base_url')}
                        onChange={(e) => setKey('ragflow_base_url', e.target.value)}
                        placeholder="http://13.236.9.207"
                      />
                    </FieldRow>
                    <FieldRow label="RAGFlow API Key">
                      <input
                        type="password"
                        className="ts-input w-full font-mono text-xs"
                        value={val('ragflow_api_key')}
                        onChange={(e) => setKey('ragflow_api_key', e.target.value)}
                        placeholder="ragflow-xxxxxxxxxxxxxxxx"
                      />
                    </FieldRow>
                  </div>
                  <button
                    type="button"
                    onClick={onTestRagflow}
                    disabled={testing}
                    className="ts-btn-secondary text-xs"
                  >
                    <FlaskConical className="size-3.5 text-[#03aa5c]" />
                    {testing ? 'Đang kiểm tra...' : 'Kiểm tra kết nối RAGFlow'}
                  </button>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                      LLM Judge (Chấm tự động &amp; Sinh Golden Dataset)
                    </span>
                    <div className="flex items-center gap-1 text-[11px]">
                      {[
                        { label: 'Vercel', url: 'https://ai-gateway.vercel.sh/v1', model: 'openai/gpt-4o-mini' },
                        { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                        { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
                        { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                        { label: 'Ollama', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
                      ].map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() =>
                            setSettings((prev) => ({ ...prev, llm_base_url: p.url, llm_model: p.model }))
                          }
                          className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-[#03aa5c]/15 hover:text-[#027a42] border border-[#dedede] text-[#3d3d3d] rounded-[2px]"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="LLM Base URL">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('llm_base_url')}
                        onChange={(e) => setKey('llm_base_url', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Tên Model">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('llm_model')}
                        onChange={(e) => setKey('llm_model', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                  <FieldRow label="LLM API Key">
                    <input
                      type="password"
                      className="ts-input w-full font-mono text-xs"
                      value={val('llm_api_key')}
                      onChange={(e) => setKey('llm_api_key', e.target.value)}
                      placeholder="sk-..."
                    />
                  </FieldRow>
                  <button
                    type="button"
                    disabled={testingLlm}
                    onClick={async () => {
                      setTestingLlm(true);
                      setConnMsg({});
                      try {
                        if (onSaveSilent) await onSaveSilent();
                        else await api.saveSettings(settings);
                        const r = await api.testLlm();
                        setConnMsg({ ok: true, text: `Kết nối LLM thành công (${r.model})` });
                      } catch (e: any) {
                        setConnMsg({ ok: false, text: e.message });
                      } finally {
                        setTestingLlm(false);
                      }
                    }}
                    className="ts-btn-secondary text-xs"
                  >
                    <FlaskConical className="size-3.5 text-[#03aa5c]" />
                    {testingLlm ? 'Đang kiểm tra...' : 'Kiểm tra kết nối LLM'}
                  </button>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                        Vision LLM (Riêng cho OCR tài liệu scan / ảnh / biểu đồ)
                      </span>
                      <p className="text-[10px] text-[#71717a] mt-0.5">
                        Để trống sẽ dùng chung cấu hình LLM ở trên. Tách riêng để giữ DeepSeek chấm text và dùng Gemini/GPT-4o-mini đọc ảnh.
                      </p>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] shrink-0">
                      {[
                        { label: 'RapidOCR Local', url: 'local', model: 'local-rapidocr' },
                        { label: 'Gemini Flash', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
                        { label: 'GPT-4o-mini', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                      ].map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() =>
                            setSettings((prev) => ({ ...prev, vision_base_url: p.url, vision_model: p.model }))
                          }
                          className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-[#03aa5c]/15 hover:text-[#027a42] border border-[#dedede] text-[#3d3d3d] rounded-[2px]"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="Vision Base URL">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('vision_base_url')}
                        onChange={(e) => setKey('vision_base_url', e.target.value)}
                        placeholder="https://generativelanguage.googleapis.com/v1beta/openai"
                      />
                    </FieldRow>
                    <FieldRow label="Tên Vision Model">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('vision_model')}
                        onChange={(e) => setKey('vision_model', e.target.value)}
                        placeholder="gemini-3.8-flash"
                      />
                    </FieldRow>
                  </div>
                  <FieldRow label="Vision API Key">
                    <input
                      type="password"
                      className="ts-input w-full font-mono text-xs"
                      value={val('vision_api_key')}
                      onChange={(e) => setKey('vision_api_key', e.target.value)}
                      placeholder="AIza... hoặc sk-... (để trống nếu dùng chung key LLM)"
                    />
                  </FieldRow>
                  <button
                    type="button"
                    disabled={testingVision}
                    onClick={async () => {
                      setTestingVision(true);
                      setConnMsg({});
                      try {
                        if (onSaveSilent) await onSaveSilent();
                        else await api.saveSettings(settings);
                        const r = await api.testVision();
                        setConnMsg({ ok: true, text: `Kết nối Vision LLM thành công (${r.model})` });
                      } catch (e: any) {
                        setConnMsg({ ok: false, text: e.message });
                      } finally {
                        setTestingVision(false);
                      }
                    }}
                    className="ts-btn-secondary text-xs"
                  >
                    <FlaskConical className="size-3.5 text-[#03aa5c]" />
                    {testingVision ? 'Đang kiểm tra...' : 'Kiểm tra kết nối Vision LLM'}
                  </button>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                        Định tuyến 4 Model cho Multi-Agent (Bước 05 · Dùng chung Vercel URL &amp; Key)
                      </span>
                      <p className="text-[10px] text-[#71717a] mt-0.5">
                        Mỗi agent dùng 1 model chuyên biệt (tự fallback về LLM Model chung nếu để trống hoặc gặp lỗi).
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-[11px] shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            swarm_parsing_model: 'google/gemini-2.5-flash',
                            swarm_chunking_model: 'openai/gpt-4.1',
                            swarm_retrieval_model: 'openai/gpt-5-mini',
                            swarm_supervisor_model: 'openai/gpt-5.2',
                          }))
                        }
                        className="px-2 py-0.5 bg-[#f2fbf6] text-[#027a42] border border-[#03aa5c]/40 hover:bg-[#03aa5c]/15 rounded-[2px] font-medium"
                      >
                        Gói B · Pro (Mặc định)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            swarm_parsing_model: 'google/gemini-2.5-flash-lite',
                            swarm_chunking_model: 'openai/gpt-4.1-mini',
                            swarm_retrieval_model: 'deepseek/deepseek-v3.1',
                            swarm_supervisor_model: 'google/gemini-2.5-flash',
                          }))
                        }
                        className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-[#03aa5c]/15 hover:text-[#027a42] border border-[#dedede] text-[#3d3d3d] rounded-[2px]"
                      >
                        Gói A · Cân bằng
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            swarm_parsing_model: 'google/gemini-3-flash',
                            swarm_chunking_model: 'openai/gpt-4.1',
                            swarm_retrieval_model: 'openai/gpt-5-mini',
                            swarm_supervisor_model: 'anthropic/claude-sonnet-4.5',
                          }))
                        }
                        className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-[#03aa5c]/15 hover:text-[#027a42] border border-[#dedede] text-[#3d3d3d] rounded-[2px]"
                        title="Yêu cầu tài khoản Vercel AI Gateway đã nạp credit (Paid Tier)"
                      >
                        Paid · Claude + Gemini 3
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            swarm_parsing_model: '',
                            swarm_chunking_model: '',
                            swarm_retrieval_model: '',
                            swarm_supervisor_model: '',
                          }))
                        }
                        className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-zinc-200 border border-[#dedede] text-[#52525b] rounded-[2px]"
                      >
                        Dùng chung 1 model
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="1. Parsing Worker (Text + Vision PDF)" hint="Khuyên dùng Gemini 2.5 Flash có Vision đọc bảng/ảnh">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('swarm_parsing_model')}
                        onChange={(e) => setKey('swarm_parsing_model', e.target.value)}
                        placeholder="google/gemini-2.5-flash"
                      />
                    </FieldRow>
                    <FieldRow label="2. Chunking Worker (Ranh giới & Ngữ cảnh)" hint="Bám chặt JSON & phân tích ranh giới tiếng Việt">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('swarm_chunking_model')}
                        onChange={(e) => setKey('swarm_chunking_model', e.target.value)}
                        placeholder="openai/gpt-4.1"
                      />
                    </FieldRow>
                    <FieldRow label="3. Retrieval Worker (Đối chứng Vector/BM25)" hint="Suy luận đối chứng Top-hits vs Gold">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('swarm_retrieval_model')}
                        onChange={(e) => setKey('swarm_retrieval_model', e.target.value)}
                        placeholder="openai/gpt-5-mini"
                      />
                    </FieldRow>
                    <FieldRow label="4. Supervisor (Điều phối & Tổng hợp 3 gói)" hint="Chỉ 1 call cuối — nên dùng model reasoning mạnh">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('swarm_supervisor_model')}
                        onChange={(e) => setKey('swarm_supervisor_model', e.target.value)}
                        placeholder="openai/gpt-5.2"
                      />
                    </FieldRow>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={testingSwarm}
                      onClick={async () => {
                        setTestingSwarm(true);
                        setSwarmTestRoles(null);
                        setConnMsg({});
                        try {
                          if (onSaveSilent) await onSaveSilent();
                          else await api.saveSettings(settings);
                          const r = await api.testSwarm();
                          setSwarmTestRoles(r.roles || null);
                          setConnMsg({
                            ok: Boolean(r.ok),
                            text: r.ok
                              ? `Cả ${r.ok_count}/${r.total} model Multi-Agent đều kết nối thành công.`
                              : `Chỉ ${r.ok_count}/${r.total} model Multi-Agent kết nối thành công.`,
                          });
                        } catch (e: any) {
                          setConnMsg({ ok: false, text: e.message });
                        } finally {
                          setTestingSwarm(false);
                        }
                      }}
                      className="ts-btn-secondary text-xs"
                    >
                      <FlaskConical className="size-3.5 text-[#03aa5c]" />
                      {testingSwarm ? 'Đang kiểm tra 4 model...' : 'Kiểm tra kết nối cả 4 model'}
                    </button>
                  </div>
                  {swarmTestRoles && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] font-mono">
                      {Object.entries(swarmTestRoles).map(([role, st]) => (
                        <div
                          key={role}
                          className={`px-2.5 py-1.5 rounded border flex items-center justify-between gap-2 ${
                            st.ok
                              ? 'bg-[#f2fbf6] border-[#03aa5c]/30 text-[#027a42]'
                              : 'bg-rose-50 border-rose-200 text-rose-700'
                          }`}
                          title={st.error || st.model}
                        >
                          <span className="truncate">
                            <strong>{role}</strong>: {st.model || '—'}
                          </span>
                          <span className="shrink-0 font-semibold">{st.ok ? 'OK' : 'LỖI'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                        Jev / Kev System One (Chấm Relevancy Bước 4)
                      </span>
                      <p className="text-[10px] text-[#71717a] mt-0.5">
                        Hỗ trợ Jev (OpenRouter / Vercel / TypeSafe) hoặc Kev open-source (Google Colab URL trycloudflare.com / localhost:8009).
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-[11px] shrink-0">
                      {[
                        { label: 'OpenRouter · Jev', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.14' },
                        { label: 'Kev (Colab/Local)', url: 'http://localhost:8009', model: 'jaredpalmer/kev-4b' },
                        { label: 'Vercel · Jev', url: 'https://ai-gateway.vercel.sh/typesafe', model: 'typesafe-ai/jev' },
                        { label: 'TypeSafe Direct', url: 'https://api.typesafe.ai', model: 'jev-latest' },
                      ].map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() =>
                            setSettings((prev) => ({
                              ...prev,
                              systemone_base_url: p.url,
                              systemone_model: p.model,
                            }))
                          }
                          className="px-2 py-0.5 bg-[#f7f7f6] hover:bg-[#03aa5c]/15 hover:text-[#027a42] border border-[#dedede] text-[#3d3d3d] rounded-[2px]"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="System One Base URL">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('systemone_base_url', 'https://ai-gateway.vercel.sh/typesafe')}
                        onChange={(e) => setKey('systemone_base_url', e.target.value)}
                        placeholder="https://openrouter.ai/api/v1"
                      />
                    </FieldRow>
                    <FieldRow label="Model Jev">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('systemone_model', 'typesafe-ai/jev')}
                        onChange={(e) => setKey('systemone_model', e.target.value)}
                        placeholder="typesafe/jev-1.14"
                      />
                    </FieldRow>
                  </div>
                  <FieldRow label="System One / OpenRouter / Vercel Key (tùy chọn nếu dùng chung key LLM)">
                    <input
                      type="password"
                      className="ts-input w-full font-mono text-xs"
                      value={val('systemone_api_key')}
                      onChange={(e) => setKey('systemone_api_key', e.target.value)}
                      placeholder="sk-or-v1-... / vck_... (để trống nếu dùng chung key OpenRouter/Vercel ở mục LLM)"
                    />
                  </FieldRow>
                  <button
                    type="button"
                    disabled={testingSys1}
                    onClick={async () => {
                      setTestingSys1(true);
                      setConnMsg({});
                      try {
                        if (onSaveSilent) await onSaveSilent();
                        else await api.saveSettings(settings);
                        const r = await api.testSystemOne();
                        const pTxt =
                          r.sample_noul !== undefined && r.sample_noul !== null
                            ? ` · sample noul=${Number(r.sample_noul).toFixed(2)}`
                            : '';
                        setConnMsg({ ok: true, text: `Kết nối Jev thành công (${r.model}${pTxt})` });
                      } catch (e: any) {
                        setConnMsg({ ok: false, text: e.message });
                      } finally {
                        setTestingSys1(false);
                      }
                    }}
                    className="ts-btn-secondary text-xs"
                  >
                    <FlaskConical className="size-3.5 text-[#03aa5c]" />
                    {testingSys1 ? 'Đang kiểm tra...' : 'Kiểm tra kết nối Jev'}
                  </button>
                </div>
              </div>
            )}

            {section === 'step1' && (
              <div className="space-y-4">
                <FieldRow
                  label="Ngưỡng cảnh báo parse chậm — SLOW_PARSE (giây)"
                  hint="Tài liệu có thời gian parse vượt ngưỡng này sẽ bị gắn cờ SLOW_PARSE khi đồng bộ từ RAGFlow. Đặt 0 để tắt cảnh báo này. Mặc định: 180s (PDF scan/dày nên đặt 600–900s)."
                >
                  <input
                    type="number"
                    min={0}
                    className="ts-input w-48 font-mono text-xs"
                    value={val('slow_parse_threshold_sec', '180')}
                    onChange={(e) => setKey('slow_parse_threshold_sec', e.target.value)}
                  />
                </FieldRow>
              </div>
            )}

            {section === 'step2' && (
              <div className="space-y-5">
                <div className="space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Matching tự động
                  </div>
                  <FieldRow
                    label="Ngưỡng khớp ô bảng — Table Cell Match (%)"
                    hint="Độ tương đồng RapidFuzz tối thiểu để tính 1 ô bảng đọc chính xác (mặc định: 88%)."
                  >
                    <input
                      type="number"
                      min={50}
                      max={100}
                      className="ts-input w-40 font-mono text-xs"
                      value={val('parsing_table_cell_match_threshold', '88')}
                      onChange={(e) => setKey('parsing_table_cell_match_threshold', e.target.value)}
                    />
                  </FieldRow>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Ngưỡng KPI đạt chuẩn (Overview &amp; Khuyến nghị)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FieldRow label="Text Completeness (0–1)" hint="Mặc định: 0.80">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_text_completeness', '0.80')}
                        onChange={(e) => setKey('target_text_completeness', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Table Accuracy (0–1)" hint="Mặc định: 0.75">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_table_accuracy', '0.75')}
                        onChange={(e) => setKey('target_table_accuracy', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Reading Order (0–1)" hint="Mặc định: 0.80">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_reading_order', '0.80')}
                        onChange={(e) => setKey('target_reading_order', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                </div>
              </div>
            )}

            {section === 'step3' && (
              <div className="space-y-5">
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                      Lấy mẫu phân tầng &amp; Kích thước chunk (SIZE)
                    </span>
                    <div className="relative group inline-flex items-center">
                      <span
                        className="inline-flex items-center justify-center size-4 rounded-full border border-[#d4d4d8] bg-white text-[#52525b] group-hover:border-[#18181b] group-hover:text-[#18181b] cursor-help transition-colors"
                        aria-label="Chi tiết phương pháp phân bổ mẫu"
                      >
                        <AlertCircle className="size-3" />
                      </span>
                      <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-2 z-50 w-[360px] rounded-md border border-[#e4e4e2] bg-white p-3.5 shadow-lg text-[11px] text-[#3f3f46] leading-relaxed">
                        <div className="font-semibold text-[#18181b] mb-1.5">
                          3 chế độ chọn mẫu &amp; cách tính điểm
                        </div>
                        <ul className="space-y-1.5 list-disc pl-3.5">
                          <li>
                            <span className="font-semibold text-[#18181b]">Adaptive √n (Bankier 1988):</span>{' '}
                            File dài tự lấy nhiều mẫu hơn (từ sàn <span className="font-mono text-[10px]">min</span> đến trần <span className="font-mono text-[10px]">max</span> theo <span className="font-mono text-[10px]">c × √n</span>), cân bằng độ phủ và tốc độ.
                          </li>
                          <li>
                            <span className="font-semibold text-[#18181b]">Cố định:</span>{' '}
                            Lấy đúng N chunk/file (file ít hơn N thì lấy hết).
                          </li>
                          <li>
                            <span className="font-semibold text-[#18181b]">Toàn bộ 100%:</span>{' '}
                            Chấm tất cả chunk trong Run bằng cả Rule và LLM.
                          </li>
                          <li>
                            <span className="font-semibold text-[#18181b]">Điểm tổng có trọng số (Cochran 1977):</span>{' '}
                            File nhiều chunk chiếm tỷ trọng lớn hơn để file ngắn không làm lệch điểm chung.
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FieldRow label="Chế độ lấy mẫu" hint="Mặc định: Adaptive √n (Bankier 1988)">
                      <select
                        className="ts-input w-full text-xs bg-white"
                        value={val('chunk_sample_mode', 'adaptive')}
                        onChange={(e) => setKey('chunk_sample_mode', e.target.value)}
                      >
                        <option value="adaptive">Adaptive √n (Bankier 1988)</option>
                        <option value="fixed">Cố định (N mẫu / file)</option>
                        <option value="full">Toàn bộ (100% chunks)</option>
                      </select>
                    </FieldRow>
                    {val('chunk_sample_mode', 'adaptive') === 'fixed' ? (
                      <FieldRow label="Số chunk mẫu / tài liệu" hint="0 = lấy tất cả. Mặc định: 5">
                        <input
                          type="number"
                          min={0}
                          className="ts-input w-full font-mono text-xs"
                          value={val('chunk_sample_per_doc', '5')}
                          onChange={(e) => setKey('chunk_sample_per_doc', e.target.value)}
                        />
                      </FieldRow>
                    ) : val('chunk_sample_mode', 'adaptive') === 'adaptive' ? (
                      <>
                        <FieldRow label="Hệ số √n (c)" hint="k = round(c × √n). Mặc định: 2.0">
                          <input
                            type="number"
                            step="0.25"
                            min={0.5}
                            max={6}
                            className="ts-input w-full font-mono text-xs"
                            value={val('chunk_sample_sqrt_k', '2.0')}
                            onChange={(e) => setKey('chunk_sample_sqrt_k', e.target.value)}
                          />
                        </FieldRow>
                        <div className="grid grid-cols-2 gap-2">
                          <FieldRow label="Sàn (min)" hint="Mặc định: 5">
                            <input
                              type="number"
                              min={1}
                              max={50}
                              className="ts-input w-full font-mono text-xs"
                              value={val('chunk_sample_min', '5')}
                              onChange={(e) => setKey('chunk_sample_min', e.target.value)}
                            />
                          </FieldRow>
                          <FieldRow label="Trần (max)" hint="Mặc định: 20">
                            <input
                              type="number"
                              min={5}
                              max={100}
                              className="ts-input w-full font-mono text-xs"
                              value={val('chunk_sample_max', '20')}
                              onChange={(e) => setKey('chunk_sample_max', e.target.value)}
                            />
                          </FieldRow>
                        </div>
                      </>
                    ) : (
                      <div className="sm:col-span-2 flex items-center text-xs text-[#52525b] bg-[#fafaf9] border border-[#ededeb] rounded px-3 py-2">
                        Chấm toàn bộ 100% chunks trong Run bằng cả Rule-based và LLM-as-a-Judge (khuyến nghị khi corpus &lt; 1.000 chunks).
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="Độ dài tối thiểu (ký tự)" hint="Dưới ngưỡng → TOO_SHORT">
                      <input
                        type="number"
                        min={0}
                        className="ts-input w-full font-mono text-xs"
                        value={val('min_chunk_chars', '50')}
                        onChange={(e) => setKey('min_chunk_chars', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Độ dài tối đa (ký tự)" hint="Vượt ngưỡng → TOO_LONG">
                      <input
                        type="number"
                        min={100}
                        className="ts-input w-full font-mono text-xs"
                        value={val('max_chunk_chars', '2600')}
                        onChange={(e) => setKey('max_chunk_chars', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-[#27272a] cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={val('exempt_intact_table_from_max_chars', 'true') === 'true'}
                      onChange={(e) =>
                        setKey('exempt_intact_table_from_max_chars', e.target.checked ? 'true' : 'false')
                      }
                      className="rounded border-[#d4d4d8]"
                    />
                    Miễn lỗi <span className="font-mono text-[11px]">TOO_LONG</span> cho bảng HTML nguyên vẹn (&lt;table&gt;...&lt;/table&gt;)
                  </label>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Rule phát hiện trùng lặp (DUPLICATE) &amp; nhiễu (NOISE)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FieldRow label="Ngưỡng trùng nội dung (0–1)" hint="Mặc định: 0.85">
                      <input
                        type="number"
                        step="0.05"
                        min={0.5}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('chunk_dup_threshold', '0.85')}
                        onChange={(e) => setKey('chunk_dup_threshold', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Trùng biên liền kề (%)" hint="Overlap liền kề. Mặc định: 88">
                      <input
                        type="number"
                        min={50}
                        max={100}
                        className="ts-input w-full font-mono text-xs"
                        value={val('chunk_adj_overlap_threshold', '88')}
                        onChange={(e) => setKey('chunk_adj_overlap_threshold', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Số lần lặp dòng → NOISE" hint="Header/footer. Mặc định: 3">
                      <input
                        type="number"
                        min={2}
                        className="ts-input w-full font-mono text-xs"
                        value={val('chunk_repeated_line_min', '3')}
                        onChange={(e) => setKey('chunk_repeated_line_min', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Engine chấm Chunking mặc định (Bước 3)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow
                      label="Bộ chấm mặc định"
                      hint="Khuyên dùng Jev / Kev để chấm nhanh 3 tiêu chí ngữ nghĩa và không dính 429."
                    >
                      <select
                        className="ts-input w-full text-xs"
                        value={val('chunking_judge_provider', 'jev')}
                        onChange={(e) => setKey('chunking_judge_provider', e.target.value)}
                      >
                        <option value="jev">Jev / Kev System One (/v1/systemone)</option>
                        <option value="llm">Generative LLM (/chat/completions)</option>
                      </select>
                    </FieldRow>
                    <FieldRow
                      label="Ngưỡng xác suất Jev/Kev noul"
                      hint="Dùng chung ngưỡng cấu hình tại Bước 4 (mặc định 0.50)."
                    >
                      <input
                        type="number"
                        step="0.05"
                        min={0.05}
                        max={0.95}
                        className="ts-input w-full font-mono text-xs"
                        value={val('systemone_threshold', '0.50')}
                        onChange={(e) => setKey('systemone_threshold', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Ngưỡng KPI đạt chuẩn
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FieldRow label="Chunk Integrity (0–1)" hint="Mặc định: 0.80">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_chunk_integrity', '0.80')}
                        onChange={(e) => setKey('target_chunk_integrity', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Noise Rate tối đa (0–1)" hint="Càng thấp càng tốt. Mặc định: 0.15">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('max_chunk_noise_rate', '0.15')}
                        onChange={(e) => setKey('max_chunk_noise_rate', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Size Compliance (0–1)" hint="Mặc định: 0.85">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_valid_size_rate', '0.85')}
                        onChange={(e) => setKey('target_valid_size_rate', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                </div>
              </div>
            )}

            {section === 'step4' && (
              <div className="space-y-5">
                <div className="space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Tham số mặc định khi chạy Retrieval
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <FieldRow label="Top-K mặc định" hint="Mặc định: 10">
                      <input
                        type="number"
                        min={1}
                        max={50}
                        className="ts-input w-full font-mono text-xs"
                        value={val('default_top_k', '10')}
                        onChange={(e) => setKey('default_top_k', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Similarity Threshold (0–1)" hint="Mặc định: 0.2">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('default_similarity_threshold', '0.2')}
                        onChange={(e) => setKey('default_similarity_threshold', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Vector Weight (0–1)" hint="Mặc định: 0.3">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('default_vector_similarity_weight', '0.3')}
                        onChange={(e) => setKey('default_vector_similarity_weight', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="Rerank Model ID mặc định" hint="Để trống nếu không dùng Rerank">
                      <input
                        className="ts-input w-full font-mono text-xs"
                        value={val('default_rerank_id', '')}
                        onChange={(e) => setKey('default_rerank_id', e.target.value)}
                        placeholder="VD: BAAI/bge-reranker-v2-m3"
                      />
                    </FieldRow>
                    <FieldRow label="Số câu Golden sinh tự động / file" hint="Mặc định: 3">
                      <input
                        type="number"
                        min={1}
                        max={15}
                        className="ts-input w-full font-mono text-xs"
                        value={val('golden_gen_per_doc', '3')}
                        onChange={(e) => setKey('golden_gen_per_doc', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-[#27272a] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={val('default_keyword_enabled', 'true') === 'true'}
                      onChange={(e) =>
                        setKey('default_keyword_enabled', e.target.checked ? 'true' : 'false')
                      }
                      className="rounded border-[#d4d4d8]"
                    />
                    Bật Keyword Search (Hybrid) mặc định
                  </label>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Engine chấm Relevancy mặc định (Bước 4)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="Bộ chấm mặc định" hint="Khuyên dùng Jev System One để có tốc độ cao và xác suất p.">
                      <select
                        className="ts-input w-full text-xs"
                        value={val('retrieval_judge_provider', 'jev')}
                        onChange={(e) => setKey('retrieval_judge_provider', e.target.value)}
                      >
                        <option value="jev">Jev System One (typesafe-ai/jev)</option>
                        <option value="llm">Generative LLM (/chat/completions)</option>
                        <option value="rule">RapidFuzz Rule (0-AI)</option>
                      </select>
                    </FieldRow>
                    <FieldRow label="Ngưỡng xác suất Jev/Kev noul (0.05–0.95)" hint="Mặc định: 0.50 (đã hiệu chuẩn strict + lọc metadata; vùng ±0.08 Cần duyệt)">
                      <input
                        type="number"
                        step="0.05"
                        min={0.05}
                        max={0.95}
                        className="ts-input w-full font-mono text-xs"
                        value={val('systemone_threshold', '0.50')}
                        onChange={(e) => setKey('systemone_threshold', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                </div>

                <div className="border-t border-[#ededeb] pt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a]">
                    Ngưỡng KPI đạt chuẩn
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldRow label="Contextual Precision (0–1)" hint="Mặc định: 0.65">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_contextual_precision', '0.65')}
                        onChange={(e) => setKey('target_contextual_precision', e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Context Coverage (0–1)" hint="Mặc định: 0.70">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        className="ts-input w-full font-mono text-xs"
                        value={val('target_context_coverage', '0.70')}
                        onChange={(e) => setKey('target_context_coverage', e.target.value)}
                      />
                    </FieldRow>
                  </div>
                </div>
              </div>
            )}

            {connMsg.text && (
              <div
                className={`px-3 py-2 text-xs rounded-[4px] border ${connMsg.ok
                  ? 'bg-[#03aa5c]/10 border-[#03aa5c]/30 text-[#027a42]'
                  : 'bg-red-50 border-red-200 text-red-700'
                  }`}
              >
                {connMsg.text}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-[#dedede] bg-[#f7f7f6] flex items-center justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose} className="ts-btn-secondary text-xs">
            Đóng
          </button>
          <button
            type="button"
            disabled={testing || testingLlm || testingVision || testingSys1}
            onClick={async () => {
              const ok = await onSave();
              if (ok) onClose();
            }}
            className="ts-btn-primary text-xs disabled:opacity-45"
          >
            {testing ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
        </div>
      </div>
    </div>
  );
}
