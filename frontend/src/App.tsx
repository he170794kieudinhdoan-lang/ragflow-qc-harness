import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Download,
  FileSearch,
  FlaskConical,
  FolderOpen,
  GitCompare,
  Home,
  Layers,
  PanelLeftClose,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { api } from './api/client';
import { ErrorCodeDef, RunItem } from './types';
import { OverviewPage } from './pages/OverviewPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { ParsingPage } from './pages/ParsingPage';
import { ChunkingPage } from './pages/ChunkingPage';
import { RetrievalPage } from './pages/RetrievalPage';
import { CompareLabPage } from './pages/CompareLabPage';

const NAV = [
  { id: 'overview', label: 'Trang chủ', icon: Home },
  { id: 'workspace', label: '1. Tài liệu & Parse', icon: FolderOpen },
  { id: 'parsing', label: '2. Chấm đọc file', icon: FileSearch },
  { id: 'chunking', label: '3. Chấm cắt đoạn', icon: Layers },
  { id: 'retrieval', label: '4. Chấm tìm kiếm', icon: Search },
  { id: 'compare', label: 'So sánh cấu hình', icon: GitCompare },
];

export default function App() {
  const [tab, setTab] = useState('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [activeRun, setActiveRun] = useState<RunItem | null>(null);
  const [catalogs, setCatalogs] = useState<{
    parsing_errors: ErrorCodeDef[];
    chunking_errors: ErrorCodeDef[];
  }>({ parsing_errors: [], chunking_errors: [] });

  // Settings Modal
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({
    ragflow_base_url: 'http://13.236.9.207',
    ragflow_api_key: '',
    min_chunk_chars: '50',
    max_chunk_chars: '2600',
  });
  const [hasKey, setHasKey] = useState(false);
  const [connMsg, setConnMsg] = useState<{ ok?: boolean; text?: string }>({});
  const [testing, setTesting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadRuns = async () => {
    const [rList, sRes] = await Promise.all([api.listRuns(), api.getSettings()]);
    setRuns(rList);
    setCatalogs(sRes.catalogs || { parsing_errors: [], chunking_errors: [] });
    const cleanSettings: Record<string, string> = {};
    for (const [k, v] of Object.entries(sRes.settings || {})) {
      if (typeof v === 'string') cleanSettings[k] = v;
    }
    setSettings((prev) => ({ ...prev, ...cleanSettings }));
    setHasKey(Boolean(sRes.settings?.has_ragflow_key));
    if (rList.length > 0) {
      const keep = activeRun ? rList.find((r: RunItem) => r.id === activeRun.id) : null;
      setActiveRun(keep || rList[0]);
    } else {
      setActiveRun(null);
    }
  };

  useEffect(() => {
    loadRuns();
  }, []);

  const handleSaveAndTest = async (doTest: boolean) => {
    setTesting(true);
    setConnMsg({});
    try {
      const saveRes = await api.saveSettings(settings);
      setHasKey(Boolean(settings.ragflow_api_key?.trim()));
      if (saveRes?.workspace_cleared) {
        await loadRuns();
        setRefreshKey((k) => k + 1);
      }
      if (doTest) {
        const res = await api.testRagflow();
        const extra = saveRes?.workspace_cleared
          ? ' · Đã xóa dữ liệu đồng bộ từ tài khoản cũ'
          : '';
        setConnMsg({
          ok: true,
          text: `Kết nối thành công · Tìm thấy ${res.dataset_count} dataset${extra}`,
        });
      } else {
        setConnMsg({
          ok: true,
          text: saveRes?.workspace_cleared
            ? 'Đã lưu cấu hình mới và xóa dữ liệu đồng bộ từ tài khoản cũ.'
            : 'Đã lưu cấu hình kết nối.',
        });
      }
    } catch (e: any) {
      setConnMsg({ ok: false, text: e.message });
    } finally {
      setTesting(false);
    }
  };

  const activeNav = NAV.find((n) => n.id === tab) || NAV[0];
  const ActiveIcon = activeNav.icon;

  return (
    <div className="h-dvh w-screen flex bg-white text-[#18181b] overflow-hidden">
      {/* TypeSafe-style Warm Off-White Sidebar */}
      <aside
        className={`${
          collapsed ? 'w-14' : 'w-[220px]'
        } shrink-0 border-r border-[#e8e8e6] bg-[#f8f8f7] flex flex-col justify-between transition-all duration-150`}
      >
        <div>
          {/* Brand Row */}
          <div className="h-12 px-3.5 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {/* Custom geometric mark inspired by TypeSafe */}
              <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-[#18181b]" fill="none" stroke="currentColor" strokeWidth="1.75">
                <polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2" />
                <line x1="12" y1="22" x2="12" y2="12" />
                <line x1="21" y1="7" x2="12" y2="12" />
                <line x1="3" y1="7" x2="12" y2="12" />
              </svg>
              {!collapsed && (
                <span className="font-mono text-[12px] font-semibold text-[#18181b] truncate">
                  RAGFLOW QC
                </span>
              )}
            </div>
            <button
              onClick={() => setCollapsed(!collapsed)}
              aria-label="Thu gọn thanh bên"
              className="p-1 text-[#71717a] hover:text-[#18181b] rounded-[3px] hover:bg-[#ececea]"
            >
              <PanelLeftClose className="size-4" strokeWidth={1.5} />
            </button>
          </div>

          {/* Nav Links */}
          <nav className="px-2 pt-2 space-y-0.5">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  title={collapsed ? item.label : undefined}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[4px] text-[13px] transition-colors ${
                    active
                      ? 'bg-[#eaeae7] text-[#18181b] font-medium'
                      : 'text-[#52525b] hover:text-[#18181b] hover:bg-[#f0f0ee]'
                  }`}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.6} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}

            <button
              onClick={() => setShowSettings(true)}
              title={collapsed ? 'Cài đặt API' : undefined}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[4px] text-[13px] text-[#52525b] hover:text-[#18181b] hover:bg-[#f0f0ee] transition-colors"
            >
              <Settings className="size-4 shrink-0" strokeWidth={1.6} />
              {!collapsed && <span className="truncate">Cài đặt API</span>}
            </button>
          </nav>
        </div>

        {/* Bottom Status Box (like TypeSafe's Balance + Org footer) */}
        {!collapsed && (
          <div className="p-2.5 space-y-2 border-t border-[#e8e8e6]">
            <div className="bg-white border border-[#e6e6e3] rounded-[4px] px-3 py-2.5">
              <div className="text-[11px] text-[#78716c]">Phiên hiện tại</div>
              <div className="text-sm font-semibold text-[#18181b] truncate mt-0.5">
                {activeRun ? activeRun.name : 'Chưa chọn'}
              </div>
              <div className="font-mono text-[11px] text-[#71717a] mt-1 tabular-nums">
                {activeRun ? `${activeRun.doc_count ?? 0} file · ${activeRun.chunk_count ?? 0} đoạn` : '0 file · 0 đoạn'}
              </div>
            </div>

            <button
              onClick={() => setShowSettings(true)}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-[4px] hover:bg-[#ececea] transition-colors text-left"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="size-7 rounded-[4px] bg-[#f3e5ef] text-[#6d2e58] font-semibold text-xs flex items-center justify-center shrink-0">
                  R
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[#18181b] truncate">RAGFlow Server</div>
                  <div className="text-[11px] text-[#78716c] truncate flex items-center gap-1">
                    <span className={`size-1.5 rounded-full ${hasKey ? 'bg-emerald-600' : 'bg-amber-500'}`} />
                    {hasKey ? 'Đã kết nối API' : 'Chưa nhập key'}
                  </div>
                </div>
              </div>
              <ChevronRight className="size-3.5 text-[#a1a1aa] shrink-0" />
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Crisp 48px Architectural Header */}
        <header className="h-12 shrink-0 px-5 border-b border-[#e8e8e6] bg-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#18181b]">
            <ActiveIcon className="size-4 text-[#71717a]" strokeWidth={1.6} />
            <span>{activeNav.label}</span>
          </div>

          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#78716c]">Phiên:</span>
              <select
                className="ts-input py-1 text-xs min-w-[190px] bg-[#fafafa]"
                value={activeRun?.id ?? ''}
                onChange={(e) => {
                  const found = runs.find((r) => r.id === Number(e.target.value));
                  if (found) setActiveRun(found);
                }}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.is_baseline ? '(Chuẩn)' : ''}
                  </option>
                ))}
                {runs.length === 0 && <option value="">Chưa có phiên nào</option>}
              </select>
            </div>

            {activeRun && (
              <a
                href={api.exportXlsxUrl(activeRun.id)}
                className="ts-btn-secondary py-1 text-xs"
                title="Tùy chọn phụ: xuất toàn bộ sang Excel"
              >
                <Download className="size-3.5" strokeWidth={1.6} />
                Xuất Excel
              </a>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          {tab === 'overview' && (
            <OverviewPage activeRun={activeRun} onNavigate={setTab} onReloadRuns={loadRuns} />
          )}
          {tab === 'workspace' && (
            <WorkspacePage
              activeRun={activeRun}
              runs={runs}
              refreshKey={refreshKey}
              onReloadRuns={loadRuns}
              onSelectRun={setActiveRun}
              onOpenSettings={() => setShowSettings(true)}
              onNextStep={() => setTab('parsing')}
            />
          )}
          {tab === 'parsing' && (
            <ParsingPage activeRun={activeRun} errorCatalog={catalogs.parsing_errors} />
          )}
          {tab === 'chunking' && (
            <ChunkingPage activeRun={activeRun} errorCatalog={catalogs.chunking_errors} />
          )}
          {tab === 'retrieval' && <RetrievalPage activeRun={activeRun} />}
          {tab === 'compare' && <CompareLabPage />}
        </main>
      </div>

      {/* Clean Light Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center p-4">
          <div className="bg-white border border-[#e4e4e2] rounded-[6px] w-full max-w-md p-6 space-y-5 shadow-lg">
            <div className="flex items-start justify-between">
              <div>
                <div className="ts-eyebrow">API CONFIGURATION</div>
                <h2 className="text-base font-semibold text-[#18181b] mt-0.5">Kết nối RAGFlow Server</h2>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                aria-label="Đóng"
                className="p-1 text-[#71717a] hover:text-[#18181b] rounded-[3px] hover:bg-[#f4f4f2]"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-[#3f3f46] mb-1">
                  Địa chỉ RAGFlow (Base URL)
                </label>
                <input
                  className="ts-input w-full font-mono text-xs"
                  value={settings.ragflow_base_url || ''}
                  onChange={(e) => setSettings({ ...settings, ragflow_base_url: e.target.value })}
                  placeholder="http://13.236.9.207"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#3f3f46] mb-1">
                  RAGFlow API Key
                </label>
                <input
                  type="password"
                  className="ts-input w-full font-mono text-xs"
                  value={settings.ragflow_api_key || ''}
                  onChange={(e) => setSettings({ ...settings, ragflow_api_key: e.target.value })}
                  placeholder="ragflow-xxxxxxxxxxxxxxxx"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-medium text-[#3f3f46] mb-1">
                    Ngưỡng chunk vụn (ký tự)
                  </label>
                  <input
                    className="ts-input w-full font-mono text-xs"
                    value={settings.min_chunk_chars || '50'}
                    onChange={(e) => setSettings({ ...settings, min_chunk_chars: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#3f3f46] mb-1">
                    Ngưỡng quá dài (ký tự)
                  </label>
                  <input
                    className="ts-input w-full font-mono text-xs"
                    value={settings.max_chunk_chars || '2600'}
                    onChange={(e) => setSettings({ ...settings, max_chunk_chars: e.target.value })}
                  />
                </div>
              </div>

              {connMsg.text && (
                <div
                  className={`text-xs px-3 py-2 rounded-[4px] border flex items-center gap-2 ${
                    connMsg.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border-rose-200 text-rose-800'
                  }`}
                >
                  {connMsg.ok && <CheckCircle2 className="size-3.5 shrink-0" />}
                  <span>{connMsg.text}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#ededeb]">
              <button
                onClick={() => handleSaveAndTest(true)}
                disabled={testing}
                className="ts-btn-secondary"
              >
                <FlaskConical className="size-3.5" />
                {testing ? 'Đang kiểm tra...' : 'Test kết nối'}
              </button>
              <button
                onClick={async () => {
                  await handleSaveAndTest(false);
                  setShowSettings(false);
                }}
                disabled={testing}
                className="ts-btn-primary"
              >
                Lưu & Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
