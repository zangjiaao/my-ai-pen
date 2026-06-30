import { useEffect, useState } from "react";

interface Notification {
  id: string;
  requestId?: string;
  message: string;
  description?: string;
  conversationId?: string;
}

export default function SonnerToast() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<Notification>).detail;
      if (!detail?.id) return;
      setNotifications(prev => [...prev.filter(item => item.id !== detail.id), detail]);
    };
    window.addEventListener("sonner:notify", handler as EventListener);
    return () => window.removeEventListener("sonner:notify", handler as EventListener);
  }, []);

  useEffect(() => {
    if (!notifications.length) return;
    const timers = notifications.map(item => window.setTimeout(() => dismiss(item.id), 8000));
    return () => timers.forEach(window.clearTimeout);
  }, [notifications]);

  const dismiss = (id: string) => setNotifications(prev => prev.filter(item => item.id !== id));

  const locate = (item: Notification) => {
    window.dispatchEvent(new CustomEvent("approval:locate", { detail: { requestId: item.requestId, conversationId: item.conversationId } }));
    dismiss(item.id);
  };

  return (
    <div className="fixed right-4 top-16 z-50 w-[340px] max-w-[calc(100vw-2rem)] space-y-2">
      {notifications.map(item => (
        <div key={item.id} data-testid="sonner-toast" className="rounded-md bg-ink px-4 py-3 text-sm text-white shadow-lg">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{item.message}</p>
              {item.description && <p className="mt-1 line-clamp-2 text-xs text-white/75">{item.description}</p>}
            </div>
            <button type="button" onClick={() => dismiss(item.id)} className="rounded px-1 text-xs text-white/70 hover:text-white" aria-label="Dismiss">x</button>
          </div>
          <button data-testid="sonner-locate" type="button" onClick={() => locate(item)} className="mt-3 rounded-pill bg-white/20 px-3 py-1 text-xs font-medium hover:bg-white/30">View</button>
        </div>
      ))}
    </div>
  );
}
