import { MediaServerType, ServarrAction } from '@maintainerr/contracts';
import { TestBed } from '@suites/unit';
import {
  createCollection,
  createCollectionMedia,
} from '../../../test/utils/data';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { MetadataService } from '../metadata/metadata.service';
import { SettingsDataService } from '../settings/settings-data.service';
import { RadarrActionHandler } from './radarr-action-handler';
import { SonarrActionHandler } from './sonarr-action-handler';
import { ReviewDeletion } from './review-deletion';

for (const kind of ['radarr', 'sonarr'] as const) {
  describe(`${kind} bound review deletion`, () => {
    it('uses only the approved canonical id and checks eligibility after preparatory awaits', async () => {
      const { unit, unitRef } =
        kind === 'radarr'
          ? await TestBed.solitary(RadarrActionHandler).compile()
          : await TestBed.solitary(SonarrActionHandler).compile();
      const collection = createCollection({
        type: kind === 'radarr' ? 'movie' : 'show',
        mediaServerType: MediaServerType.PLEX,
        reviewRequired: true,
        arrAction: ServarrAction.DELETE,
        listExclusions: true,
        radarrSettingsId: kind === 'radarr' ? 1 : null,
        sonarrSettingsId: kind === 'sonarr' ? 1 : null,
        sportarrSettingsId: null,
      });
      const media = createCollectionMedia(collection);
      let protectedNow = false;
      const prepare = jest.fn(async () => {
        protectedNow = true;
        return [];
      });
      const remove = jest.fn().mockResolvedValue(true);
      const api = {
        getDownloadIdsForMovie: prepare,
        getDownloadIdsForSeries: prepare,
        deleteMovie: remove,
        deleteShow: remove,
      };
      const servarr = unitRef.get(ServarrService);
      servarr.getRadarrApiClient.mockResolvedValue(
        api as unknown as Awaited<
          ReturnType<ServarrService['getRadarrApiClient']>
        >,
      );
      servarr.getSonarrApiClient.mockResolvedValue(
        api as unknown as Awaited<
          ReturnType<ServarrService['getSonarrApiClient']>
        >,
      );
      unitRef
        .get(SettingsDataService)
        .downloadClientConfigured.mockReturnValue(true);
      unitRef.get(MediaServerFactory).getService.mockResolvedValue(undefined);
      const approval: ReviewDeletion = {
        target: {
          kind,
          id: 42,
          providerId: 99,
          settingsId: 1,
          path: '/media/title',
          addedAt: '2020-01-01',
        },
        beforeDelete: jest.fn(async () => {
          if (protectedNow) throw new Error('Watched during preparation');
        }),
      };
      await expect(
        unit.handleAction(collection, media, undefined, approval),
      ).rejects.toThrow('Watched during preparation');
      expect(remove).not.toHaveBeenCalled();
      expect(
        unitRef.get(MetadataService).resolveLookupCandidatesForService,
      ).not.toHaveBeenCalled();
      approval.beforeDelete = jest.fn().mockResolvedValue(undefined);
      await expect(
        unit.handleAction(collection, media, undefined, approval),
      ).resolves.toBe(true);
      expect(remove).toHaveBeenCalledWith(42, true, true);
    });
  });
}
