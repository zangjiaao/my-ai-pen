export interface User {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user: User;
}

export interface Conversation {
  id: string;
  title: string;
  node_id: string | null;
  status: "created" | "running" | "paused" | "completed" | "failed";
  created_at: string;
  last_active_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "agent" | "system";
  msg_type: string;
  content: Record<string, unknown>;
  parent_msg_id: string | null;
  created_at: string;
}
