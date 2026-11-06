import { fw } from "@fireweaveai/web-sdk/start";

export function rememberPerson(id: string, role: string): void {
  void fw.identify(id, { role });
}

export function forgetPerson(): void {
  void fw.reset();
}
