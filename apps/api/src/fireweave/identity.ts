import { fw } from "@fireweaveai/server-sdk/start";

export function rememberPerson(id: string, role: string): void {
  void fw.identify(id, { role });
}
