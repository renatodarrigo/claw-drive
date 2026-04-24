import { resolveCmd } from "./_shared-resolve.js";
export const cmdDefer = (argv: string[]): Promise<number> => resolveCmd("defer", argv);
