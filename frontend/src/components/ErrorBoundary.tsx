import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Đã xảy ra lỗi hiển thị.' };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('[RAGFlow QC ErrorBoundary]', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-dvh w-screen flex items-center justify-center bg-[#fafaf9] p-6">
          <div className="max-w-md w-full rounded-lg bg-white border border-[#e4e4e7] p-6 space-y-3 shadow-xs">
            <h2 className="text-sm font-semibold text-[#141414]">Ứng dụng gặp sự cố hiển thị</h2>
            <p className="text-xs font-mono text-[#cf222e] bg-[#fef2f2] border border-[#fecaca] rounded p-2.5 break-words">
              {this.state.message}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, message: '' })}
                className="px-3 py-1.5 text-xs rounded border border-[#dcdcd8] bg-white hover:bg-[#fafaf9] text-[#141414]"
              >
                Thử lại
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 text-xs rounded bg-[#141414] hover:bg-[#27272a] text-white"
              >
                Tải lại trang
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
