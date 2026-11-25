import type {
  ReviewPendingStatus,
  ReviewSeerrOutcome,
} from '@maintainerr/contracts';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import { Collection } from './collection.entities';

/**
 * A title the operator approved on the review page. It sits in the Plex
 * "Leaving soon" collection until `deleteAt`; a watch by anyone saves it, a
 * cancel pulls it back, and only a row still `pending` at `deleteAt` is sent to
 * the arr delete. Deleting the review collection drops its rows, so nothing
 * approved under it can be deleted afterwards.
 */
@Entity()
@Index('idx_review_pending_status_delete_at', ['status', 'deleteAt'])
// approve() refuses a title with an active row while it holds the rules and
// collections lock; TypeORM drops a partial-index WHERE on SQLite.
@Index('idx_review_pending_collection_media', ['collectionId', 'mediaServerId'])
export class ReviewPending {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  collectionId: number;

  @ManyToOne(() => Collection, { onDelete: 'CASCADE' })
  collection: Relation<Collection>;

  @Column()
  mediaServerId: string;

  @Column()
  title: string;

  @Column({ type: 'integer', nullable: true })
  year: number | null;

  @Column({ type: 'varchar' })
  arrService: 'radarr' | 'sonarr';

  @Column()
  arrSettingsId: number;

  @Column()
  arrId: number;

  /** TMDB id for movies, TVDB id for shows, as bound at approval. */
  @Column()
  providerId: number;

  @Column()
  path: string;

  /** The arr's added date bound at approval; the delete re-reads it. */
  @Column()
  addedAt: string;

  @Column({ type: 'bigint' })
  sizeBytes: number;

  @Column('simple-json')
  plexIds: string[];

  /** Plex library section and its "Leaving soon" collection. */
  @Column()
  libraryId: string;

  @Column()
  plexCollectionId: string;

  @Column({ type: 'datetime' })
  approvedAt: Date;

  @Column({ type: 'datetime' })
  deleteAt: Date;

  @Column({ type: 'varchar', default: 'pending' })
  status: ReviewPendingStatus;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;

  @Column({ type: 'varchar', nullable: true })
  seerr: ReviewSeerrOutcome | null;
}
