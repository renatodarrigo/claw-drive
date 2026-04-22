import { resolveCmd } from "./_shared-resolve.js";
export const cmdReject = (argv: string[]): Promise<number> => resolveCmd("reject", argv);
