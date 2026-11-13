export interface RemovalOptions { onError?: (message: string) => void }
export function removeTreeSync(folder: string, options?: RemovalOptions): boolean;
export function removeTree(folder: string, options?: RemovalOptions): Promise<boolean>;
