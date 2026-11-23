import { Module } from '@nestjs/common';
import { PlexApiService } from './plex-api.service';
import { PlexStoredWatchService } from './plex-stored-watch.service';

/**
 * PlexApiModule
 *
 * Provides the PlexApiService for internal use by other modules.
 * Reads settings via the @Global SettingsDataService, so it does not import
 * SettingsModule.
 */
@Module({
  controllers: [],
  providers: [PlexApiService, PlexStoredWatchService],
  exports: [PlexApiService, PlexStoredWatchService],
})
export class PlexApiModule {}
