import { Component, ErrorInfo, ReactNode } from "react"

type Props = { children: ReactNode }
type State = { error: Error | null }

// A renderer failure must never look like an empty black Wails window. This
// boundary preserves a useful recovery screen while the application records a
// new build that fixes the underlying issue.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("KOVA Voice Studio renderer error", error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="renderer-recovery" role="alert">
      <p className="eyebrow">KOVA VOICE STUDIO</p>
      <h1>Không thể hiển thị màn hình này</h1>
      <p>Giao diện gặp lỗi thay vì tiếp tục hiển thị màn hình trống. Bạn có thể tải lại ứng dụng và gửi nội dung lỗi này nếu sự cố lặp lại.</p>
      <pre>{this.state.error.message}</pre>
      <button className="primary" onClick={() => window.location.reload()}>Tải lại ứng dụng</button>
    </main>
  }
}
