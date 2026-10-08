export interface SdkRuntimeView {
  root?: string;
  version?: string;
  candidate?: string;
  checkedAt?: string;
  state: "preparing" | "ready" | "checking" | "attention";
  message: string;
}
