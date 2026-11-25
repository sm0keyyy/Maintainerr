import { ReviewPendingItem } from '@maintainerr/contracts';
import {
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ReviewLeavingSoonService } from './review-leaving-soon.service';

/**
 * Approved review titles waiting in Plex "Leaving soon". The list shows
 * pending titles (all statuses with `all=true`); cancel pulls a pending title
 * back before its date.
 */
@Controller('api/review/leaving-soon')
export class ReviewLeavingSoonController {
  constructor(private readonly leavingSoon: ReviewLeavingSoonService) {}

  @Get()
  list(
    @Query('collectionId', new ParseIntPipe({ optional: true }))
    collectionId?: number,
    @Query('all', new ParseBoolPipe({ optional: true })) all?: boolean,
  ): Promise<ReviewPendingItem[]> {
    return this.leavingSoon.list({ collectionId, all });
  }

  @Post('/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number): Promise<ReviewPendingItem> {
    return this.leavingSoon.cancel(id);
  }
}
