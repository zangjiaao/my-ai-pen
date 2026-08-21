import {
  SESSION_DEMAND_CANCEL_LABEL,
  SESSION_DEMAND_SEND_LABEL,
  type SessionDemandItem,
} from "../lib/sessionDemandQueue";

const QUEUE_BUBBLE_CLASS =
  "max-w-[70%] break-words rounded-2xl bg-surface-default px-4 py-2.5 text-sm leading-5 text-ink-muted [overflow-wrap:anywhere]";

type Props = {
  items: SessionDemandItem[];
  onCancel: (id: string) => void;
  onForceSend: (id: string) => void;
  forceDisabled?: boolean;
};

/** List-tail queue chrome: user-shaped bubble, secondary type, actions to the right. */
export default function SessionDemandQueue({
  items,
  onCancel,
  onForceSend,
  forceDisabled = false,
}: Props) {
  if (!items.length) return null;
  return (
    <div className="space-y-2" data-testid="session-demand-queue">
      {items.map((item) => {
        const pending = item.status === "pending";
        return (
          <div
            key={item.id}
            className="flex min-w-0 items-center justify-end gap-2"
            data-testid="session-demand-row"
            data-demand-id={item.id}
            data-demand-status={item.status}
          >
            <div className={QUEUE_BUBBLE_CLASS}>{item.text}</div>
            {pending ? (
              <div className="flex h-8 shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={forceDisabled}
                  className="rounded-full px-2 py-1 text-sm leading-5 text-ink-secondary transition-colors hover:bg-canvas-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => onCancel(item.id)}
                >
                  {SESSION_DEMAND_CANCEL_LABEL}
                </button>
                <button
                  type="button"
                  disabled={forceDisabled}
                  className="rounded-full px-2 py-1 text-sm leading-5 text-ink-secondary transition-colors hover:bg-canvas-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => onForceSend(item.id)}
                >
                  {SESSION_DEMAND_SEND_LABEL}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
