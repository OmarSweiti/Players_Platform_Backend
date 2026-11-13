import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../../common/decorators/permissions.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import { Raises, Returns } from '../../../common/openapi/responses';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import { IdParams } from '../../../common/validation/schemas';
import {
  DownloadFileUseCase,
  type FileDownload,
} from '../application/use-cases/download-file.usecase';
import { DownloadResponse } from './dto/download.dto';

type DownloadAnswer = z.infer<typeof DownloadResponse>;

/**
 * Files (0.8.5; SR-DOC-002, ADR-0009). A download names the file; its
 * owner's policy decides who reads it, and the answer is a minute-long link
 * to the exact version that was scanned clean — never where it is stored
 * beyond that link. It takes `document.read`.
 */
@ApiTags('Files')
@Controller('files')
export class FilesController {
  constructor(private readonly downloads: DownloadFileUseCase) {}

  @Get(':id/download')
  @RequirePermission('document.read')
  @ApiOperation({
    summary:
      'Download a file: a minute-long link to the exact version that was scanned clean',
  })
  @Returns(DownloadResponse)
  @Raises('FILE_UNAVAILABLE')
  async download(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DownloadAnswer> {
    // It carries a link that reads from the store: no cache may keep it.
    response.setHeader('Cache-Control', 'no-store');
    return answerOf(await this.downloads.execute(ctx, id));
  }
}

function answerOf(download: FileDownload): DownloadAnswer {
  return {
    fileId: download.fileId,
    fileName: download.fileName,
    type: download.type,
    sizeBytes: download.sizeBytes,
    sha256: download.sha256.toString('hex'),
    get: {
      method: 'GET',
      url: download.get.url,
      expiresAt: download.get.expiresAt.toISOString(),
    },
  };
}
