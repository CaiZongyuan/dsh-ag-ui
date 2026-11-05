/**
 * Host-module resolution: every overlay row must name a module the spawned
 * child process can import, and the child runs with a clean temporary cwd, so
 * bare specifiers are resolved here through this package's own module graph
 * and written into the overlay as `file:` URLs.
 * @module dsh-ag-ui-adapter/src/resolve
 */

import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'

/** Resolve one overlay row name to a `file:` URL the child can import. */
export function resolveHostModule(specifier: string): string {
  if (specifier.startsWith('file://')) return specifier
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href
  if (specifier.startsWith('.')) {
    throw new Error(
      `dsh-ag-ui-adapter cannot resolve the relative host module "${specifier}": `
      + 'the micro-host runs from a temporary directory. Pass a file URL, an absolute path, '
      + 'or a bare specifier installed next to dsh-ag-ui-adapter.',
    )
  }
  try {
    return import.meta.resolve(specifier, import.meta.url)
  } catch (cause) {
    throw new Error(
      `dsh-ag-ui-adapter cannot resolve the host module "${specifier}": `
      + 'pass a file URL, an absolute path, or a bare specifier installed next to dsh-ag-ui-adapter.',
      { cause },
    )
  }
}
