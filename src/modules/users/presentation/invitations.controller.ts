import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { RequiresRecentAuth } from '../../../common/decorators/requires-recent-auth.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import {
  Raises,
  Returns,
  ReturnsPage,
} from '../../../common/openapi/responses';
import type { Page } from '../../../common/pagination/paginate';
import { RateLimit } from '../../../common/rate-limit/rate-limit.decorator';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import { IdParams } from '../../../common/validation/schemas';
import type { ListedInvitation } from '../application/ports/invitation-records.port';
import { InviteMemberUseCase } from '../application/use-cases/invite-member.usecase';
import { ManageInvitationsUseCase } from '../application/use-cases/manage-invitations.usecase';
import {
  CreateInvitationBody,
  InvitationResponse,
  InvitationsQuery,
} from './dto/invitation.dto';

/**
 * Invitations (0.5.10): inviting a person to the tenant with a role, the
 * list of invitations, and revoking one. Each needs `user.invite`. Inviting
 * grants a role, so it is in the `privileged` rate-limit category and needs a
 * recent authentication (0.5.8). Accepting is a sign-in: the invitation's
 * link starts one (`GET /api/v1/auth/login?invitation=`).
 */
@ApiTags('Users')
@Controller('users/invitations')
export class InvitationsController {
  constructor(
    private readonly invite: InviteMemberUseCase,
    private readonly invitations: ManageInvitationsUseCase,
  ) {}

  @Post()
  @Permissions('user.invite')
  @RequiresRecentAuth()
  @RateLimit('privileged')
  @ApiOperation({
    summary:
      "Invite a person to the tenant with a role, never one above the inviter's own",
  })
  @Returns(InvitationResponse, { status: 201 })
  @Raises('CONFLICT')
  create(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Body({ schema: CreateInvitationBody }) body: CreateInvitationBody,
  ): Promise<ListedInvitation> {
    return this.invite.execute(ctx, body);
  }

  @Get()
  @Permissions('user.invite')
  @ApiOperation({
    summary:
      "The tenant's invitations, newest first: pending, accepted, expired and revoked",
  })
  @ReturnsPage(InvitationResponse)
  list(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Query({ schema: InvitationsQuery }) query: InvitationsQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Page<ListedInvitation>> {
    // It names people's addresses: no cache may keep it.
    response.setHeader('Cache-Control', 'no-store');
    return this.invitations.list(ctx, query);
  }

  @Delete(':id')
  @Permissions('user.invite')
  @ApiOperation({
    summary: 'Revoke an open invitation: its link no longer works',
  })
  @Returns(z.null())
  @Raises('INVALID_TRANSITION')
  async revoke(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ): Promise<null> {
    await this.invitations.revoke(ctx, id);
    return null;
  }
}
