import { describe, expect, it } from 'vitest'
import { resolveHostModule } from '../src/resolve.ts'

describe('resolveHostModule', () => {
  it('uses file URLs verbatim', () => {
    expect(resolveHostModule('file:///opt/plugins/edge.mjs')).toBe('file:///opt/plugins/edge.mjs')
  })

  it('maps absolute paths to file URLs', () => {
    const path = process.platform === 'win32' ? 'C:\\opt\\plugins\\edge.mjs' : '/opt/plugins/edge.mjs'
    const url = process.platform === 'win32' ? 'file:///C:/opt/plugins/edge.mjs' : 'file:///opt/plugins/edge.mjs'
    expect(resolveHostModule(path)).toBe(url)
  })

  it('resolves bare specifiers through this package', () => {
    expect(resolveHostModule('dsh-ag-ui')).toMatch(/^file:\/\//)
    expect(resolveHostModule('dsh-ag-ui')).toMatch(/\/lib\/index\.js$/)
  })

  it('rejects relative specifiers with guidance', () => {
    expect(() => resolveHostModule('./plugin.mjs')).toThrow('relative host module')
  })

  it('rejects unknown bare specifiers with guidance', () => {
    expect(() => resolveHostModule('definitely-not-an-installed-package')).toThrow('cannot resolve the host module')
  })
})
