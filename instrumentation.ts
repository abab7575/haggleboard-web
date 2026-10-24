export async function register(): Promise<void> {
  const { assertVercelStartup } = await import("./lib/startup");
  assertVercelStartup();
}
