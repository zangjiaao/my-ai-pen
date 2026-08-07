/**
 * Spec #313 L3 — conversation-scoped Free todo.init replace grant (Node side).
 * Platform issues via task_assign.todo_replace_allowed or user_input.todo_replace_permission.
 * Agent allow_replace alone is never enough.
 */
const grants = new Map<string, boolean>();

export function grantTodoReplace(conversationId: string): void {
  const id = String(conversationId || "").trim();
  if (id) grants.set(id, true);
}

export function hasTodoReplaceGrant(conversationId: string): boolean {
  const id = String(conversationId || "").trim();
  return Boolean(id && grants.get(id));
}

/** One-shot: true once, then cleared. */
export function consumeTodoReplaceGrant(conversationId: string): boolean {
  const id = String(conversationId || "").trim();
  if (!id || !grants.get(id)) return false;
  grants.delete(id);
  return true;
}

export function clearTodoReplaceGrant(conversationId: string): void {
  const id = String(conversationId || "").trim();
  if (id) grants.delete(id);
}

/** Test helper */
export function clearAllTodoReplaceGrants(): void {
  grants.clear();
}

/**
 * Platform grant effective for this Free todo.init replace attempt.
 * Prefer task envelope; fall back to mid-run user_input grant (does not consume yet).
 */
export function platformTodoReplaceAllowed(opts: {
  taskTodoReplaceAllowed?: boolean;
  conversationId?: string;
}): boolean {
  if (opts.taskTodoReplaceAllowed === true) return true;
  return hasTodoReplaceGrant(String(opts.conversationId || ""));
}

/** After successful Free init replace — clear both envelope-driven and mid-run grants. */
export function consumePlatformTodoReplaceGrant(opts: {
  task: { conversationId: string; todoReplaceAllowed?: boolean };
  clearTaskFlag?: () => void;
}): void {
  if (opts.task.todoReplaceAllowed === true && opts.clearTaskFlag) {
    opts.clearTaskFlag();
  }
  clearTodoReplaceGrant(opts.task.conversationId);
}
