import Sidebar from "../components/Sidebar";
import TopBar from "../components/TopBar";

export default function ConversationPage() {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <div className="flex flex-1">
          {/* 对话区 */}
          <main className="flex flex-1 flex-col items-center justify-center border-r border-hairline-soft">
            <div className="text-center">
              <h2 className="text-xl font-semibold">AI 安全运营平台</h2>
              <p className="mt-2 text-sm text-ink-secondary">
                在侧边栏选择一个会话，或创建新会话开始
              </p>
            </div>
          </main>
          {/* 右侧面板 */}
          <aside className="w-[360px] flex-shrink-0 p-4">
            <p className="text-sm text-ink-muted">右侧面板</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
