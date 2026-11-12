import { Body, Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../../common/decorators/permissions.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import {
  Idempotent,
  type IdempotentRequest,
} from '../../../common/idempotency/idempotent-request';
import { Raises, Returns } from '../../../common/openapi/responses';
import { RateLimit } from '../../../common/rate-limit/rate-limit.decorator';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import { IdParams } from '../../../common/validation/schemas';
import type { UploadView } from '../application/ports/upload-records.port';
import { CompleteUploadUseCase } from '../application/use-cases/complete-upload.usecase';
import {
  type StartedUpload,
  StartUploadUseCase,
} from '../application/use-cases/start-upload.usecase';
import { StartUploadBody, UploadResponse } from './dto/upload.dto';

type UploadAnswer = z.infer<typeof UploadResponse>;

/**
 * Uploads (0.8.3; SR-DOC-003, ADR-0009). Starting one names its owner and the
 * file to come, and answers a short-lived PUT straight into quarantine;
 * completing one pins the exact version that arrived, once its size and
 * first bytes match the declaration, and queues its scan. Both take
 * `document.upload` and an `Idempotency-Key`; starting is in the `upload`
 * rate-limit category.
 */
@ApiTags('Files')
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly start: StartUploadUseCase,
    private readonly complete: CompleteUploadUseCase,
  ) {}

  @Post()
  @RequirePermission('document.upload')
  @RateLimit('upload')
  @ApiOperation({
    summary:
      'Start an upload for an owner: a short-lived PUT into quarantine, bound to the declared type and size',
  })
  @Returns(UploadResponse, { status: 201 })
  async create(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Idempotent() request: IdempotentRequest,
    @Body({ schema: StartUploadBody }) body: StartUploadBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UploadAnswer> {
    // It carries a link that sends to the store: no cache may keep it.
    response.setHeader('Cache-Control', 'no-store');
    return answerOf(await this.start.execute(ctx, request, body));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermission('document.upload')
  @ApiOperation({
    summary:
      'Complete an upload: its exact version is pinned once it matches what was declared, and its scan is queued',
  })
  @Returns(UploadResponse)
  @Raises('UPLOAD_INCOMPLETE', 'UPLOAD_CONTENT_MISMATCH', 'INVALID_TRANSITION')
  async finish(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Idempotent() request: IdempotentRequest,
    @Param({ schema: IdParams }) { id }: IdParams,
  ): Promise<UploadAnswer> {
    return answerOf({
      ...(await this.complete.execute(ctx, request, id)),
      put: null,
    });
  }
}

/** The upload, as its uploader sees it: never its key in the store. */
function answerOf(
  upload: UploadView & Pick<StartedUpload, 'put'>,
): UploadAnswer {
  return {
    id: upload.id,
    fileId: upload.fileId,
    status: upload.status,
    ownerKind: upload.owner.kind,
    ownerId: upload.owner.id,
    fileName: upload.fileName,
    type: upload.type,
    sizeBytes: upload.sizeBytes,
    createdAt: upload.createdAt.toISOString(),
    expiresAt: upload.expiresAt.toISOString(),
    completedAt: upload.finalizedAt?.toISOString() ?? null,
    put:
      upload.put === null
        ? null
        : {
            method: 'PUT',
            url: upload.put.url,
            headers: { ...upload.put.headers },
            expiresAt: upload.put.expiresAt.toISOString(),
          },
  };
}
