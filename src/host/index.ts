/**
 * Package root Host entry: mounts `BacklinksConsoleRuntime` (`ctx.backlinksConsole`)
 * over `ctx.backlinks` while the Web/Desktop half of the same root entry loads `./client`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from './backlinks/index.ts'
import type { BacklinkBatchDetail, BacklinkBatchSummary } from '../shared/backlinks-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    backlinksConsole: BacklinksConsoleRuntime
  }
}

export const inject = ['backlinks']

export class BacklinksConsoleRuntime extends TypertRemoteService {
  static inject = ['backlinks']

  constructor(ctx: Context) {
    super(ctx, 'backlinksConsole')
  }

  @Remote
  async batches(): Promise<readonly BacklinkBatchSummary[]> {
    return await this.ctx.backlinks.listBatches()
  }

  @Remote
  async batch(batchId: number): Promise<BacklinkBatchDetail> {
    return await this.ctx.backlinks.getBatch(batchId)
  }
}

export default BacklinksConsoleRuntime
