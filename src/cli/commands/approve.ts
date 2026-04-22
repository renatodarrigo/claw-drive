import { resolveCmd } from "./_shared-resolve.js";
export const cmdApprove = (argv: string[]): Promise<number> => resolveCmd("approve", argv);
