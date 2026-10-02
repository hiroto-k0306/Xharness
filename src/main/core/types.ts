export type ProviderId = "claude" | "codex";
export type Role = "user" | "assistant";
export type JsonSchema = Record<string, unknown>;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string | ContentBlock[];
      isError?: boolean;
    }
  | { type: "reasoning"; provider: ProviderId; payload: unknown }
  | { type: "compaction"; provider: "claude"; payload: unknown };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Message {
  role: Role;
  content: ContentBlock[];
  meta?: {
    provider?: ProviderId;
    model?: string;
    usage?: Usage;
    sources?: WebSource[];
    webSearch?: { calls: number };
  };
}

export interface WebSource {
  title: string;
  url: string;
  /** 検索結果のページの日付(Claude の web_search_result.page_age。例: "65 days ago") */
  pageAge?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}
