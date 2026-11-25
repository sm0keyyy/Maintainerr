import { ServarrAction } from '@maintainerr/contracts';
import { TestBed } from '@suites/unit';
import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import {
  createCollection,
  createCollectionMedia,
  createMockLogger,
} from '../../../test/utils/data';
import { RadarrApi } from '../api/servarr-api/helpers/radarr.helper';
import { SonarrApi } from '../api/servarr-api/helpers/sonarr.helper';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { MaintainerrLogger } from '../logging/logs.service';
import { RadarrActionHandler } from './radarr-action-handler';
import { SonarrActionHandler } from './sonarr-action-handler';

class TestRadarr extends RadarrApi {
  transport() {
    return this.axios;
  }
}
class TestSonarr extends SonarrApi {
  transport() {
    return this.axios;
  }
}

for (const kind of ['radarr', 'sonarr'] as const) {
  describe(`${kind} approved-delete transport`, () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    it.each([
      { status: undefined, expected: 'uncertain' },
      { status: 500, expected: 'uncertain' },
      { status: 429, expected: 'uncertain' },
      { status: 400, expected: 'not-deleted' },
      { status: 204, expected: 'deleted' },
    ])(
      'sends one physical request for $status and records $expected',
      async ({ status, expected }) => {
        const { unit, unitRef } =
          kind === 'radarr'
            ? await TestBed.solitary(RadarrActionHandler).compile()
            : await TestBed.solitary(SonarrActionHandler).compile();
        const options = { url: 'http://arr.invalid/api/v3', apiKey: 'test' };
        const logger = createMockLogger() as unknown as MaintainerrLogger;
        const client =
          kind === 'radarr'
            ? new TestRadarr(options, logger)
            : new TestSonarr(options, logger);
        const attempts: InternalAxiosRequestConfig[] = [];
        client.transport().defaults.adapter = async (config) => {
          attempts.push(config);
          const response = {
            status,
            config,
            headers: { 'retry-after': '1' },
            data: '',
            statusText: '',
          } as AxiosResponse;
          if (status === 204) return response;
          throw new AxiosError(
            'failed',
            status === undefined ? 'ECONNRESET' : 'ERR_BAD_RESPONSE',
            config,
            undefined,
            status === undefined ? undefined : response,
          );
        };
        if (client instanceof TestRadarr)
          unitRef
            .get(ServarrService)
            .getRadarrApiClient.mockResolvedValue(client);
        else
          unitRef
            .get(ServarrService)
            .getSonarrApiClient.mockResolvedValue(client);
        const collection = createCollection({
          reviewRequired: true,
          arrAction: ServarrAction.DELETE,
          listExclusions: false,
          type: kind === 'radarr' ? 'movie' : 'show',
          radarrSettingsId: kind === 'radarr' ? 1 : null,
          sonarrSettingsId: kind === 'sonarr' ? 1 : null,
          sportarrSettingsId: null,
        });
        const recordOutcome = jest.fn().mockResolvedValue(undefined);
        const operation = unit.handleAction(
          collection,
          createCollectionMedia(collection),
          undefined,
          {
            target: {
              kind,
              id: 42,
              providerId: 99,
              settingsId: 1,
              path: '/media/title',
              addedAt: '2020-01-01',
            },
            beforeDelete: jest.fn().mockResolvedValue(undefined),
            ...{ recordOutcome },
          },
        );
        await jest.runAllTimersAsync();
        await operation;
        expect(attempts).toHaveLength(1);
        // Files go with the title; no import-list exclusion, so a later Seerr
        // request can bring it back.
        expect(attempts[0].method).toBe('delete');
        expect(attempts[0].url).toBe(
          kind === 'radarr'
            ? '/movie/42?deleteFiles=true&addImportExclusion=false'
            : '/series/42?deleteFiles=true&addImportListExclusion=false',
        );
        expect(attempts[0].httpRetry?.retries).toBe(0);
        expect(recordOutcome).toHaveBeenCalledWith(expected);
      },
    );
  });
}
