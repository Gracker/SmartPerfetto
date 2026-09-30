// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_DOMAIN_MANIFEST,
  findSceneReconstructionRoute,
  getSceneDeepDiveRoute,
  getSceneReconstructionRoutes,
  type DomainManifest,
  type SceneRouteProfile,
} from '../domainManifest';

function resolveSceneReconstructionRoute(
  sceneType: string,
  manifest: DomainManifest,
  routeProfile: SceneRouteProfile = 'legacy',
) {
  return findSceneReconstructionRoute(sceneType, getSceneReconstructionRoutes(routeProfile, manifest));
}

describe('domainManifest', () => {
  it('keeps scene reconstruction routes in manifest and resolves startup scenes', () => {
    const routes = getSceneReconstructionRoutes(DEFAULT_DOMAIN_MANIFEST);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.every((route) => route.routeProfile === 'legacy')).toBe(true);

    const startupRoute = resolveSceneReconstructionRoute('cold_start', DEFAULT_DOMAIN_MANIFEST);
    expect(startupRoute?.directSkillId).toBe('startup_detail');

    const nonStartupRoute = resolveSceneReconstructionRoute('tap', DEFAULT_DOMAIN_MANIFEST);
    expect(nonStartupRoute?.directSkillId).toBe('scrolling_analysis');
  });

  it('default manifest no longer wildcard-routes unknown scene types (commit f5942f28)', () => {
    // The default manifest deliberately whitelists scroll/interaction groups
    // instead of using sceneTypeGroups: ['all'] — wildcards used to mis-route
    // idle/screen_on/scroll_start through scrolling_analysis, none of which
    // have a meaningful Stage 2 path.
    const route = resolveSceneReconstructionRoute('memory_pressure_spike', DEFAULT_DOMAIN_MANIFEST);
    expect(route).toBeNull();
  });

  it('still treats all-group route as wildcard when manifest opts in', () => {
    const customManifest = {
      ...DEFAULT_DOMAIN_MANIFEST,
      sceneReconstructionRoutes: [
        {
          id: 'wildcard_route',
          routeProfile: 'legacy',
          sceneTypeGroups: ['all'] as const,
          agentId: 'frame_agent',
          domain: 'scroll',
          directSkillId: 'scrolling_analysis',
          descriptionTemplate: 'fallback',
          paramMapping: {},
        } as any,
      ],
    };
    const route = resolveSceneReconstructionRoute('memory_pressure_spike', customManifest);
    expect(route?.directSkillId).toBe('scrolling_analysis');
  });

  it('exposes smart scene reconstruction routes only through smart profile', () => {
    const legacyRoutes = getSceneReconstructionRoutes('legacy', DEFAULT_DOMAIN_MANIFEST);
    const smartRoutes = getSceneReconstructionRoutes('smart', DEFAULT_DOMAIN_MANIFEST);

    expect(legacyRoutes.some((route) => route.id.startsWith('smart_'))).toBe(false);
    expect(smartRoutes.map((route) => route.directSkillId)).toEqual(expect.arrayContaining([
      'startup_detail',
      'scrolling_analysis',
      'click_response_analysis',
      'navigation_analysis',
      'anr_analysis',
      'device_state_snapshot',
    ]));
    expect(smartRoutes.every((route) => route.routeProfile === 'smart')).toBe(true);
  });

  it('does not leak smart device state route into legacy profile', () => {
    expect(resolveSceneReconstructionRoute('screen_on', DEFAULT_DOMAIN_MANIFEST)).toBeNull();
    const route = resolveSceneReconstructionRoute('screen_on', DEFAULT_DOMAIN_MANIFEST, 'smart');
    expect(route?.directSkillId).toBe('device_state_snapshot');
  });

  it('does not route zero-duration scroll_start markers to scrolling deep dives', () => {
    const smartScrollRoute = resolveSceneReconstructionRoute('scroll', DEFAULT_DOMAIN_MANIFEST, 'smart');
    const smartScrollStartRoute = resolveSceneReconstructionRoute('scroll_start', DEFAULT_DOMAIN_MANIFEST, 'smart');

    expect(smartScrollRoute?.directSkillId).toBe('scrolling_analysis');
    expect(smartScrollStartRoute).toBeNull();
    expect(getSceneDeepDiveRoute('scroll_start')).toBeNull();
  });
});
