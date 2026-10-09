export function startOAuthMcpServer(): Promise<{
  url: string;
  stats: { registrations: number; tokens: number };
  close(): Promise<void>;
}>;
