/**
 * Returns true when the importing module is the process entrypoint (i.e. was
 * invoked as `node <script>` or via a bin symlink), false when it was imported
 * by another module.
 */
export function isMainModule(metaUrl: string): boolean;
