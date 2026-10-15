/** How much receipt files each account can keep. */
export const RECEIPT_SPACE_BYTES = 20 * 1024 * 1024;

/** "12.3 MB". */
export const formatMegabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
