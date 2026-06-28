import { useEffect, useState } from "react";

interface Notification { id: string; message: string; conversationId: string; }

export default function SonnerToast() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    const handler = (e: CustomEvent<Notification>) => setNotifications(prev => [...prev, e.detail]);
    window.addEventListener("sonner:notify" as any, handler);
    return () => window.removeEventListener("sonner:notify" as any, handler);
  }, []);

  const dismiss = (id: string) => setNotifications(prev => prev.filter(n => n.id !== id));

  return (
    <div className="fixed right-4 top-16 z-50 space-y-2">
      {notifications.map(n => (
        <div key={n.id} className="flex items-center gap-3 rounded-md bg-ink px-4 py-3 text-sm text-white shadow-lg">
          <span>⏳ {n.message}</span>
          <button onClick={() => dismiss(n.id)} className="rounded-pill bg-white/20 px-3 py-1 text-xs">去处理</button>
        </div>
      ))}
    </div>
  );
}
